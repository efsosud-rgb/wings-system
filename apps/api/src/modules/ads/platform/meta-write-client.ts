import { MetaApiError, MetaReadOnlyClient, type MetaClientOptions } from './meta-client.js';
import type { Cents } from './money.js';
import type { MutationOutcome } from './types.js';

/**
 * Meta client that can actually change things.
 *
 * Writing is opt-in twice over: this class must be chosen deliberately *and*
 * constructed with `confirmWrites: true`. The read-only client remains the
 * default everywhere else, so no code path acquires the ability to spend money
 * by accident.
 *
 * Only the executor may use this class, and only for a change that a person
 * has approved.
 */

export interface MetaWriteClientOptions extends MetaClientOptions {
  /** Must be true. Exists so enabling writes is a visible, deliberate act. */
  confirmWrites: true;
}

export class MetaWriteClient extends MetaReadOnlyClient {
  private readonly writeToken: string;
  private readonly writeVersion: string;
  private readonly writeTimeoutMs: number;
  private readonly writeFetch: typeof fetch;

  constructor(options: MetaWriteClientOptions) {
    super(options);
    if (options.confirmWrites !== true) {
      throw new Error('MetaWriteClient requires confirmWrites: true');
    }
    this.writeToken = options.accessToken;
    this.writeVersion = options.apiVersion ?? 'v23.0';
    this.writeTimeoutMs = options.timeoutMs ?? 20_000;
    this.writeFetch = options.fetchImpl ?? fetch;
  }

  /**
   * POSTs to the Graph API.
   *
   * A timeout or transport failure returns `unknown`, never a throw: the change
   * may well have been applied, so the caller must reconcile rather than retry.
   */
  private async post(
    path: string,
    params: Record<string, string>,
  ): Promise<MutationOutcome | null> {
    const url = `https://graph.facebook.com/${this.writeVersion}/${path}`;
    const body = new URLSearchParams(params);

    let response: Response;
    try {
      response = await this.writeFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.writeToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.writeTimeoutMs),
      });
    } catch (error) {
      return {
        status: 'unknown',
        reason: `transport failure: ${error instanceof Error ? error.name : 'unknown'}`,
      };
    }

    const text = await response.text();
    if (!response.ok) {
      let parsed: { error?: { message?: string; code?: number } } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        // Non-JSON error body; fall through with the status code.
      }
      const code = parsed.error?.code ?? response.status;
      // 5xx means the request may or may not have taken effect.
      if (response.status >= 500) {
        return { status: 'unknown', reason: `platform error ${response.status}` };
      }
      return {
        status: 'rejected',
        code: String(code),
        message: parsed.error?.message ?? `Meta rejected the change (${response.status})`,
      };
    }

    return null; // success; the caller re-reads the entity
  }

  override async setDailyBudget(
    campaignId: string,
    dailyBudgetCents: Cents,
  ): Promise<MutationOutcome> {
    // Budgets are integer cents in Meta's API — verified in the Stage 1 spike.
    const failure = await this.post(campaignId, { daily_budget: String(dailyBudgetCents) });
    if (failure) return failure;

    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return { status: 'unknown', reason: 'campaign unreadable after the change' };
    return { status: 'applied', campaign };
  }

  override async pauseCampaign(campaignId: string): Promise<MutationOutcome> {
    const failure = await this.post(campaignId, { status: 'PAUSED' });
    if (failure) return failure;
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return { status: 'unknown', reason: 'campaign unreadable after the change' };
    return { status: 'applied', campaign };
  }

  override async resumeCampaign(campaignId: string): Promise<MutationOutcome> {
    const failure = await this.post(campaignId, { status: 'ACTIVE' });
    if (failure) return failure;
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return { status: 'unknown', reason: 'campaign unreadable after the change' };
    return { status: 'applied', campaign };
  }

  override async setAccountSpendCap(
    capCents: Cents,
  ): Promise<{ status: 'applied' | 'rejected'; message?: string }> {
    const accountPath = this.accountPath();
    const failure = await this.post(accountPath, { spend_cap: String(capCents) });
    if (!failure) return { status: 'applied' };
    if (failure.status === 'rejected') return { status: 'rejected', message: failure.message };
    return { status: 'rejected', message: 'resultado desconhecido; verifique na plataforma' };
  }

  /** The account path, exposed by the base class for reuse here. */
  private accountPath(): string {
    return this.adAccountPath;
  }
}

export { MetaApiError };
