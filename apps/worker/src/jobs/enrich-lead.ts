import {
  EMPTY_FACTS,
  emailDomainOf,
  enrichmentSummaryOf,
  franchiseeScoreOf,
  isLegacyWebResearch,
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
  enrichment_facts: unknown;
  created_at: Date;
  /** When the lead first arrived (0076); older than `created_at` for a lead imported later. */
  entered_at: Date | null;
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
    `select id, client_id, name, email, phone, whatsapp_profile_name, whatsapp_photo_url, enrichment_facts, created_at, entered_at
       from leads where id = $1`,
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
    // bring stays empty with the reason (docs/leads/pesquisa-da-empresa.md). A result that
    // came back with pages is kept: a re-run (or a switched-off provider) never pays for it again
    // and never overwrites it with a refusal. The one exception is a result in the old format (no
    // page for its values, so the page shows "—" for every one and nothing can tell which page
    // backs which): it is asked again, once the provider is on and the lead is inside the cut-off,
    // and it stays on the lead if that asking is refused, fails or finds no company data.
    const previous = webResearchOf(lead.enrichment_facts);
    const finished = previous?.status === 'done' && previous.sources.length > 0 ? previous : null;
    const legacy = isLegacyWebResearch(finished);
    const redoing = legacy && Boolean(enrichment.research) && !arrivedBefore(lead, enrichment.researchSince);
    if (finished && !redoing) {
      facts.webResearch = finished;
      if (enrichment.research) {
        await writeLedger(db, { leadId, jobId: job.id, step: 'ai_research', status: 'skipped', usdMicro: 0, detail: { reason: legacy ? 'legacy_before_cutoff' : 'already_done' } });
        steps.web_research = 'skipped';
      }
    } else if (enrichment.research && arrivedBefore(lead, enrichment.researchSince)) {
      // Only leads that arrived from the cut-off on: an older lead that converts again is not researched.
      facts.webResearch = noResearch(
        'skipped',
        now.toISOString(),
        `Lead anterior a ${dayOf(enrichment.researchSince as Date)}: a pesquisa só roda para leads que chegaram a partir dessa data`,
      );
      await writeLedger(db, { leadId, jobId: job.id, step: 'ai_research', status: 'skipped', usdMicro: 0, detail: { reason: 'before_cutoff' } });
      steps.web_research = 'skipped';
    } else if (enrichment.research) {
      const research = enrichment.research;
      const at = now.toISOString();
      let input: ReturnType<typeof researchInputOf> = null;
      let prepared = true;
      try {
        input = researchInputOf(leadId, await companyFieldsOf(db, leadId), lead.name, lead.email);
      } catch (error) {
        // Not being able to read or clean the company fields is this step's failure, not the job's.
        prepared = false;
        await writeLedger(db, { leadId, jobId: job.id, step: 'ai_research', status: 'failed', usdMicro: 0, detail: { reason: messageOf(error) } });
        facts.webResearch = noResearch('failed', at, 'Não foi possível preparar a pesquisa; nada foi enviado');
        steps.web_research = 'failed';
      }
      if (prepared && !input) {
        facts.webResearch = noResearch('skipped', at, 'O formulário não trouxe dado da empresa (nome, site, Instagram ou e-mail corporativo)');
        await writeLedger(db, { leadId, jobId: job.id, step: 'ai_research', status: 'skipped', usdMicro: 0, detail: { reason: 'no_company_data' } });
        steps.web_research = 'skipped';
      } else if (prepared && input) {
        const reserved = await reserveSpend(db, {
          leadId,
          jobId: job.id,
          step: 'ai_research',
          usdMicro: research.reserveUsdMicro,
          dailyUsd: enrichment.budget.researchDailyUsd,
          now,
          detail: { provider: research.name, ...(redoing ? { redo: 'legacy_format' } : {}) },
        });
        if (!reserved) {
          facts.webResearch = noResearch('refused', at, 'O teto diário da pesquisa foi atingido; nenhuma chamada foi feita');
          steps.web_research = 'refused';
        } else {
          costUsdMicro += research.reserveUsdMicro;
          try {
            const finding = await research.research(input);
            // The reserving row stays; a second row settles it to what the call really cost
            // (above the reservation or below it), so the ceiling follows the real spend.
            const settle = finding.costUsdMicro - research.reserveUsdMicro;
            costUsdMicro += settle;
            await writeLedger(db, {
              leadId,
              jobId: job.id,
              step: 'ai_research',
              status: 'done',
              usdMicro: settle,
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
            const reason = messageOf(error);
            await writeLedger(db, { leadId, jobId: job.id, step: 'ai_research', status: 'failed', usdMicro: 0, detail: { reason } });
            // Also in the worker's log (status and lead id only), so a refused key shows without reading the ledger.
            console.warn(JSON.stringify({ worker: 'enrich_lead', msg: 'lead research failed', leadId, reason }));
            facts.webResearch = noResearch('failed', at, researchFailureReasonOf(reason));
            steps.web_research = 'failed';
          }
        }
      }
    } else if (previous) {
      // Switched off now: what an earlier run found stays on the lead.
      facts.webResearch = previous;
    }
    // A redo that did not produce a new result leaves the old one, never a refusal or a failure in its place.
    if (redoing && finished && steps.web_research !== 'done') facts.webResearch = finished;

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

/** The company fields a lead form may have filled; none when the columns are not there yet (42703). */
/**
 * True when the lead arrived before the research cut-off: the earlier of when it was created
 * here and when it first arrived (a lead imported today from an old RD deal is old). No
 * cut-off configured: nothing is before it.
 */
export function arrivedBefore(lead: Pick<LeadRow, 'created_at' | 'entered_at'>, since: Date | null | undefined): boolean {
  if (!since) return false;
  const created = new Date(lead.created_at).getTime();
  const entered = lead.entered_at ? new Date(lead.entered_at).getTime() : created;
  return Math.min(created, entered) < since.getTime();
}

/** dd/mm/aaaa of a date in São Paulo. */
const dayOf = (date: Date) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date);

/** The company's own fields; never the CNPJ, which is not sent to the research. */
async function companyFieldsOf(db: JobContext['db'], leadId: string) {
  try {
    const result = await db.query<{
      company_name: string | null;
      website: string | null;
      instagram: string | null;
    }>(`select company_name, website, instagram from leads where id = $1`, [leadId]);
    return result.rows[0] ?? {};
  } catch (error) {
    if ((error as { code?: string }).code === '42703') return {};
    throw error;
  }
}

/** What an earlier run stored under `webResearch`, when it has the shape this code writes. */
function webResearchOf(facts: unknown): LeadWebResearch | null {
  const value = (facts as { webResearch?: Partial<LeadWebResearch> } | null)?.webResearch;
  if (!value || typeof value !== 'object' || typeof value.status !== 'string') return null;
  return {
    status: value.status,
    at: typeof value.at === 'string' ? value.at : new Date(0).toISOString(),
    reason: value.reason ?? null,
    fields: Array.isArray(value.fields) ? value.fields : [],
    sources: Array.isArray(value.sources) ? value.sources : [],
    model: value.model ?? null,
  };
}

const noResearch = (status: LeadWebResearch['status'], at: string, reason: string): LeadWebResearch => ({
  status,
  at,
  reason,
  fields: [],
  sources: [],
  model: null,
});

/**
 * What the deal page says when the research failed, from the provider's message
 * (`OpenRouter answered 401`, `OpenRouter did not answer (TimeoutError)`...): a
 * refused key, no credit and no answer are different problems for whoever reads
 * it, and each is already a status, never the person or the key.
 */
export function researchFailureReasonOf(message: string): string {
  if (/answered (401|403)\b/.test(message)) {
    return 'A pesquisa não rodou: o OpenRouter recusou a chave do worker (401/403); nada foi inventado';
  }
  if (/answered 402\b/.test(message)) {
    return 'A pesquisa não rodou: a conta do OpenRouter está sem crédito (402); nada foi inventado';
  }
  if (/answered 429\b/.test(message)) {
    return 'A pesquisa não terminou: o OpenRouter limitou as chamadas (429); nada foi inventado';
  }
  const status = /answered (\d{3})\b/.exec(message)?.[1];
  if (status) {
    return `A pesquisa não terminou: o OpenRouter respondeu com erro (${status}); nada foi inventado`;
  }
  if (/without the JSON|not JSON|reported an error/.test(message)) {
    return 'A pesquisa não terminou: o OpenRouter respondeu, mas não no formato pedido; nada foi inventado';
  }
  return 'A pesquisa não terminou (o provedor não respondeu); nada foi inventado';
}

/** A message, never a stack, a query or a name. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 200);
}

export { formatCnpj };
