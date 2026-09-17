/**
 * Z-API (WhatsApp) client.
 *
 * Used to alert people that a decision is waiting. WhatsApp **notifies**; it
 * never decides: approving still happens inside Wings System behind a login,
 * because a WhatsApp sender cannot be authenticated well enough to move money.
 */

export interface ZapiConfig {
  instanceId: string;
  instanceToken: string;
  clientToken: string;
  /** Override for tests; defaults to Z-API's public gateway. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ZapiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ZapiError';
    this.status = status;
  }
}

/**
 * Normalises a Brazilian number to the digits Z-API expects (55 + DDD + number).
 * Returns null for anything that is not a usable number, including the
 * placeholder values a bootstrap record may carry.
 */
export function normalizeBrazilianPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return null;
  // 00000000000 and friends are placeholders, not phone numbers.
  if (/^(\d)\1+$/.test(digits)) return null;

  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) return digits;
  return null;
}

export class ZapiClient {
  private readonly config: Required<Omit<ZapiConfig, 'fetchImpl'>> & { fetchImpl: typeof fetch };

  constructor(config: ZapiConfig) {
    if (!config.instanceId || !config.instanceToken || !config.clientToken) {
      throw new Error('Z-API requires instanceId, instanceToken and clientToken');
    }
    this.config = {
      instanceId: config.instanceId,
      instanceToken: config.instanceToken,
      clientToken: config.clientToken,
      baseUrl: config.baseUrl ?? 'https://api.z-api.io',
      timeoutMs: config.timeoutMs ?? 15_000,
      fetchImpl: config.fetchImpl ?? fetch,
    };
  }

  async sendText(phone: string, message: string): Promise<{ messageId?: string }> {
    const normalized = normalizeBrazilianPhone(phone);
    if (!normalized) throw new Error(`invalid phone number: ${phone}`);

    // Instance id and token sit in the path — Z-API's design, not ours — so the
    // URL itself is a secret and must never be logged.
    const url = `${this.config.baseUrl}/instances/${this.config.instanceId}/token/${this.config.instanceToken}/send-text`;

    const response = await this.config.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': this.config.clientToken,
      },
      body: JSON.stringify({ phone: normalized, message }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    const text = await response.text();
    if (!response.ok) {
      // The body may echo the request; keep it short and free of the URL.
      throw new ZapiError(response.status, `Z-API rejected the message (${response.status})`);
    }

    try {
      const body = JSON.parse(text) as { messageId?: string; zaapId?: string };
      return { messageId: body.messageId ?? body.zaapId };
    } catch {
      return {};
    }
  }
}
