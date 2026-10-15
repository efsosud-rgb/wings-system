import { normalizeInstagram } from './lead-fields.js';

/**
 * The Instagram check of a lead that sent a site form (docs/leads/instagram.md):
 * the worker looks the profile up in Meta's official Business Discovery, then in a
 * web search, and asks a cheap model whether the profile belongs to the company the
 * form named. Nothing here ever reaches the person who filled the form.
 *
 * Eric's rules (15/10/2026): "not found" is SUSPECT; it is FALSE only when the
 * profile shows up neither in Meta nor in the search. Personal accounts are not
 * visible to Meta, so Meta alone never proves a profile is fake.
 */

export const INSTAGRAM_CHECK_STATUSES = [
  'confere',
  'nao_encontrado',
  'nao_bate',
  'pendente',
  'erro',
] as const;
export type InstagramCheckStatus = (typeof INSTAGRAM_CHECK_STATUSES)[number];

/** Which step found the profile; "nenhuma" when none did (or none could decide). */
export const INSTAGRAM_CHECK_SOURCES = ['meta', 'busca', 'nenhuma'] as const;
export type InstagramCheckSource = (typeof INSTAGRAM_CHECK_SOURCES)[number];

export const INSTAGRAM_SOURCE_LABELS: Record<InstagramCheckSource, string> = {
  meta: 'API oficial da Meta',
  busca: 'busca na web',
  nenhuma: 'nenhuma fonte',
};

/** What the stats count: a profile not found is suspect, and fake when no step could see it. */
export const INSTAGRAM_VERDICTS = ['suspeito', 'falso'] as const;
export type InstagramVerdict = (typeof INSTAGRAM_VERDICTS)[number];

export const INSTAGRAM_VERDICT_LABELS: Record<InstagramVerdict, string> = {
  suspeito: 'Instagram suspeito',
  falso: 'Instagram falso',
};

/** A seller's correction, kept on the timeline. */
export const INSTAGRAM_MANUAL_VERDICTS = ['confere', 'falso'] as const;
export type InstagramManualVerdict = (typeof INSTAGRAM_MANUAL_VERDICTS)[number];

/** The list filter of Negociações. */
export const INSTAGRAM_LIST_FILTERS = ['suspeito', 'falso', 'suspeito_ou_falso'] as const;
export type InstagramListFilter = (typeof INSTAGRAM_LIST_FILTERS)[number];

export const INSTAGRAM_LIST_FILTER_LABELS: Record<InstagramListFilter, string> = {
  suspeito: 'Instagram suspeito',
  falso: 'Instagram falso',
  suspeito_ou_falso: 'Instagram suspeito ou falso',
};

/** How each step went: what decides the verdict. */
export interface InstagramCheckSteps {
  format: 'ok' | 'invalid';
  meta: 'found' | 'not_found' | 'skipped' | 'error';
  search: 'found' | 'not_found' | 'skipped' | 'refused' | 'error';
  ai: 'bate' | 'nao_bate' | 'sem_dados' | 'skipped' | 'refused' | 'error';
}

export const EMPTY_INSTAGRAM_STEPS: InstagramCheckSteps = {
  format: 'ok',
  meta: 'skipped',
  search: 'skipped',
  ai: 'skipped',
};

/**
 * Suspect or fake, from how the steps went. FALSE needs both looks to have happened and found
 * nothing: a step that was skipped, refused or failed is a look that did not happen, so the
 * profile stays merely suspect. Only a "not found" status counts; a profile that does not match
 * the company is another thing and is shown as such, not counted here.
 */
export function instagramVerdictOf(
  status: InstagramCheckStatus,
  steps: InstagramCheckSteps,
): InstagramVerdict | null {
  if (status !== 'nao_encontrado') return null;
  return steps.meta === 'not_found' && steps.search === 'not_found' ? 'falso' : 'suspeito';
}

/** The verdict the lead carries: a seller's correction wins over the machine's. */
export function effectiveInstagramVerdict(
  automatic: InstagramVerdict | null,
  manual: InstagramManualVerdict | null,
): InstagramVerdict | null {
  if (manual === 'falso') return 'falso';
  if (manual === 'confere') return null;
  return automatic;
}

/** What the lead carries, as the deal page reads it. */
export interface LeadInstagramCheck {
  status: InstagramCheckStatus;
  source: InstagramCheckSource;
  /** Null while the check is waiting for the worker. */
  checkedAt: string | null;
  /** Why the status is not "confere"; never carries the person's data. */
  reason: string | null;
  steps: InstagramCheckSteps | null;
  /** Only when Meta answered. */
  followers: number | null;
  posts: number | null;
  /** The machine's verdict (suspect / fake), before any correction. */
  verdict: InstagramVerdict | null;
  /** What a seller set by hand, with when; null when nobody did. */
  manual: { verdict: InstagramManualVerdict; at: string } | null;
  /** What the lists and stats use: the correction when there is one. */
  effectiveVerdict: InstagramVerdict | null;
  /** `https://www.instagram.com/<handle>/`, or null when the form's text is not a handle. */
  profileUrl: string | null;
}

export function instagramProfileUrl(raw: string | null | undefined): string | null {
  const handle = raw ? normalizeInstagram(raw) : null;
  return handle ? `https://www.instagram.com/${handle}/` : null;
}

/** The words on the deal page for one check. */
export function instagramCheckLabelOf(check: LeadInstagramCheck): string {
  if (check.manual?.verdict === 'falso') return 'Falso (marcado por uma pessoa)';
  if (check.manual?.verdict === 'confere') return 'Confere (corrigido por uma pessoa)';
  switch (check.status) {
    case 'confere':
      return 'Confere';
    case 'nao_bate':
      return 'Não bate com a empresa';
    case 'pendente':
      return 'Conferindo…';
    case 'erro':
      return 'Não conferido';
    case 'nao_encontrado':
      return check.verdict === 'falso' ? 'Falso' : 'Não encontrado · suspeito';
  }
}

/** The reasons are fixed texts, so the same words show on the page and in the log. */
export const INSTAGRAM_REASONS = {
  invalidFormat: 'O texto não é um usuário de Instagram (1 a 30 letras, números, ponto ou sublinhado)',
  notFoundMeta: 'Não achado pela API da Meta (conta pessoal ou inexistente)',
  notFoundBoth: 'O perfil não apareceu na API da Meta nem na busca na web',
  notFoundSearchOnly: 'O perfil não apareceu na busca na web; a API da Meta não conferiu',
  notFoundMetaOnly: 'O perfil não apareceu na API da Meta; a busca na web não conferiu',
  noProvider: 'Nenhuma fonte de conferência está configurada neste ambiente',
  providersFailed: 'As fontes não responderam; tente de novo',
  ceiling: 'O teto diário da conferência foi atingido; nenhuma chamada paga foi feita',
  noMatch: 'O perfil existe, mas nome, bio ou site não batem com a empresa do formulário',
  compareFailed: 'O perfil existe; a comparação com a empresa não rodou',
} as const;
