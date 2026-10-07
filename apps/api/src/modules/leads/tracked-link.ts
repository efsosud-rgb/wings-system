import { type LeadLinkChannel } from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leadTrackingLinks } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { trackingLinkByCode, upsertLead } from './service.js';

/**
 * A first WhatsApp message that starts with a tracking code (the wa.me link
 * of a client and channel) makes or merges the lead. One rule for both doors:
 * the Z-API session of the commercial number today, and the official Cloud
 * API after the number moves (docs/whatsapp/cloud-api.md). Null when the code
 * is not one of ours.
 */
export async function leadFromTrackedMessage(
  db: Database,
  message: {
    code: string;
    /** Normalised, 55 + DDD + number. */
    phone: string;
    text: string | null;
    senderName: string | null;
    senderPhoto?: string | null;
    at: Date | null;
    ip?: string | null;
    /** Which door the message came in by, for the audit entry. */
    via: 'zapi' | 'cloud_api';
  },
) {
  const link = await trackingLinkByCode(db, message.code);
  if (!link) return null;
  const at = message.at ?? new Date();
  const result = await upsertLead(db, {
    source: 'whatsapp_link',
    name: message.senderName,
    phone: message.phone,
    clientId: link.clientId,
    clientMapped: true,
    channel: link.channel as LeadLinkChannel,
    trackingLinkId: link.id,
    firstMessage: message.text,
    whatsappProfileName: message.senderName,
    whatsappPhotoUrl: message.senderPhoto ?? null,
    // The person wrote first, asking about the franchise: LGPD art. 7º, V.
    legalBasis: 'pre_contract',
    consentedAt: at,
    enteredAt: message.at,
    enteredAtSource: 'whatsapp_message',
    consentSource: `whatsapp:${link.channel}:${link.code}`,
    consentText:
      'A pessoa iniciou a conversa no WhatsApp da Wings pelo link rastreável, pedindo informações.',
    event: {
      kind: 'lead.received.whatsapp',
      detail: { trackingLinkId: link.id, channel: link.channel, code: link.code },
    },
  });
  await db
    .update(leadTrackingLinks)
    .set({ hits: sql`${leadTrackingLinks.hits} + 1`, lastHitAt: at })
    .where(eq(leadTrackingLinks.id, link.id));
  await writeAudit(db, {
    action: result.created ? 'lead.received' : 'lead.merged',
    entity: 'lead',
    entityId: result.lead.id,
    ip: message.ip ?? null,
    metadata: {
      source: 'whatsapp_link',
      channel: link.channel,
      trackingLinkId: link.id,
      via: message.via,
    },
  });
  return { lead: result.lead, created: result.created, channel: link.channel };
}
