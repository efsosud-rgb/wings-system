import { instagramExcerpt, pipelineOfCategory, WINGS_CLIENT_ID } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  adAds,
  adCampaigns,
  adSets,
  crmNotifications,
  igPeople,
  leadEvents,
  prospectEvidence,
  prospectOpportunities,
} from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { contactBlock } from '../leads/contact-block.js';
import { managersAndBoard } from '../leads/crm-alerts.js';
import { dayOf } from '../prospecting/service.js';
import { upsertLead } from '../leads/service.js';

/**
 * Parte 1 into the CRM (docs/prospeccao/instagram.md §1.4 steps 3 and 5, §5.5, §5.6): a comment
 * of someone who is already a lead goes on that lead's timeline and its owner is told; a phone or
 * an e-mail the person wrote in the Direct, answering the private reply, makes the lead. Origin
 * `instagram_ad` when the comment was on an ad (with the ad's id), else `instagram_comment`; never
 * WhatsApp consent: only the seller marks it, after reading the conversation.
 */

/** A comment (masked) on an existing lead's timeline, and a notice to its owner (or the managers). */
export async function commentOnLead(
  db: Database,
  lead: { id: string; ownerEmployeeId: string | null },
  comment: { commentId: string; text: string; adId: string | null; at: Date },
): Promise<void> {
  await db.insert(leadEvents).values({
    leadId: lead.id,
    at: comment.at,
    kind: 'prospect.instagram_comment_seen',
    detail: {
      excerpt: instagramExcerpt(comment.text),
      occurredAt: comment.at.toISOString(),
      occurredAtPrecision: 'exata',
      onAd: comment.adId !== null,
    },
  });
  const people = lead.ownerEmployeeId ? [lead.ownerEmployeeId] : await managersAndBoard(db);
  if (people.length === 0) return;
  await db
    .insert(crmNotifications)
    .values(
      people.map((person) => ({
        recipientEmployeeId: person,
        leadId: lead.id,
        kind: 'lead_instagram',
        message: `O lead comentou num ${comment.adId ? 'anúncio' : 'post'} da Wings no Instagram.`,
        dedupeKey: `lead_instagram:${comment.commentId}:${person}`,
      })),
    )
    .onConflictDoNothing();
}

/** The ad's campaign and ad set, from our own reading of the ad account (`ad_ads`), if any. */
async function adOrigin(db: Database, adId: string) {
  const [row] = await db
    .select({ campaign: adCampaigns.externalId, adSet: adSets.externalId })
    .from(adAds)
    .leftJoin(adCampaigns, eq(adCampaigns.id, adAds.campaignId))
    .leftJoin(adSets, eq(adSets.id, adAds.adSetId))
    .where(eq(adAds.externalId, adId))
    .limit(1);
  return {
    adPlatform: 'meta' as const,
    adExternalId: adId,
    adCampaignExternalId: row?.campaign ?? null,
    adSetExternalId: row?.adSet ?? null,
  };
}

export interface DirectLeadInput {
  opportunity: typeof prospectOpportunities.$inferSelect;
  opening: typeof prospectEvidence.$inferSelect;
  personId: string;
  username: string | null;
  igsid: string;
  phone: string | null;
  email: string | null;
  at: Date;
}

/**
 * The lead from what she wrote in the Direct. Not made (and the opportunity stays for a person)
 * when the category has no funnel or a key of hers is under "não me contate".
 */
export async function leadFromDirect(
  db: Database,
  input: DirectLeadInput,
): Promise<{ leadId: string } | { skipped: 'sem_funil' | 'nao_contatar' }> {
  const { opportunity, opening } = input;
  const pipeline = pipelineOfCategory(opportunity.category);
  if (!pipeline) return { skipped: 'sem_funil' };
  const block = await contactBlock(db, ['instagram', 'phone', 'email', 'whatsapp'], {
    instagramUser: input.username,
    instagramIgsid: input.igsid,
    phone: input.phone,
    email: input.email,
  });
  if (block.blocked) return { skipped: 'nao_contatar' };
  const onAd = opening.adId !== null;
  const result = await upsertLead(db, {
    source: onAd ? 'instagram_ad' : 'instagram_comment',
    externalId: opening.externalId,
    channel: 'instagram',
    phone: input.phone,
    email: input.email,
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    pipeline,
    ownerEmployeeId: opportunity.ownerEmployeeId,
    distribute: opportunity.ownerEmployeeId === null,
    fields: input.username ? { instagram: input.username } : null,
    firstMessage: opening.excerpt,
    legalBasis: 'pre_contract',
    consentSource: 'instagram',
    consentText: `Escreveu o contato no Direct do Instagram (${dayOf(input.at)}), respondendo à resposta privada a um comentário num ${onAd ? 'anúncio' : 'post'} da Wings. Não pediu WhatsApp: só a vendedora marca, depois de ler a conversa.`,
    attribution: opening.adId ? await adOrigin(db, opening.adId) : null,
    skipResearch: true,
    event: {
      kind: 'lead.instagram',
      detail: { opportunityId: opportunity.id, evidenceId: opening.id },
    },
  });
  const leadId = result.lead.id;
  await db
    .update(prospectOpportunities)
    .set({
      state: 'aprovada',
      leadId,
      needsReviewReason: null,
      decidedAt: input.at,
      decidedBy: null,
      updatedAt: input.at,
    })
    .where(eq(prospectOpportunities.id, opportunity.id));
  // A lead follows the lead's own retention: its evidence is no longer purged at 30 days.
  await db
    .update(prospectEvidence)
    .set({ retentionUntil: null })
    .where(eq(prospectEvidence.opportunityId, opportunity.id));
  await db
    .update(igPeople)
    .set({ leadId, updatedAt: input.at })
    .where(eq(igPeople.id, input.personId));
  await writeAudit(db, {
    action: 'prospect_ai.instagram_lead_from_direct',
    entity: 'prospect_opportunity',
    entityId: opportunity.id,
    metadata: { leadId, created: result.created, pipeline, onAd },
  });
  return { leadId };
}
