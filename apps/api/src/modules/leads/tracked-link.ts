import { type LeadLinkChannel, type LeadPipeline, WINGS_CLIENT_ID } from '@wings/shared';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clients, leadEvents, leadTrackingLinks, leads } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { announceLeadArrival, announceWhatsAppContact } from './crm-alerts.js';
import { brandOfLink, trackingLinkByCode, upsertLead } from './service.js';

/**
 * A first WhatsApp message that starts with a tracking code (the wa.me link
 * of a client and channel) makes or merges the lead. One rule for both doors:
 * the Z-API session of the commercial number today, and the official Cloud
 * API after the number moves (docs/whatsapp/cloud-api.md). Null when the code
 * is not one of ours.
 *
 * The deal is born as one from any other door: in the funnel the link's client
 * sells (a brand's link is Expansão for that brand; Wings' own is Formatação),
 * in its entry stage, with the owner the rotation gives, the first-contact task
 * and the arrival notice. With Sofia on, the WhatsApp door does not come here:
 * she makes the deal at the end of her questions.
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
  const client = await db.query.clients.findFirst({
    where: eq(clients.id, link.clientId),
    columns: { id: true, name: true },
  });
  const pipeline: LeadPipeline = link.clientId === WINGS_CLIENT_ID ? 'formatacao' : 'expansao';
  const result = await upsertLead(db, {
    source: 'whatsapp_link',
    name: message.senderName,
    phone: message.phone,
    clientId: link.clientId,
    clientMapped: true,
    pipeline,
    brand: client ? brandOfLink(client) : null,
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
  // `whatsapp_link` is not an arrival source of its own (Sofia announces hers
  // when she hands the deal over), so this door announces the deal it made.
  if (result.created && !result.stale) await announceLeadArrival(db, result.lead);
  return { lead: result.lead, created: result.created, channel: link.channel };
}

/**
 * A first message with `<code> <ref>` whose ref is the lead a site form made: the message belongs to
 * that lead, so no second lead is made. The Z-API door keeps no conversation of its own, so the
 * link is the timeline event and the owner's notice (the Cloud API door ties the conversation
 * itself, `whatsapp/intake.ts`). Null when the code is not one of ours or the lead is gone.
 */
export async function linkMessageToFormLead(
  db: Database,
  message: {
    code: string;
    leadId: string;
    at: Date | null;
    ip?: string | null;
    via: 'zapi' | 'cloud_api';
  },
) {
  const link = await trackingLinkByCode(db, message.code);
  if (!link) return null;
  const lead = await db.query.leads.findFirst({
    where: eq(leads.id, message.leadId),
    columns: { id: true, ownerEmployeeId: true },
  });
  if (!lead) return null;
  const at = message.at ?? new Date();
  await db
    .update(leadTrackingLinks)
    .set({ hits: sql`${leadTrackingLinks.hits} + 1`, lastHitAt: at })
    .where(eq(leadTrackingLinks.id, link.id));
  await db.insert(leadEvents).values({
    leadId: lead.id,
    kind: 'lead.whatsapp_linked',
    detail: { via: message.via, trackingLinkId: link.id },
  });
  await writeAudit(db, {
    action: 'lead.merged',
    entity: 'lead',
    entityId: lead.id,
    ip: message.ip ?? null,
    metadata: { source: 'whatsapp_link', channel: link.channel, via: message.via, byFormRef: true },
  });
  await announceWhatsAppContact(db, lead);
  return { lead, channel: link.channel };
}
