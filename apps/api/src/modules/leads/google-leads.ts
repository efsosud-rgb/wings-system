import { normalizeBrazilianPhone, normalizeEmail, type LeadFields } from '@wings/shared';
import type { Database } from '../../db/client.js';
import { leadEvents } from '../../db/schema/index.js';
import { writeAudit } from '../../lib/audit.js';
import { entryStageOf } from './crm.js';
import { classifyFormName, noticeUnclassifiedForm } from './meta-form-routing.js';
import { resolveGoogleSource, upsertLead } from './service.js';

/**
 * Google Ads lead forms (YouTube, Search, Discovery) → Funil, by webhook
 * (docs/leads/formularios.md). Google posts one lead per request:
 *
 *   { lead_id, form_id, campaign_id, adgroup_id, creative_id, gcl_id,
 *     google_key, is_test, api_version,
 *     user_column_data: [{ column_id, column_name, string_value }] }
 *
 * Not verified live: built from Google's documented format; the route logs
 * only the shape of each body (key names and numbers) for the day it is.
 * Google's "send test data" button sets `is_test`: answered 200, never a lead.
 */

export interface GoogleLead {
  leadId: string | null;
  formId: string | null;
  campaignId: string | null;
  adgroupId: string | null;
  creativeId: string | null;
  isTest: boolean;
  key: string | undefined;
  name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  fields: LeadFields;
  answers: Record<string, string>;
}

const ANSWER_MAX = 500;
const QUESTION_MAX = 120;

const str = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** Google's standard columns; anything else is a question of the form. */
const NAME_COLUMNS = new Set(['FULL_NAME']);
const FIRST_NAME = 'FIRST_NAME';
const LAST_NAME = 'LAST_NAME';
const EMAIL_COLUMNS = new Set(['EMAIL', 'WORK_EMAIL']);
const PHONE_COLUMNS = new Set(['PHONE_NUMBER', 'WORK_PHONE']);
const CITY_COLUMNS = new Set(['CITY']);
const COMPANY_COLUMNS = new Set(['COMPANY_NAME']);

export function googleLeadOf(body: unknown): GoogleLead | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  const columns = Array.isArray(raw.user_column_data) ? raw.user_column_data : [];
  let name: string | null = null;
  let first: string | null = null;
  let last: string | null = null;
  let email: string | null = null;
  let phone: string | null = null;
  let city: string | null = null;
  const fields: LeadFields = {};
  const answers: Record<string, string> = {};

  for (const column of columns) {
    if (!column || typeof column !== 'object') continue;
    const c = column as Record<string, unknown>;
    const id = str(c.column_id)?.toUpperCase() ?? '';
    const label = str(c.column_name) ?? str(c.column_id);
    const value = str(c.string_value);
    if (!value) continue;
    if (NAME_COLUMNS.has(id)) name ??= value;
    else if (id === FIRST_NAME) first ??= value;
    else if (id === LAST_NAME) last ??= value;
    else if (EMAIL_COLUMNS.has(id)) email ??= value;
    else if (PHONE_COLUMNS.has(id)) phone ??= value;
    else if (CITY_COLUMNS.has(id)) city ??= value;
    else if (COMPANY_COLUMNS.has(id)) fields.companyName ??= value;
    else if (label) answers[label.slice(0, QUESTION_MAX)] = value.slice(0, ANSWER_MAX);
  }
  return {
    leadId: str(raw.lead_id),
    formId: str(raw.form_id),
    campaignId: str(raw.campaign_id),
    adgroupId: str(raw.adgroup_id),
    creativeId: str(raw.creative_id),
    isTest: raw.is_test === true || raw.is_test === 'true',
    key: typeof raw.google_key === 'string' ? raw.google_key : undefined,
    name: name ?? ([first, last].filter(Boolean).join(' ') || null),
    email,
    phone,
    city,
    fields,
    answers,
  };
}

export interface GoogleIngestResult {
  received: number;
  created: number;
  merged: number;
  skipped: number;
  test: boolean;
}

/** One lead from Google: the rule of the form or the campaign, else the default funnel. */
export async function ingestGoogleLead(
  deps: { db: Database; now?: () => Date; log: (facts: Record<string, unknown>) => void },
  lead: GoogleLead,
  context: { ip?: string } = {},
): Promise<GoogleIngestResult> {
  const result: GoogleIngestResult = {
    received: 1,
    created: 0,
    merged: 0,
    skipped: 0,
    test: lead.isTest,
  };
  if (lead.isTest) {
    deps.log({ job: 'google-lead-intake', msg: 'google test lead ignored' });
    return result;
  }
  const now = deps.now?.() ?? new Date();
  // WhatsApp asked as a question of the form still counts as the contact.
  const answersPhone = Object.entries(lead.answers).find(([q]) =>
    /whats|celular|telefone/i.test(q),
  )?.[1];
  const phone = normalizeBrazilianPhone(lead.phone ?? answersPhone ?? null);
  const email = normalizeEmail(lead.email);
  if (!phone && !email) {
    result.skipped = 1;
    deps.log({ job: 'google-lead-intake', msg: 'google lead skipped', reason: 'no_contact_data' });
    return result;
  }

  let client = await resolveGoogleSource(deps.db, {
    formId: lead.formId,
    campaignId: lead.campaignId,
  });
  let guessed = false;
  if (!client.ruleId) {
    // Google's body carries no form name: without a rule the lead enters the default funnel.
    const guess = await classifyFormName(deps.db, null);
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

  const upserted = await upsertLead(deps.db, {
    source: 'google_lead_form',
    name: lead.name,
    email,
    phone,
    clientId: client.clientId,
    clientMapped: client.mapped,
    pipeline: client.pipeline,
    brand: client.brand,
    channel: 'google_lead_form',
    campaignId: lead.campaignId,
    formId: lead.formId,
    externalId: lead.leadId,
    city: lead.city,
    formAnswers: Object.keys(lead.answers).length > 0 ? lead.answers : null,
    fields: lead.fields,
    legalBasis: 'consent',
    consentedAt: now,
    consentSource: `google_lead_form:form:${lead.formId ?? 'desconhecido'}`,
    consentText: 'Formulário de lead do Google Ads, com a política de privacidade do anunciante.',
    attribution: {
      adPlatform: 'google',
      adCampaignExternalId: lead.campaignId,
      adSetExternalId: lead.adgroupId,
      adExternalId: lead.creativeId,
      utmSource: 'google',
    },
    event: {
      kind: 'lead.received.google_lead_form',
      detail: {
        ruleId: client.ruleId,
        formId: lead.formId,
        campaignId: lead.campaignId,
        adgroupId: lead.adgroupId,
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
      source: 'google_lead_form',
      clientMapped: client.mapped,
      pipeline: client.pipeline,
    },
  });
  if (upserted.created) {
    result.created = 1;
    if (guessed || !client.ruleId) {
      await deps.db.insert(leadEvents).values({
        leadId: upserted.lead.id,
        kind: 'lead.pipeline_guessed',
        detail: { formId: lead.formId, pipeline: client.pipeline, reason: 'form_without_rule' },
      });
      await noticeUnclassifiedForm(deps.db, lead.formId, 'google');
    }
  } else {
    result.merged = 1;
  }
  deps.log({
    job: 'google-lead-intake',
    leadId: upserted.lead.id,
    created: upserted.created,
    pipeline: client.pipeline,
    mapped: client.mapped,
  });
  return result;
}
