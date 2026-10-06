import {
  LEAD_CHECK_KEYS,
  declaresNone,
  isValidCnpj,
  missingCheck,
  normalizeInstagram,
  normalizeWebsite,
  whatsappCheck,
  type LeadCheck,
  type LeadCheckKey,
  type LeadChecks,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/client.js';
import { leads } from '../../db/schema/index.js';
import type { Probe } from '../../lib/public-probe.js';
import type { CnpjLookup, LookupResult } from '../clients/lookup.js';
import { shapeOf } from '../media/kairogen-adapter.js';

/**
 * The checks done when a lead arrives (docs/leads/formularios.md): WhatsApp
 * (area code in use, mobile), the site answering, the Instagram existing
 * (Business Discovery, with Wings' own account) and the CNPJ in the public
 * register. Each says confere / não confere / não verificado with the reason;
 * none of them ever logs the lead's data, only statuses and answer shapes.
 *
 * They run after the lead is saved, off the request (a form's sender never
 * waits for a third-party site), and again on "Conferir de novo".
 */

export type InstagramLookup = (handle: string) => Promise<LeadCheck>;

export interface LeadCheckDeps {
  probe: Probe | null;
  instagram: InstagramLookup | null;
  cnpj: ((cnpj: string) => Promise<LookupResult<CnpjLookup>>) | null;
  now: () => Date;
  log: FastifyBaseLogger;
}

type CheckedLead = {
  phone: string | null;
  website: string | null;
  instagram: string | null;
  companyCnpj: string | null;
};

const result = (status: LeadCheck['status'], reason: string | null, at: Date): LeadCheck => ({
  status,
  reason,
  checkedAt: at.toISOString(),
});

/** "Não tenho" (what the site form asks for): not verified, never "não confere". */
function noneCheck(field: LeadCheckKey, at: Date): LeadCheck {
  const label = { whatsapp: 'WhatsApp', website: 'site', instagram: 'Instagram', cnpj: 'CNPJ' }[
    field
  ];
  return result('nao_verificado', `Respondeu que não tem ${label}`, at);
}

/** Answers that say "do not let robots in" or "too many requests": the site exists. */
const REFUSED_STATUSES = new Set([401, 403, 407, 429, 503]);

async function websiteCheck(raw: string | null, deps: LeadCheckDeps): Promise<LeadCheck> {
  const at = deps.now();
  if (!raw) return missingCheck('website', at);
  if (declaresNone(raw)) return noneCheck('website', at);
  const url = normalizeWebsite(raw);
  if (!url) return result('nao_confere', 'Não é um endereço de site', at);
  if (!deps.probe)
    return result('nao_verificado', 'Conferência de site desligada neste ambiente', at);
  const answer = await deps.probe(url);
  switch (answer.kind) {
    case 'ok':
      return result('confere', null, deps.now());
    case 'http_error':
      return REFUSED_STATUSES.has(answer.status)
        ? result(
            'nao_verificado',
            `O site recusou a conferência automática (erro ${answer.status})`,
            deps.now(),
          )
        : result('nao_confere', `O site respondeu com erro ${answer.status}`, deps.now());
    case 'not_found':
      return result('nao_confere', 'O domínio não existe', deps.now());
    case 'blocked':
      return result('nao_confere', 'O endereço não é de um site público', deps.now());
    case 'timeout':
      return result('nao_verificado', 'O site não respondeu em 6 segundos', deps.now());
    case 'error':
      return result('nao_verificado', 'Não foi possível abrir o site', deps.now());
  }
}

async function instagramCheck(raw: string | null, deps: LeadCheckDeps): Promise<LeadCheck> {
  const at = deps.now();
  if (!raw) return missingCheck('instagram', at);
  if (declaresNone(raw)) return noneCheck('instagram', at);
  const handle = normalizeInstagram(raw);
  if (!handle) return result('nao_confere', 'Não é um @ de Instagram válido', at);
  if (!deps.instagram) {
    return result(
      'nao_verificado',
      'A consulta ao Instagram não está configurada (conta da Wings)',
      at,
    );
  }
  return deps.instagram(handle);
}

async function cnpjCheck(raw: string | null, deps: LeadCheckDeps): Promise<LeadCheck> {
  const at = deps.now();
  if (!raw) return missingCheck('cnpj', at);
  if (declaresNone(raw)) return noneCheck('cnpj', at);
  if (!isValidCnpj(raw))
    return result('nao_confere', 'Os dígitos verificadores do CNPJ não batem', at);
  if (!deps.cnpj)
    return result('nao_verificado', 'Consulta à base pública desligada neste ambiente', at);
  const answer = await deps.cnpj(raw);
  if (!answer.ok) {
    return answer.reason === 'not_found'
      ? result('nao_confere', 'CNPJ não encontrado na base pública', deps.now())
      : result('nao_verificado', 'A base pública de CNPJ não respondeu', deps.now());
  }
  const status = answer.value.registrationStatus?.toUpperCase() ?? null;
  if (status && status !== 'ATIVA') {
    return result('nao_confere', `Situação na Receita: ${status}`, deps.now());
  }
  return status
    ? result('confere', null, deps.now())
    : result('nao_verificado', 'A base pública não informou a situação', deps.now());
}

/** Every check for one lead; never throws (a failing check is "não verificado"). */
export async function checkLeadFields(lead: CheckedLead, deps: LeadCheckDeps): Promise<LeadChecks> {
  const safe = async (key: string, run: () => Promise<LeadCheck>): Promise<LeadCheck> => {
    try {
      return await run();
    } catch {
      deps.log.warn({ check: key }, 'lead check failed');
      return result('nao_verificado', 'A conferência falhou; tente de novo', deps.now());
    }
  };
  const [website, instagram, cnpj] = await Promise.all([
    safe('website', () => websiteCheck(lead.website, deps)),
    safe('instagram', () => instagramCheck(lead.instagram, deps)),
    safe('cnpj', () => cnpjCheck(lead.companyCnpj, deps)),
  ]);
  return { whatsapp: whatsappCheck(lead.phone, deps.now()), website, instagram, cnpj };
}

export async function runLeadChecks(
  db: Database,
  leadId: string,
  deps: LeadCheckDeps,
): Promise<LeadChecks | null> {
  const [lead] = await db
    .select({
      phone: leads.phone,
      website: leads.website,
      instagram: leads.instagram,
      companyCnpj: leads.companyCnpj,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return null;
  const pending: LeadChecks = Object.fromEntries(
    LEAD_CHECK_KEYS.map((key) => [key, { status: 'pendente', reason: null, checkedAt: null }]),
  );
  await db.update(leads).set({ fieldChecks: pending }).where(eq(leads.id, leadId));
  const checks = await checkLeadFields(lead, deps);
  await db.update(leads).set({ fieldChecks: checks }).where(eq(leads.id, leadId));
  deps.log.info(
    { leadId, checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v?.status])) },
    'lead checks',
  );
  return checks;
}

// --- Instagram Business Discovery ------------------------------------------------------------

const GRAPH = 'https://graph.facebook.com/v23.0';

/**
 * Business Discovery reads a public business/creator profile through Wings'
 * own Instagram business account. It cannot see personal accounts, so "not
 * found" means "not a business profile, or it does not exist": not verified,
 * never "não confere". The token goes in a header, never in a URL or a log.
 */
export function createInstagramDiscovery(deps: {
  accountId: string;
  token: string;
  fetch?: typeof fetch;
  now: () => Date;
  log: FastifyBaseLogger;
}): InstagramLookup {
  const doFetch = deps.fetch ?? fetch;
  return async (handle) => {
    const fields = `business_discovery.username(${handle}){username,media_count}`;
    const url = `${GRAPH}/${encodeURIComponent(deps.accountId)}?fields=${encodeURIComponent(fields)}`;
    let body: Record<string, unknown>;
    let status: number;
    try {
      const response = await doFetch(url, {
        headers: { authorization: `Bearer ${deps.token}` },
        signal: AbortSignal.timeout(8000),
      });
      status = response.status;
      body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      return result('nao_verificado', 'O Instagram não respondeu', deps.now());
    }
    const found = (body.business_discovery as { username?: unknown } | undefined)?.username;
    if (status === 200 && typeof found === 'string') return result('confere', null, deps.now());
    // Formats not verified live: keep the shape (key names and numbers only).
    deps.log.info({ status, shape: shapeOf(body) }, 'instagram discovery answer');
    const error = body.error as { code?: number } | undefined;
    if (error?.code === 190 || error?.code === 10 || error?.code === 200) {
      return result(
        'nao_verificado',
        'A conta da Wings não está autorizada a consultar o Instagram',
        deps.now(),
      );
    }
    if (error?.code === 4 || error?.code === 17 || error?.code === 32) {
      return result(
        'nao_verificado',
        'Limite de consultas do Instagram; tente mais tarde',
        deps.now(),
      );
    }
    return result(
      'nao_verificado',
      'Não achado como conta comercial: pode ser conta pessoal ou não existir',
      deps.now(),
    );
  };
}

// --- scheduling ------------------------------------------------------------------------------

let schedule: ((leadId: string) => void) | null = null;
let configured: LeadCheckDeps | null = null;

/** Set once by the app; tests that do not set it get no checks (and no network). */
export function configureLeadChecks(db: Database, deps: LeadCheckDeps | null) {
  configured = deps;
  schedule = deps
    ? (leadId) => {
        void runLeadChecks(db, leadId, deps).catch(() =>
          deps.log.warn({ leadId }, 'lead checks failed'),
        );
      }
    : null;
}

/** Runs the checks off the request; a no-op until configured. */
export function scheduleLeadChecks(leadId: string) {
  schedule?.(leadId);
}

/**
 * The configured checks, for "Conferir de novo"; without configuration only
 * the WhatsApp check (offline) runs and the rest say why they were skipped.
 */
export function leadCheckDepsOf(app: {
  log: FastifyBaseLogger;
  wings: { now?: () => Date };
}): LeadCheckDeps {
  return (
    configured ?? {
      probe: null,
      instagram: null,
      cnpj: null,
      now: () => app.wings.now?.() ?? new Date(),
      log: app.log,
    }
  );
}
