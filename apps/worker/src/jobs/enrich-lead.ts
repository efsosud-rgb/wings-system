import {
  EMPTY_FACTS,
  emailDomainOf,
  enrichmentSummaryOf,
  franchiseeScoreOf,
  regionOfPhone,
  type EnrichmentFacts,
  type ExpansionEntry,
  type FoundLink,
  type LeadCompany,
  type LeadWebResearch,
  type LeadWhatsappProfile,
} from '@wings/shared';
import { z } from 'zod';
import { formatCnpj, reserveSpend, writeLedger, type CnpjRecord, type SearchResult } from '../lib/enrichment.js';
import { researchInputOf } from '../lib/lead-research.js';
import type { Job } from '../queue.js';
import type { JobContext, JobHandler } from './types.js';

const inputSchema = z.object({ leadId: z.uuid() });

interface LeadRow {
  id: string;
  client_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  whatsapp_profile_name: string | null;
  whatsapp_photo_url: string | null;
}

export interface EnrichLeadOutput {
  leadId: string;
  score: number | null;
  searches: number;
  linksFound: number;
  companyFound: boolean;
  costUsdMicro: number;
  /** Which steps ran, were skipped or failed, for the timeline. */
  steps: Record<string, 'done' | 'skipped' | 'failed' | 'refused'>;
}

const plain = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The lead's first and last name tokens both appear (a QSA lists full names). */
export function nameMatches(leadName: string, candidate: string): boolean {
  const tokens = plain(leadName).split(' ').filter((token) => token.length >= 2);
  if (tokens.length === 0) return false;
  const haystack = ` ${plain(candidate)} `;
  if (tokens.length === 1) return haystack.includes(` ${tokens[0]} `);
  return haystack.includes(` ${tokens[0]} `) && haystack.includes(` ${tokens[tokens.length - 1]} `);
}

const CNPJ_RE = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g;

export function cnpjCandidatesOf(texts: string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(CNPJ_RE)) {
      const digits = match[0].replace(/\D/g, '');
      if (digits.length === 14) seen.add(digits);
    }
  }
  return [...seen];
}

function linkKindOf(url: string): FoundLink['kind'] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const path = parsed.pathname;
  if (host.endsWith('linkedin.com') && /^\/in\/[^/]+/.test(path)) return 'linkedin';
  if (host === 'instagram.com' && /^\/[^/]+\/?$/.test(path) && !/^\/(p|reel|explore|accounts)\//.test(path)) {
    return 'instagram';
  }
  return null;
}

/** Only results that name the lead: a LinkedIn or Instagram page for someone else is noise, not a find. */
export function profileLinksOf(leadName: string, results: SearchResult[]): FoundLink[] {
  const links: FoundLink[] = [];
  for (const result of results) {
    const kind = linkKindOf(result.url);
    if (!kind) continue;
    if (!nameMatches(leadName, `${result.title} ${result.snippet}`)) continue;
    if (links.some((link) => link.kind === kind)) continue;
    links.push({ kind, url: result.url, title: result.title, snippet: result.snippet.slice(0, 300) });
  }
  return links;
}

export function companyOf(
  record: CnpjRecord,
  lead: { name: string | null; emailDomain: string | null },
): LeadCompany | null {
  if (record.status && !/ativa/i.test(record.status)) return null;
  const isPartner = lead.name !== null && record.partners.some((partner) => nameMatches(lead.name as string, partner));
  const domainLabel = lead.emailDomain?.split('.')[0] ?? '';
  const byDomain =
    domainLabel.length >= 4 &&
    (plain(record.legalName).includes(plain(domainLabel)) || plain(record.tradeName ?? '').includes(plain(domainLabel)));
  if (!isPartner && !byDomain) return null;
  return {
    cnpj: record.cnpj,
    name: record.tradeName ?? record.legalName,
    legalName: record.legalName,
    capitalSocialBrl: record.capitalSocialBrl,
    openedAt: record.openedAt,
    mainActivity: record.mainActivity,
    size: record.size,
    city: record.city,
    uf: record.uf,
    leadIsPartner: isPartner,
    matchedBy: isPartner ? 'partner' : 'email_domain',
  };
}

/**
 * Finds out who a lead is from what is public: WhatsApp profile (Z-API),
 * region by DDD, e-mail domain, LinkedIn/Instagram by web search, and a CNPJ
 * the lead is tied to (BrasilAPI). Then the explainable score and the
 * five-line summary, written on the lead. Every outside step is guarded on
 * its own: one failing leaves its fact empty and the rest goes on. Paid
 * steps go through the ledger and the daily ceiling first, and are never
 * retried. The job is one attempt; a person asks again from the screen.
 */
export const runEnrichLeadJob: JobHandler = async (job: Job, ctx: JobContext) => {
  const { leadId } = inputSchema.parse(job.input);
  const { db, enrichment } = ctx;
  const now = ctx.now?.() ?? new Date();

  const found = await db.query<LeadRow>(
    `select id, client_id, name, email, phone, whatsapp_profile_name, whatsapp_photo_url from leads where id = $1`,
    [leadId],
  );
  const lead = found.rows[0];
  if (!lead) throw new Error('lead not found');

  await db.query(`update leads set enrichment_state = 'running', updated_at = now() where id = $1`, [leadId]);
  await db.query(`insert into lead_events (lead_id, kind, detail) values ($1, 'research.started', $2)`, [
    leadId,
    JSON.stringify({ jobId: job.id }),
  ]);

  const steps: EnrichLeadOutput['steps'] = {};
  let costUsdMicro = 0;
  const facts: EnrichmentFacts = { ...EMPTY_FACTS, links: [] };

  try {
    // --- free, local -----------------------------------------------------------------
    facts.region = regionOfPhone(lead.phone);
    facts.emailDomain = emailDomainOf(lead.email);

    // --- WhatsApp profile (free) ---------------------------------------------------------
    if (lead.whatsapp_profile_name || lead.whatsapp_photo_url) {
      facts.whatsapp = { profileName: lead.whatsapp_profile_name, photoUrl: lead.whatsapp_photo_url };
      steps.zapi_profile = 'skipped';
    } else if (lead.phone && enrichment.zapi) {
      try {
        const profile: LeadWhatsappProfile = await enrichment.zapi.profileOf(lead.phone);
        facts.whatsapp = profile;
        await writeLedger(db, { leadId, jobId: job.id, step: 'zapi_profile', status: 'done', usdMicro: 0, detail: { hasName: profile.profileName !== null, hasPhoto: profile.photoUrl !== null } });
        steps.zapi_profile = 'done';
        if (profile.profileName || profile.photoUrl) {
          await db.query(
            `update leads set whatsapp_profile_name = coalesce(whatsapp_profile_name, $2), whatsapp_photo_url = coalesce(whatsapp_photo_url, $3) where id = $1`,
            [leadId, profile.profileName, profile.photoUrl],
          );
        }
      } catch (error) {
        await writeLedger(db, { leadId, jobId: job.id, step: 'zapi_profile', status: 'failed', usdMicro: 0, detail: { reason: messageOf(error) } });
        steps.zapi_profile = 'failed';
      }
    } else {
      steps.zapi_profile = 'skipped';
    }

    // --- web search (paid) ---------------------------------------------------------------
    const searchUsdMicro = Math.round(enrichment.budget.searchUsdPerQuery * 1_000_000);
    const snippets: string[] = [];
    async function paidSearch(query: string, purpose: string): Promise<SearchResult[] | null> {
      if (!enrichment.search) return null;
      const reserved = await reserveSpend(db, {
        leadId,
        jobId: job.id,
        step: 'web_search',
        usdMicro: searchUsdMicro,
        dailyUsd: enrichment.budget.dailyUsd,
        now,
        detail: { purpose },
      });
      if (!reserved) {
        steps.web_search = 'refused';
        return null;
      }
      costUsdMicro += searchUsdMicro;
      facts.searches += 1;
      try {
        const results = await enrichment.search.search(query);
        await writeLedger(db, { leadId, jobId: job.id, step: 'web_search', status: 'done', usdMicro: 0, detail: { purpose, results: results.length } });
        for (const result of results) snippets.push(`${result.title} ${result.snippet}`);
        return results;
      } catch (error) {
        // The row that reserved the cost stays: the call was made, whatever it answered.
        await writeLedger(db, { leadId, jobId: job.id, step: 'web_search', status: 'failed', usdMicro: 0, detail: { purpose, reason: messageOf(error) } });
        return null;
      }
    }

    const name = lead.name?.trim() ?? '';
    if (name.length >= 3 && enrichment.search) {
      const city = facts.region ? `${facts.region.city} ${facts.region.uf}` : '';
      const first = await paidSearch(`"${name}" ${city} linkedin`.trim(), 'linkedin');
      if (first) facts.links.push(...profileLinksOf(name, first));
      if (steps.web_search !== 'refused') {
        const second = await paidSearch(`"${name}" ${city} instagram`.trim(), 'instagram');
        if (second) facts.links.push(...profileLinksOf(name, second).filter((l) => !facts.links.some((k) => k.kind === l.kind)));
      }
      if (steps.web_search !== 'refused') steps.web_search = 'done';
    } else {
      steps.web_search = 'skipped';
    }

    // --- CNPJ (search paid when there is a clue; BrasilAPI free) -------------------------
    let candidates = cnpjCandidatesOf(snippets);
    if (candidates.length === 0 && facts.emailDomain?.kind === 'corporate' && enrichment.search && steps.web_search !== 'refused') {
      const byDomain = await paidSearch(`"${facts.emailDomain.domain}" cnpj`, 'cnpj');
      if (byDomain) candidates = cnpjCandidatesOf(byDomain.map((r) => `${r.title} ${r.snippet}`));
    }
    if (candidates.length === 0) {
      steps.brasilapi_cnpj = 'skipped';
    } else {
      for (const digits of candidates.slice(0, 2)) {
        try {
          const record = await enrichment.cnpj.lookup(digits);
          const company = record ? companyOf(record, { name: lead.name, emailDomain: facts.emailDomain?.domain ?? null }) : null;
          await writeLedger(db, { leadId, jobId: job.id, step: 'brasilapi_cnpj', status: 'done', usdMicro: 0, detail: { found: record !== null, kept: company !== null } });
          steps.brasilapi_cnpj = 'done';
          if (company) {
            facts.company = company;
            break;
          }
        } catch (error) {
          await writeLedger(db, { leadId, jobId: job.id, step: 'brasilapi_cnpj', status: 'failed', usdMicro: 0, detail: { reason: messageOf(error) } });
          steps.brasilapi_cnpj = 'failed';
        }
      }
    }

    // --- company research (OpenRouter), only the company's own data ------------------------
    // Reserved under its own ceiling first, called once, never retried; what the search did not
    // bring stays empty with the reason (docs/leads/pesquisa-da-empresa.md).
    if (enrichment.research) {
      const research = enrichment.research;
      const at = now.toISOString();
      const company = await companyFieldsOf(db, leadId);
      const input = researchInputOf(leadId, company);
      if (!input) {
        facts.webResearch = noResearch('skipped', at, 'O formulário não trouxe dado da empresa (nome, site, Instagram ou CNPJ)');
        await writeLedger(db, { leadId, jobId: job.id, step: 'ai_research', status: 'skipped', usdMicro: 0, detail: { reason: 'no_company_data' } });
        steps.web_research = 'skipped';
      } else {
        const reserved = await reserveSpend(db, {
          leadId,
          jobId: job.id,
          step: 'ai_research',
          usdMicro: research.reserveUsdMicro,
          dailyUsd: enrichment.budget.researchDailyUsd,
          now,
          detail: { provider: research.name },
        });
        if (!reserved) {
          facts.webResearch = noResearch('refused', at, 'O teto diário da pesquisa foi atingido; nenhuma chamada foi feita');
          steps.web_research = 'refused';
        } else {
          costUsdMicro += research.reserveUsdMicro;
          try {
            const finding = await research.research(input);
            // The reserving row stays; only a cost above the reservation is added, so the ceiling stays honest.
            const extra = Math.max(0, finding.costUsdMicro - research.reserveUsdMicro);
            costUsdMicro += extra;
            await writeLedger(db, {
              leadId,
              jobId: job.id,
              step: 'ai_research',
              status: 'done',
              usdMicro: extra,
              detail: {
                actualUsdMicro: finding.costUsdMicro,
                sources: finding.sources.length,
                answered: finding.fields.filter((field) => field.value !== null).length,
              },
            });
            facts.webResearch = { status: 'done', at, reason: null, fields: finding.fields, sources: finding.sources, model: finding.model };
            steps.web_research = 'done';
          } catch (error) {
            // The call was made, whatever it answered: the reserving row stays.
            await writeLedger(db, { leadId, jobId: job.id, step: 'ai_research', status: 'failed', usdMicro: 0, detail: { reason: messageOf(error) } });
            facts.webResearch = noResearch('failed', at, 'A pesquisa não terminou (o provedor não respondeu); nada foi inventado');
            steps.web_research = 'failed';
          }
        }
      }
    }

    // --- score and summary -------------------------------------------------------------
    const area = await db.query<{ expansion_area: unknown }>(`select expansion_area from clients where id = $1`, [lead.client_id]);
    const expansionArea = Array.isArray(area.rows[0]?.expansion_area) ? (area.rows[0]?.expansion_area as ExpansionEntry[]) : [];
    const score = franchiseeScoreOf(facts, expansionArea);
    const summary = enrichmentSummaryOf({ name: lead.name }, facts, score);

    await db.query(
      `update leads
         set enrichment_state = 'done', enrichment_summary = $2, enrichment_score = $3, enrichment_criteria = $4,
             enrichment_links = $5, enrichment_facts = $6, enrichment_error = null, enriched_at = now(), updated_at = now()
       where id = $1`,
      [leadId, summary, score.score, JSON.stringify(score.criteria), JSON.stringify(facts.links), JSON.stringify(facts)],
    );
    const output: EnrichLeadOutput = {
      leadId,
      score: score.score,
      searches: facts.searches,
      linksFound: facts.links.length,
      companyFound: facts.company !== null,
      costUsdMicro,
      steps,
    };
    await db.query(`insert into lead_events (lead_id, kind, detail) values ($1, 'research.done', $2)`, [
      leadId,
      JSON.stringify({ jobId: job.id, ...output, leadId: undefined }),
    ]);
    return output;
  } catch (error) {
    const reason = messageOf(error);
    await db.query(
      `update leads set enrichment_state = 'failed', enrichment_error = $2, enriched_at = now(), updated_at = now() where id = $1`,
      [leadId, reason],
    );
    await db.query(`insert into lead_events (lead_id, kind, detail) values ($1, 'research.failed', $2)`, [
      leadId,
      JSON.stringify({ jobId: job.id, reason, steps, costUsdMicro }),
    ]);
    throw error;
  }
};

/** The company fields a lead form may have filled; none when the columns are not there yet. */
async function companyFieldsOf(db: JobContext['db'], leadId: string) {
  try {
    const result = await db.query<{
      company_name: string | null;
      website: string | null;
      instagram: string | null;
      company_cnpj: string | null;
    }>(`select company_name, website, instagram, company_cnpj from leads where id = $1`, [leadId]);
    return result.rows[0] ?? {};
  } catch {
    return {};
  }
}

const noResearch = (status: LeadWebResearch['status'], at: string, reason: string): LeadWebResearch => ({
  status,
  at,
  reason,
  fields: [],
  sources: [],
  model: null,
});

/** A message, never a stack, a query or a name. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 200);
}

export { formatCnpj };
