import type { WaMessageKind, WaMessageStatus } from '@wings/shared';

/**
 * Reading Meta's WhatsApp webhook (object `whatsapp_business_account`),
 * leniently: one change per number and field. Pure functions, so the format
 * can be tested without a server. The shapes follow Meta's published
 * reference; NOT verified live yet — the API logs each body's shape
 * (`shapeOf`), never its values, so the first real call can be checked.
 */

export interface WaInboundMessage {
  wamid: string;
  /** The person's wa_id (digits). */
  from: string;
  profileName: string | null;
  at: Date | null;
  kind: WaMessageKind;
  text: string | null;
  /** Everything but the text; see `wa_messages.content`. */
  content: Record<string, unknown>;
  /** The click-to-WhatsApp ad, when the message came from one. */
  referral: Record<string, unknown> | null;
}

export interface WaStatusUpdate {
  wamid: string;
  status: WaMessageStatus | null;
  at: Date | null;
  errorCode: number | null;
  errorTitle: string | null;
}

export interface WaTemplateUpdate {
  metaId: string | null;
  name: string;
  language: string | null;
  status: string;
}

export interface WaChange {
  field: string;
  phoneNumberId: string | null;
  messages: WaInboundMessage[];
  statuses: WaStatusUpdate[];
  templates: WaTemplateUpdate[];
  /** `calls` changes are kept as they came, for the calling part. */
  calls: unknown[];
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const unixAt = (value: unknown): Date | null => {
  const seconds = typeof value === 'string' ? Number(value) : num(value);
  return seconds && Number.isFinite(seconds) ? new Date(seconds * 1000) : null;
};

const STATUSES: Record<string, WaMessageStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  played: 'played',
  failed: 'failed',
};

const MEDIA = ['image', 'audio', 'video', 'document', 'sticker'] as const;

function messageOf(raw: Obj, names: Map<string, string>): WaInboundMessage | null {
  const wamid = str(raw.id);
  const from = str(raw.from);
  if (!wamid || !from) return null;
  const type = str(raw.type) ?? 'unsupported';
  const content: Obj = {};
  const context = obj(raw.context);
  if (str(context.id)) content.replyTo = context.id;
  let kind: WaMessageKind = 'unsupported';
  let text: string | null = null;

  if (type === 'text') {
    kind = 'text';
    text = str(obj(raw.text).body);
  } else if ((MEDIA as readonly string[]).includes(type)) {
    kind = type as WaMessageKind;
    const media = obj(raw[type]);
    text = str(media.caption);
    content.media = {
      id: str(media.id),
      mimeType: str(media.mime_type),
      filename: str(media.filename),
      voice: media.voice === true || undefined,
    };
  } else if (type === 'location') {
    kind = 'location';
    const place = obj(raw.location);
    text = str(place.name) ?? str(place.address);
    content.location = {
      latitude: num(place.latitude),
      longitude: num(place.longitude),
      name: str(place.name),
      address: str(place.address),
    };
  } else if (type === 'contacts') {
    kind = 'contacts';
    const first = obj(arr(raw.contacts)[0]);
    text = str(obj(first.name).formatted_name);
    content.contacts = arr(raw.contacts).length;
  } else if (type === 'interactive') {
    kind = 'interactive';
    const interactive = obj(raw.interactive);
    const subtype = str(interactive.type);
    const reply = obj(interactive[subtype ?? '']);
    text = str(reply.title) ?? str(obj(interactive.nfm_reply).body);
    content.interactive = { type: subtype, id: str(reply.id) };
    if (subtype === 'call_permission_reply') {
      content.callPermission = {
        response: str(reply.response),
        isPermanent: reply.is_permanent === true,
        expiresAt: unixAt(reply.expiration_timestamp)?.toISOString() ?? null,
        source: str(reply.response_source),
      };
      text = reply.response === 'accept' ? 'Permitiu ligações' : 'Recusou ligações';
    }
  } else if (type === 'button') {
    kind = 'button';
    const button = obj(raw.button);
    text = str(button.text);
    content.payload = str(button.payload);
  } else if (type === 'reaction') {
    kind = 'reaction';
    const reaction = obj(raw.reaction);
    text = str(reaction.emoji);
    content.reactionTo = str(reaction.message_id);
  } else {
    content.type = type;
    const error = obj(arr(raw.errors)[0]);
    if (num(error.code) !== null) content.errorCode = num(error.code);
  }

  const referral = obj(raw.referral);
  return {
    wamid,
    from,
    profileName: names.get(from) ?? null,
    at: unixAt(raw.timestamp),
    kind,
    text,
    content,
    referral:
      Object.keys(referral).length > 0
        ? {
            sourceType: str(referral.source_type),
            sourceId: str(referral.source_id),
            sourceUrl: str(referral.source_url),
            headline: str(referral.headline),
            ctwaClid: str(referral.ctwa_clid),
          }
        : null,
  };
}

function statusOf(raw: Obj): WaStatusUpdate | null {
  const wamid = str(raw.id);
  if (!wamid) return null;
  const error = obj(arr(raw.errors)[0]);
  return {
    wamid,
    status: STATUSES[str(raw.status) ?? ''] ?? null,
    at: unixAt(raw.timestamp),
    errorCode: num(error.code),
    errorTitle: str(error.title)?.slice(0, 200) ?? null,
  };
}

/** Every change in one webhook body. An unknown body gives none. */
export function whatsappChangesOf(body: unknown): WaChange[] {
  const root = obj(body);
  if (root.object !== 'whatsapp_business_account') return [];
  const out: WaChange[] = [];
  for (const entry of arr(root.entry)) {
    for (const change of arr(obj(entry).changes)) {
      const field = str(obj(change).field) ?? 'unknown';
      const value = obj(obj(change).value);
      const names = new Map<string, string>();
      for (const contact of arr(value.contacts)) {
        const id = str(obj(contact).wa_id);
        const name = str(obj(obj(contact).profile).name);
        if (id && name) names.set(id, name);
      }
      const parsed: WaChange = {
        field,
        phoneNumberId: str(obj(value.metadata).phone_number_id),
        messages: [],
        statuses: [],
        templates: [],
        calls: [],
      };
      if (field === 'messages') {
        for (const message of arr(value.messages)) {
          const read = messageOf(obj(message), names);
          if (read) parsed.messages.push(read);
        }
        for (const status of arr(value.statuses)) {
          const read = statusOf(obj(status));
          if (read) parsed.statuses.push(read);
        }
      } else if (field === 'message_template_status_update') {
        const name = str(value.message_template_name);
        const event = str(value.event);
        if (name && event)
          parsed.templates.push({
            metaId:
              value.message_template_id === undefined ? null : String(value.message_template_id),
            name,
            language: str(value.message_template_language),
            status: event,
          });
      } else if (field === 'calls') {
        parsed.calls.push(...arr(value.calls));
      }
      out.push(parsed);
    }
  }
  return out;
}

/** Words that, alone in a message, ask the business to stop writing. */
const OPT_OUT = /^\s*(sair|parar|pare|stop|cancelar|descadastrar)\s*[.!]?\s*$/i;
export const isOptOut = (text: string | null) => text !== null && OPT_OUT.test(text);
