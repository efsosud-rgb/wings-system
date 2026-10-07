import {
  WINGS_CLIENT_ID,
  type LeadChannel,
  type LeadPipeline,
  type SofiaFieldTarget,
  type SofiaSegment,
  type SofiaSettings,
} from '@wings/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clients, employees, leads, waMessages } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { announceLeadArrival } from '../leads/crm-alerts.js';
import { changeLead, ensureFirstContactTask, nextInRotation } from '../leads/crm.js';
import { upsertLead, type LeadAttribution } from '../leads/service.js';
import type { Contact } from '../whatsapp/outbox.js';
import type { ConversationRow, SofiaFacts } from './state.js';

/**
 * The deal Sofia hands over (docs/whatsapp/sofia.md), by the same entry rule
 * as every other source (`upsertLead`): a phone that already has a lead
 * merges into it. Formatação goes to the funnel's rotation (Daniele/Luana),
 * Expansão with the brand to its rotation (Fernando). A closed deal of the
 * same phone is reopened rather than duplicated; an open one without owner
 * gets its owner from the rotation. The answers go to "Dados do formulário"
 * and, where the question says so, to the deal's own fields.
 */

export interface SofiaDeal {
  leadId: string;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  created: boolean;
}

const SKIPPED = /^n[aã]o tem$/i;

export async function sofiaHandOver(
  db: Database,
  input: {
    conversation: ConversationRow;
    contact: Contact;
    facts: SofiaFacts;
    segment: Exclude<SofiaSegment, 'outro'>;
    brandClientId: string | null;
    settings: SofiaSettings;
    now: Date;
  },
): Promise<SofiaDeal> {
  const { conversation, contact, facts, segment, now } = input;
  const pipeline: LeadPipeline = segment === 'expansao' ? 'expansao' : 'formatacao';
  const questions = segment === 'expansao' ? input.settings.expansao : input.settings.formatacao;
  const field = (target: SofiaFieldTarget) => {
    const question = questions.find((q) => q.field === target);
    const answer = question ? facts.answers[question.key]?.trim() : undefined;
    return answer && !SKIPPED.test(answer) ? answer : null;
  };
  const formAnswers: Record<string, string> = {};
  for (const question of questions) {
    const answer = facts.answers[question.key];
    if (answer) formAnswers[question.label] = answer;
  }
  if (facts.brandText) formAnswers['Marca citada'] = facts.brandText;

  const brand =
    segment === 'expansao' && input.brandClientId
      ? await db.query.clients.findFirst({
          where: eq(clients.id, input.brandClientId),
          columns: { id: true, name: true },
        })
      : undefined;
  const [first] = await db
    .select({ text: waMessages.text })
    .from(waMessages)
    .where(and(eq(waMessages.conversationId, conversation.id), eq(waMessages.direction, 'in')))
    .orderBy(asc(waMessages.createdAt))
    .limit(1);
  const referral = (conversation.referral ?? null) as {
    sourceType?: string | null;
    sourceId?: string | null;
  } | null;
  const attribution: LeadAttribution | null =
    referral?.sourceType === 'ad' && referral.sourceId
      ? { adPlatform: 'meta', adExternalId: referral.sourceId, utmSource: 'whatsapp' }
      : null;
  const companyName = field('companyName');

  // The conversation's own deal is completed when it is open and fits: no
  // owner yet (or one the seller gave back to Sofia), the same funnel, and for
  // a brand the same brand (or none yet). Anything else — a closed deal, a
  // won sale, another brand — is never touched: a new deal is made.
  const own = conversation.leadId
    ? await db.query.leads.findFirst({ where: eq(leads.id, conversation.leadId) })
    : undefined;
  const fits =
    own &&
    own.won === null &&
    (own.pipeline === null || own.pipeline === pipeline) &&
    (!brand ||
      own.clientId === brand.id ||
      (own.clientId === WINGS_CLIENT_ID && !own.ownerEmployeeId));
  const result = fits
    ? { lead: own, created: false }
    : await upsertLead(db, {
        // Never merged into another deal of the phone (all of them are closed,
        // or the open one does not fit): a deal of its own.
        forceNew: true,
        source: facts.trackingLinkId ? 'whatsapp_link' : 'whatsapp',
        name: field('name') ?? contact.profileName,
        phone: contact.phone,
        clientId: brand?.id ?? WINGS_CLIENT_ID,
        clientMapped: true,
        channel: (facts.channel as LeadChannel | null) ?? null,
        trackingLinkId: facts.trackingLinkId ?? null,
        firstMessage: first?.text ?? null,
        whatsappProfileName: contact.profileName,
        city: field('city'),
        formAnswers,
        fields: {
          ...(field('name') ? { name: field('name')! } : {}),
          ...(companyName ? { companyName } : {}),
          ...(field('instagram') ? { instagram: field('instagram')! } : {}),
          ...(field('website') ? { website: field('website')! } : {}),
        },
        company: companyName ? { name: companyName, city: field('city') } : null,
        pipeline,
        brand: brand?.name ?? null,
        // The person wrote first, asking about it: LGPD art. 7º, V.
        legalBasis: 'pre_contract',
        consentedAt: conversation.createdAt,
        consentSource: `whatsapp:sofia:${segment}`,
        consentText:
          'A pessoa iniciou a conversa no WhatsApp da Wings e respondeu às perguntas da atendente virtual.',
        enteredAt: conversation.createdAt,
        enteredAtSource: 'whatsapp_message',
        attribution,
        event: {
          kind: 'lead.received.whatsapp',
          detail: {
            via: 'sofia',
            segment,
            conversationId: conversation.id,
            ...(facts.trackingLinkId ? { trackingLinkId: facts.trackingLinkId } : {}),
            ...(referral?.sourceId ? { adId: referral.sourceId } : {}),
          },
        },
      });

  let lead = result.lead!;
  if (!result.created) {
    // The conversation's open deal: its answers are filled in. One with an
    // owner (given back to Sofia) keeps its funnel, brand and owner; one
    // without gets this funnel, the brand when it had none, and the rotation.
    await db
      .update(leads)
      .set({
        formAnswers: sql`coalesce(${leads.formAnswers}, '{}'::jsonb) || ${JSON.stringify(formAnswers)}::jsonb`,
        ...(!lead.ownerEmployeeId && brand && lead.clientId !== brand.id
          ? { clientId: brand.id, clientMapped: true, brand: brand.name }
          : {}),
        updatedAt: now,
      })
      .where(eq(leads.id, lead.id));
    if (!lead.ownerEmployeeId) {
      const ownerId = await db.transaction((tx) => nextInRotation(tx, pipeline, now));
      const changed = await changeLead(db, {
        leadId: lead.id,
        ...(lead.pipeline !== pipeline ? { pipeline } : {}),
        ...(ownerId ? { ownerEmployeeId: ownerId } : {}),
        source: 'sofia',
        actorEmployeeId: null,
      });
      if (changed.ok) lead = changed.lead;
    }
    await ensureFirstContactTask(db, lead, null, now);
  }
  // Sofia's leads are an arrival like a form: the owner hears of it (or
  // Diretoria, when the rotation is empty).
  await announceLeadArrival(db, { id: lead.id, ownerEmployeeId: lead.ownerEmployeeId });
  await writeAudit(db, {
    action: result.created ? 'lead.received' : 'lead.merged',
    entity: 'lead',
    entityId: lead.id,
    metadata: { source: 'whatsapp', via: 'sofia', segment, conversationId: conversation.id },
  });

  const ownerName = lead.ownerEmployeeId
    ? ((
        await db.query.employees.findFirst({
          where: eq(employees.id, lead.ownerEmployeeId),
          columns: { fullName: true },
        })
      )?.fullName ?? null)
    : null;
  return {
    leadId: lead.id,
    ownerEmployeeId: lead.ownerEmployeeId,
    ownerName,
    created: result.created,
  };
}
