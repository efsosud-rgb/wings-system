import type { Env } from '../../env.js';

/**
 * The WhatsApp Cloud API over plain HTTP (no client library): send a message,
 * list the account's templates, read a received file. The token travels in
 * the Authorization header only, never in a URL, a log or an answer. A send
 * is made once and never retried here, whatever Meta answers: a template
 * costs money and a retried text reaches the person twice.
 */

export const WHATSAPP_GRAPH_VERSION = 'v23.0';
const GRAPH = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}`;
const TIMEOUT_MS = 15_000;

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  wabaId: string | null;
}

/** The chat is on once the token and the number are set. */
export function whatsappConfigOf(env: Env): WhatsAppConfig | null {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) return null;
  return {
    token: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    wabaId: env.WHATSAPP_WABA_ID ?? null,
  };
}

export type GraphFailure = {
  ok: false;
  /** Meta's error code, or null when Meta never answered. */
  code: number | null;
  title: string | null;
  /** True when the request may have reached Meta and its outcome is unknown. */
  unknown: boolean;
};
export type GraphResult<T> = { ok: true; data: T } | GraphFailure;

type Fetch = typeof fetch;

async function graph<T>(
  fetchImpl: Fetch,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<GraphResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(`${GRAPH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Timed out or cut: a POST may have been delivered all the same.
    return { ok: false, code: null, title: null, unknown: method === 'POST' };
  }
  const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = (parsed?.error ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      code: typeof error.code === 'number' ? error.code : null,
      title:
        typeof error.error_user_title === 'string'
          ? error.error_user_title.slice(0, 200)
          : typeof error.type === 'string'
            ? error.type.slice(0, 200)
            : null,
      unknown: response.status >= 500 && method === 'POST',
    };
  }
  return { ok: true, data: (parsed ?? {}) as T };
}

// --- sending ---------------------------------------------------------------------------

export type OutgoingPayload =
  | { type: 'text'; text: { body: string; preview_url: boolean } }
  | {
      type: 'template';
      template: {
        name: string;
        language: { code: string };
        components?: { type: 'body'; parameters: { type: 'text'; text: string }[] }[];
      };
    };

export const textPayload = (body: string): OutgoingPayload => ({
  type: 'text',
  text: { body, preview_url: false },
});

export const templatePayload = (
  name: string,
  language: string,
  params: string[],
): OutgoingPayload => ({
  type: 'template',
  template: {
    name,
    language: { code: language },
    ...(params.length > 0
      ? {
          components: [
            { type: 'body', parameters: params.map((text) => ({ type: 'text', text })) },
          ],
        }
      : {}),
  },
});

/** POST /{phone-number-id}/messages, once. */
export async function sendWhatsAppMessage(
  fetchImpl: Fetch,
  config: WhatsAppConfig,
  to: string,
  payload: OutgoingPayload,
): Promise<GraphResult<{ wamid: string; waId: string | null }>> {
  const result = await graph<{ messages?: { id?: string }[]; contacts?: { wa_id?: string }[] }>(
    fetchImpl,
    config.token,
    'POST',
    `/${config.phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
  );
  if (!result.ok) return result;
  const wamid = result.data.messages?.[0]?.id;
  // Accepted without an id: we cannot follow it, and it may have gone.
  if (!wamid) return { ok: false, code: null, title: 'no_message_id', unknown: true };
  return { ok: true, data: { wamid, waId: result.data.contacts?.[0]?.wa_id ?? null } };
}

// --- templates --------------------------------------------------------------------------

export interface GraphTemplate {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  components?: unknown[];
}

/** GET /{waba-id}/message_templates, following Meta's pages (at most 10). */
export async function listWhatsAppTemplates(
  fetchImpl: Fetch,
  config: WhatsAppConfig & { wabaId: string },
): Promise<GraphResult<GraphTemplate[]>> {
  const out: GraphTemplate[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({
      fields: 'id,name,language,status,category,components',
      limit: '100',
    });
    if (after) query.set('after', after);
    const result = await graph<{
      data?: GraphTemplate[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(fetchImpl, config.token, 'GET', `/${config.wabaId}/message_templates?${query}`);
    if (!result.ok) return result;
    out.push(...(result.data.data ?? []));
    after = result.data.paging?.next ? (result.data.paging.cursors?.after ?? null) : null;
    if (!after) break;
  }
  return { ok: true, data: out };
}

// --- received files ---------------------------------------------------------------------

const MEDIA_HOSTS = ['fbsbx.com', 'fbcdn.net', 'facebook.com', 'whatsapp.net'];

function metaMediaHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      MEDIA_HOSTS.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}

/** Meta's largest file (documents, 100 MB). */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

/**
 * A received file: GET /{media-id} gives a short-lived signed URL, which is
 * read with the same token. Nothing is stored; the browser gets the bytes.
 */
export async function downloadWhatsAppMedia(
  fetchImpl: Fetch,
  config: WhatsAppConfig,
  mediaId: string,
): Promise<GraphResult<{ bytes: Buffer; mimeType: string | null }>> {
  const info = await graph<{ url?: string; mime_type?: string; file_size?: number }>(
    fetchImpl,
    config.token,
    'GET',
    `/${encodeURIComponent(mediaId)}`,
  );
  if (!info.ok) return info;
  const url = info.data.url;
  // The token goes only to Meta's own hosts (lookaside.fbsbx.com today).
  if (!url || !metaMediaHost(url))
    return { ok: false, code: null, title: 'bad_media_url', unknown: false };
  if ((info.data.file_size ?? 0) > MAX_MEDIA_BYTES)
    return { ok: false, code: null, title: 'too_large', unknown: false };
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return { ok: false, code: null, title: 'media_unavailable', unknown: false };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES)
      return { ok: false, code: null, title: 'too_large', unknown: false };
    return { ok: true, data: { bytes, mimeType: info.data.mime_type ?? null } };
  } catch {
    return { ok: false, code: null, title: 'media_unavailable', unknown: false };
  }
}

// --- errors in plain Portuguese -----------------------------------------------------------

const ERRORS: Record<number, string> = {
  131047: 'Fora das 24 horas: só um modelo aprovado pode ir agora.',
  131026: 'Não entregue: o número pode não ter WhatsApp ou não aceitar mensagens da empresa.',
  131049:
    'A Meta segurou a mensagem para não cansar a pessoa com mensagens de empresa. Tente outro dia.',
  131050: 'A pessoa pediu para não receber mensagens de marketing.',
  131051: 'Tipo de mensagem que o WhatsApp não aceita.',
  131052: 'A Meta não conseguiu baixar o arquivo.',
  131053: 'A Meta não conseguiu enviar o arquivo.',
  131056: 'Muitas mensagens para esta pessoa em pouco tempo. Espere um pouco.',
  130429: 'Limite de envio da Meta atingido. Espere um pouco.',
  131048: 'A Meta limitou o envio por denúncias de spam.',
  131031: 'A conta do WhatsApp da empresa está bloqueada ou restrita.',
  131042: 'Problema de pagamento na conta do WhatsApp (forma de pagamento).',
  131045: 'O número da empresa não está registrado corretamente na Meta.',
  133010: 'O número da empresa não está registrado na API.',
  132000: 'O número de campos do modelo não confere.',
  132001: 'O modelo não existe nesse idioma ou ainda não foi aprovado.',
  132005: 'O texto do modelo ficou longo demais com os campos preenchidos.',
  132007: 'O modelo fere uma regra da Meta.',
  132012: 'Os campos do modelo estão no formato errado.',
  132015: 'O modelo está pausado pela Meta (qualidade baixa).',
  132016: 'O modelo foi desativado pela Meta.',
  190: 'O token do WhatsApp venceu ou foi revogado. Avise o Eric.',
  10: 'O token do WhatsApp não tem permissão para isso. Avise o Eric.',
  200: 'O token do WhatsApp não tem permissão para isso. Avise o Eric.',
  100: 'A Meta recusou um campo do pedido.',
  368: 'A conta foi bloqueada temporariamente por política da Meta.',
  131000: 'A Meta teve um erro ao enviar. Tente de novo mais tarde.',
};

export const UNKNOWN_OUTCOME = 'unknown_outcome';

export function errorText(code: number | null, title: string | null): string | null {
  if (title === UNKNOWN_OUTCOME)
    return 'Sem resposta da Meta: pode ter ido ou não. Confira antes de mandar de novo.';
  if (code === null && title === null) return null;
  if (code !== null && ERRORS[code]) return ERRORS[code];
  return code !== null ? `A Meta recusou (código ${code}).` : 'A Meta recusou a mensagem.';
}
