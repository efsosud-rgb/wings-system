import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeBrazilianPhone, normalizeEmail, type LeadPipeline } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leadEvents, leads } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { RdCrm, type CrmMap } from '../expansion/rd.js';
import { announceBackfill, type BackfillTally } from './crm-alerts.js';
import { entryStageOf } from './crm.js';
import { classifyFormName, noticeUnclassifiedForm } from './meta-form-routing.js';
import { copyToRd, RD_TIKTOK_SOURCE_CANDIDATES, type OriginFacts } from './meta-intake.js';
import { resolveTikTokSource, upsertLead } from './service.js';

/**
 * TikTok Lead Ads → Funil (docs/leads/tiktok-lead-ads.md).
 *
 * Two senders reach the same door (`POST /integrations/tiktok/leads/webhook`):
 * TikTok's own "Custom API with Webhooks" and Zapier (TikTok Lead Generation →
 * Webhooks by Zapier). Both carry the answers of the form in the body, so
 * there is no queue and no read back from a platform: each lead is made (or
 * merged by phone/e-mail) before the 200, and a failure answers 5xx so the
 * sender retries. Idempotent: the lead id is the lead's `external_id`.
 *
 * NOT verified live: no real TikTok lead has reached this code. The parser is
 * lenient on purpose (many names for each field, arrays of questions, maps,
 * Zapier's flat "Full Name" style, JSON or form-encoded) and the route logs
 * the shape of every body (key names and numbers, never a value), so the day
 * the first real one arrives the log says which names it used.
 *
 * Personal data never reaches a log or an error message.
 */

export const TIKTOK_LEADS_JOB = 'tiktok-lead-intake';
const ANSWER_MAX = 500;
const ANSWERS_MAX = 40;

export interface TikTokLead {
  leadId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  formId: string | null;
  formName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  adgroupId: string | null;
  adgroupName: string | null;
  adId: string | null;
  adName: string | null;
  createdTime: Date | null;
  /** The other answers (question → answer), without the contact fields. Never logged. */
  answers: Record<string, string>;
}

// --- reading the body ---------------------------------------------------------------

/** "Full Name" / "full_name" / "fullName" → "fullname". */
const norm = (key: string) =>
  key
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const scalar = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(scalar).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Not a bare `id`: an envelope's own id (the event) must not pass for the lead's. */
const LEAD_ID = ['leadid', 'leadgenid', 'tiktokleadid'];
const FORM_ID = ['formid', 'instantformid', 'leadformid'];
const FORM_NAME = ['formname', 'instantformname', 'leadformname'];
const CAMPAIGN_ID = ['campaignid'];
const CAMPAIGN_NAME = ['campaignname'];
const ADGROUP_ID = ['adgroupid', 'adsetid'];
const ADGROUP_NAME = ['adgroupname', 'adsetname'];
const AD_ID = ['adid'];
const AD_NAME = ['adname'];
const CREATED = [
  'createtime',
  'createdtime',
  'createdat',
  'created',
  'date',
  'submittedat',
  'timestamp',
];

const NAME = ['fullname', 'name', 'nome', 'nomecompleto', 'yourname', 'username'];
const FIRST = ['firstname', 'primeironome'];
const LAST = ['lastname', 'sobrenome'];
const EMAIL = ['email', 'emailaddress', 'workemail', 'youremail', 'useremail'];
const PHONE = [
  'phonenumber',
  'phone',
  'telefone',
  'whatsapp',
  'celular',
  'mobile',
  'mobilephone',
  'cellphone',
  'yourphonenumber',
];
const CITY = ['city', 'cidade'];

/** Keys that describe the lead's origin, not a question: kept out of the answers. */
const NOT_ANSWERS = new Set([
  ...LEAD_ID,
  ...FORM_ID,
  ...FORM_NAME,
  ...CAMPAIGN_ID,
  ...CAMPAIGN_NAME,
  ...ADGROUP_ID,
  ...ADGROUP_NAME,
  ...AD_ID,
  ...AD_NAME,
  ...CREATED,
  ...NAME,
  ...FIRST,
  ...LAST,
  ...EMAIL,
  ...PHONE,
  ...CITY,
  'pageid',
  'advertiserid',
  'advertisername',
  'pagename',
  'event',
  'eventtype',
  'zapid',
  'source',
  'secret',
]);

/** Keys whose value is a list of questions or a map of them. */
const QUESTION_CONTAINERS = new Set([
  'userinfo',
  'questions',
  'formfields',
  'fields',
  'fielddata',
  'answers',
  'leaddata',
  'formdata',
  'formresponses',
  'customquestions',
  'responses',
]);
const QUESTION_NAME_KEYS = [
  'name',
  'fieldname',
  'question',
  'questionname',
  'label',
  'key',
  'title',
  'field',
  'type',
];
const QUESTION_VALUE_KEYS = ['value', 'values', 'answer', 'answers', 'text', 'response'];

/** Every (normalised key → value) the body carries, flat and nested question lists included. */
function flatten(record: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const put = (rawKey: string, value: unknown) => {
    const key = norm(rawKey);
    const text = scalar(value);
    if (key && text !== null && !out.has(key)) out.set(key, text);
  };
  const questions = (container: unknown) => {
    if (Array.isArray(container)) {
      for (const item of container) {
        if (!isRecord(item)) continue;
        const nameKey = QUESTION_NAME_KEYS.find((key) => scalar(item[key]) !== null);
        const valueKey = QUESTION_VALUE_KEYS.find((key) => scalar(item[key]) !== null);
        if (nameKey && valueKey) put(String(scalar(item[nameKey])), item[valueKey]);
        else for (const [key, value] of Object.entries(item)) put(key, value);
      }
    } else if (isRecord(container)) {
      for (const [key, value] of Object.entries(container)) put(key, value);
    }
  };
  for (const [key, value] of Object.entries(record)) {
    if (QUESTION_CONTAINERS.has(norm(key)) && (Array.isArray(value) || isRecord(value))) {
      questions(value);
    } else {
      put(key, value);
    }
  }
  return out;
}

const pick = (fields: Map<string, string>, names: readonly string[]): string | null => {
  for (const name of names) {
    const value = fields.get(name);
    if (value) return value;
  }
  return null;
};

/** A time in seconds, milliseconds or ISO; a future one (a clock or timezone slip) is cut back to now. */
function timeOf(value: string | null, now: Date): Date | null {
  if (!value) return null;
  const numeric = /^\d{9,13}$/.test(value) ? Number(value) : null;
  const date = new Date(numeric !== null ? (numeric > 1e11 ? numeric : numeric * 1000) : value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime() > now.getTime() ? now : date;
}

/** TikTok's lead (or a Zapier flat row) → the lead the Funil understands. */
export function tiktokLeadOf(raw: Record<string, unknown>, now = new Date()): TikTokLead {
  const fields = flatten(raw);
  const first = pick(fields, FIRST);
  const last = pick(fields, LAST);
  const email = pick(fields, EMAIL) ?? emailLike(fields);
  const phone = pick(fields, PHONE) ?? phoneLike(fields);
  const answers: Record<string, string> = {};
  const labels = new Map<string, string>();
  collectLabels(raw, labels);
  for (const [key, value] of fields) {
    if (NOT_ANSWERS.has(key) || QUESTION_CONTAINERS.has(key)) continue;
    if (Object.keys(answers).length >= ANSWERS_MAX) break;
    answers[(labels.get(key) ?? key).slice(0, 120)] = value.slice(0, ANSWER_MAX);
  }
  return {
    leadId: pick(fields, LEAD_ID),
    name: pick(fields, NAME) ?? (first ? [first, last].filter(Boolean).join(' ') : null),
    email,
    phone,
    city: pick(fields, CITY),
    formId: pick(fields, FORM_ID),
    formName: pick(fields, FORM_NAME),
    campaignId: pick(fields, CAMPAIGN_ID),
    campaignName: pick(fields, CAMPAIGN_NAME),
    adgroupId: pick(fields, ADGROUP_ID),
    adgroupName: pick(fields, ADGROUP_NAME),
    adId: pick(fields, AD_ID),
    adName: pick(fields, AD_NAME),
    createdTime: timeOf(pick(fields, CREATED), now),
    answers,
  };
}

/** A question the form named oddly ("Seu e-mail para contato"): the first value that looks like an e-mail. */
const emailLike = (fields: Map<string, string>): string | null => {
  for (const [key, value] of fields) {
    if (!NOT_ANSWERS.has(key) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return value;
  }
  return null;
};

/** Same for a phone: a key that says so (telefone, whatsapp, phone...) whose value has 10 to 13 digits. */
const phoneLike = (fields: Map<string, string>): string | null => {
  for (const [key, value] of fields) {
    if (NOT_ANSWERS.has(key) || !/(phone|telefone|whats|celular|fone|mobile)/.test(key)) continue;
    const digits = value.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13) return value;
  }
  return null;
};

/** The readable question text for a normalised key, when the body carried it. */
function collectLabels(raw: Record<string, unknown>, labels: Map<string, string>): void {
  const add = (rawKey: string) => labels.set(norm(rawKey), rawKey.trim());
  for (const [key, value] of Object.entries(raw)) {
    if (QUESTION_CONTAINERS.has(norm(key))) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (!isRecord(item)) continue;
          const nameKey = QUESTION_NAME_KEYS.find((candidate) => scalar(item[candidate]) !== null);
          if (nameKey) add(String(scalar(item[nameKey])));
        }
      } else if (isRecord(value)) {
        for (const inner of Object.keys(value)) add(inner);
      }
    } else {
      add(key);
    }
  }
}

/**
 * The leads in a body: one object, a list, or an envelope (`{ leads: [...] }`,
 * `{ data: {...} }`, `{ event, lead: {...} }`). A string that holds JSON is opened.
 */
export function tiktokLeadsIn(body: unknown, now = new Date()): TikTokLead[] {
  const out: TikTokLead[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 3) return;
    if (typeof node === 'string' && /^\s*[[{]/.test(node)) {
      try {
        visit(JSON.parse(node), depth + 1);
      } catch {
        // not JSON: nothing to read
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    const own = tiktokLeadOf(node, now);
    if (own.leadId || own.email || own.phone) {
      out.push(own);
      return;
    }
    for (const key of [
      'leads',
      'data',
      'lead',
      'items',
      'events',
      'payload',
      'content',
      'result',
    ]) {
      if (key in node) visit(node[key], depth + 1);
    }
  };
  visit(body, 0);
  return out;
}

// --- the secret ----------------------------------------------------------------------

/**
 * Constant-time comparison of two secrets of any length: both are hashed first, so
 * neither the content nor the length of the expected one shows in the timing.
 */
export function secretMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

// --- making the leads ---------------------------------------------------------------

export interface TikTokIntakeDeps {
  db: Database;
  rdCrmToken: string | null;
  expansionOwnerId: string | null;
  /** TIKTOK_LEADS_RD_COPY_ENABLED=true; anything else leaves RD alone. */
  rdCopyEnabled: boolean;
  rdFetch?: typeof fetch;
  log: (facts: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface TikTokIngestResult {
  received: number;
  created: number;
  merged: number;
  /** No phone and no e-mail: nothing to dedupe by, nothing a seller could call. */
  skipped: number;
  /** Failures worth a retry by the sender (the route answers 500 when > 0). */
  failed: number;
  rdCreated: number;
}

export async function ingestTikTokLeads(
  deps: TikTokIntakeDeps,
  incoming: readonly TikTokLead[],
  context: { ip?: string } = {},
): Promise<TikTokIngestResult> {
  const now = deps.now?.() ?? new Date();
  const result: TikTokIngestResult = {
    received: incoming.length,
    created: 0,
    merged: 0,
    skipped: 0,
    failed: 0,
    rdCreated: 0,
  };
  const backfill: BackfillTally = new Map();
  const crm =
    deps.rdCopyEnabled && deps.rdCrmToken ? new RdCrm(deps.rdCrmToken, deps.rdFetch) : null;
  let rdMap: CrmMap | null | undefined;

  for (const lead of incoming) {
    try {
      const phone = normalizeBrazilianPhone(lead.phone);
      const email = normalizeEmail(lead.email);
      if (!phone && !email) {
        result.skipped += 1;
        deps.log({ job: TIKTOK_LEADS_JOB, msg: 'tiktok lead skipped', reason: 'no_contact_data' });
        continue;
      }

      let client = await resolveTikTokSource(deps.db, {
        formId: lead.formId,
        campaignId: lead.campaignId,
      });
      // No rule for the form or the campaign: the form's own name says the funnel; if it does
      // not, Formatação, and Diretoria gets one notice about the form.
      let guessed = false;
      if (!client.ruleId) {
        const guess = await classifyFormName(deps.db, lead.formName);
        client = {
          clientId: guess.clientId ?? client.clientId,
          mapped: guess.clientId !== null,
          ruleId: null,
          pipeline: guess.pipeline,
          brand: guess.brand,
        };
        guessed = guess.guessed;
      }
      if (client.pipeline) await entryStageOf(deps.db, client.pipeline);

      const arrived = lead.createdTime;
      const upserted = await upsertLead(deps.db, {
        source: 'tiktok_lead_ads',
        name: lead.name,
        email,
        phone,
        clientId: client.clientId,
        clientMapped: client.mapped,
        pipeline: client.pipeline,
        brand: client.brand,
        channel: 'tiktok_lead_ads',
        campaignId: lead.campaignId,
        campaignName: lead.campaignName,
        formId: lead.formId,
        externalId: lead.leadId,
        city: lead.city,
        formAnswers: Object.keys(lead.answers).length > 0 ? lead.answers : null,
        legalBasis: 'consent',
        originCreatedAt: arrived,
        consentedAt: arrived ?? now,
        consentSource: `tiktok_lead_ads:form:${lead.formId ?? 'desconhecido'}`,
        consentText:
          'Formulário de cadastro do TikTok Lead Ads, com a política de privacidade do formulário.',
        attribution: {
          adPlatform: 'tiktok',
          adCampaignExternalId: lead.campaignId,
          adSetExternalId: lead.adgroupId,
          adExternalId: lead.adId,
          utmSource: 'tiktok',
        },
        event: {
          kind: 'lead.received.tiktok_lead_ads',
          detail: {
            ruleId: client.ruleId,
            formId: lead.formId,
            campaignId: lead.campaignId,
            adgroupId: lead.adgroupId,
            adId: lead.adId,
            answers: Object.keys(lead.answers).length,
          },
        },
      });
      await writeAudit(deps.db, {
        action: upserted.created ? 'lead.received' : 'lead.merged',
        entity: 'lead',
        entityId: upserted.lead.id,
        ip: context.ip,
        metadata: {
          source: 'tiktok_lead_ads',
          clientMapped: client.mapped,
          pipeline: client.pipeline,
          assignedTo: upserted.assignedTo ?? null,
        },
      });
      if (upserted.created) {
        result.created += 1;
        if (upserted.stale)
          backfill.set(
            upserted.assignedTo ?? null,
            (backfill.get(upserted.assignedTo ?? null) ?? 0) + 1,
          );
        if (guessed) {
          await deps.db.insert(leadEvents).values({
            leadId: upserted.lead.id,
            kind: 'lead.pipeline_guessed',
            detail: { formId: lead.formId, pipeline: client.pipeline, reason: 'form_without_rule' },
          });
          await noticeUnclassifiedForm(deps.db, lead.formId, 'tiktok');
        }
      } else {
        result.merged += 1;
      }

      // The copy in RD CRM: only for a lead born here, once, never in the way of the lead itself.
      if (upserted.created) {
        let outcome: string;
        try {
          if (rdMap === undefined && crm) {
            try {
              rdMap = await crm.map();
            } catch {
              rdMap = null;
            }
          }
          const row = await deps.db.query.leads.findFirst({
            where: eq(leads.id, upserted.lead.id),
          });
          const rd = row
            ? await copyToRd(deps, {
                crm,
                rdMap: rdMap ?? null,
                leadId: row.id,
                rdDealId: row.rdDealId,
                pipeline: (row.pipeline as LeadPipeline | null) ?? null,
                brand: row.brand,
                person: { name: row.name, email: row.email, phone: row.phone },
                origin: originOf(lead),
                via: 'tiktok_lead_ads',
              })
            : { outcome: 'lead_missing' as const, dealId: null };
          outcome = rd.outcome;
          if (rd.outcome === 'created') result.rdCreated += 1;
        } catch {
          outcome = 'failed';
        }
        deps.log({
          job: TIKTOK_LEADS_JOB,
          leadId: upserted.lead.id,
          created: true,
          pipeline: client.pipeline,
          mapped: client.mapped,
          rd: outcome,
        });
      } else {
        deps.log({ job: TIKTOK_LEADS_JOB, leadId: upserted.lead.id, created: false });
      }
    } catch (error) {
      result.failed += 1;
      deps.log({
        job: TIKTOK_LEADS_JOB,
        msg: 'tiktok lead failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  await announceBackfill(deps.db, backfill, now);
  return result;
}

const originOf = (lead: TikTokLead): OriginFacts => ({
  label: 'TikTok Lead Ads',
  sourceCandidates: RD_TIKTOK_SOURCE_CANDIDATES,
  platform: 'tiktok',
  formId: lead.formId,
  campaignId: lead.campaignId,
  campaignName: lead.campaignName,
  adsetId: lead.adgroupId,
  adsetName: lead.adgroupName,
  adId: lead.adId,
  adName: lead.adName,
  organic: false,
});
