/**
 * The five fields every lead form asks (Instagram, Site, Nome da empresa,
 * Nome, WhatsApp), plus the CNPJ when a form asks it, lifted out of the form
 * answers into their own place on the lead. Forms differ by platform and by
 * campaign, so the mapping is by the text of the question (or the platform's
 * field key), accent- and case-insensitive.
 *
 * The checks done on arrival also live here when they need no network
 * (WhatsApp's area code and mobile shape, the CNPJ's check digits); the
 * networked ones (site answering, Instagram existing, CNPJ in the public
 * register) run in the API and only report their result in this shape.
 */

export const LEAD_FIELD_KEYS = [
  'name',
  'whatsapp',
  'instagram',
  'website',
  'companyName',
  'cnpj',
] as const;
export type LeadFieldKey = (typeof LEAD_FIELD_KEYS)[number];

export const LEAD_FIELD_LABELS: Record<LeadFieldKey, string> = {
  name: 'Nome',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  website: 'Site',
  companyName: 'Nome da empresa',
  cnpj: 'CNPJ',
};

export type LeadFields = Partial<Record<LeadFieldKey, string>>;

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9@]+/g, ' ')
    .trim();

/**
 * Which field a question (or a platform field key such as `full_name`,
 * `phone_number`, `company_name`) asks for. Order matters: "Nome da empresa"
 * is the company, not the person; "@ do Instagram" is not a site.
 */
export function leadFieldOfQuestion(question: string): LeadFieldKey | null {
  const q = fold(question.replace(/_/g, ' '));
  if (!q) return null;
  if (/\bcnpj\b/.test(q)) return 'cnpj';
  if (/\b(instagram|insta)\b|@ do insta|\big\b/.test(q)) return 'instagram';
  // "Site da empresa" is the site: the site word wins over the company word.
  if (/\b(site|website|web site|url|pagina|endereco eletronico)\b/.test(q)) return 'website';
  if (
    /\b(nome da empresa|nome do negocio|nome fantasia|razao social|empresa|company( name)?|negocio|marca)\b/.test(
      q,
    )
  ) {
    return 'companyName';
  }
  if (/\b(whats ?app|whats|zap|celular|telefone|fone|phone( number)?|contato)\b/.test(q))
    return 'whatsapp';
  if (
    /^(nome|seu nome|qual (e )?(o )?seu nome|nome completo|full name|first name|name)\b/.test(q)
  ) {
    return 'name';
  }
  return null;
}

/** First answer for each field; empty answers do not count. */
export function extractLeadFields(
  answers: { question: string; answer: string | null }[],
): LeadFields {
  const fields: LeadFields = {};
  for (const { question, answer } of answers) {
    const key = leadFieldOfQuestion(question);
    const value = (answer ?? '').trim();
    if (!key || !value || fields[key]) continue;
    fields[key] = value.slice(0, 300);
  }
  return fields;
}

// --- normalisation ---------------------------------------------------------------------------

/** `@Wings.Company`, `instagram.com/wings.company/` → `wings.company`; null when it cannot be a handle. */
export function normalizeInstagram(value: string): string | null {
  let text = value.trim().toLowerCase();
  const url = text.match(/instagr(?:am\.com|\.am)\/([^/?#\s]+)/);
  if (url?.[1]) text = url[1];
  text = text.replace(/^@+/, '').replace(/\/+$/, '');
  return /^[a-z0-9._]{1,30}$/.test(text) && !/^\.|\.$|\.\./.test(text) ? text : null;
}

/** `wingscompany.com.br` → `https://wingscompany.com.br/`; null when it is not a public web address. */
export function normalizeWebsite(value: string): string | null {
  const text = value.trim();
  if (!text || /\s/.test(text) || /instagr(am\.com|\.am)\//i.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname)) return null;
    if (/^\d+(\.\d+){3}$/.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export const CNPJ_LENGTH = 14;

export function cnpjDigits(value: string): string {
  return value.replace(/\D/g, '');
}

/** The two check digits of a CNPJ. */
export function isValidCnpj(value: string): boolean {
  const digits = cnpjDigits(value);
  if (digits.length !== CNPJ_LENGTH || /^(\d)\1+$/.test(digits)) return false;
  const check = (length: number) => {
    const weights =
      length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, weight, i) => acc + Number(digits[i]) * weight, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === Number(digits[12]) && check(13) === Number(digits[13]);
}

// --- WhatsApp ---------------------------------------------------------------------------------

/** Brazilian area codes in use (Anatel), 67 of them. */
export const BR_AREA_CODES: ReadonlySet<string> = new Set([
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '21',
  '22',
  '24',
  '27',
  '28',
  '31',
  '32',
  '33',
  '34',
  '35',
  '37',
  '38',
  '41',
  '42',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '53',
  '54',
  '55',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '68',
  '69',
  '71',
  '73',
  '74',
  '75',
  '77',
  '79',
  '81',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  '91',
  '92',
  '93',
  '94',
  '95',
  '96',
  '97',
  '98',
  '99',
]);

/** Digits of a Brazilian number without the country code and the trunk 0. */
export function brazilianNumber(value: string): string {
  let digits = value.replace(/\D/g, '');
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55'))
    digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

// --- checks -----------------------------------------------------------------------------------

export const LEAD_CHECK_STATUSES = [
  'confere',
  'nao_confere',
  'nao_verificado',
  'pendente',
] as const;
export type LeadCheckStatus = (typeof LEAD_CHECK_STATUSES)[number];

export const LEAD_CHECK_LABELS: Record<LeadCheckStatus, string> = {
  confere: 'Confere',
  nao_confere: 'Não confere',
  nao_verificado: 'Não verificado',
  pendente: 'Conferindo…',
};

export interface LeadCheck {
  status: LeadCheckStatus;
  /** Always said when the status is not "confere"; never contains the lead's data. */
  reason: string | null;
  checkedAt: string | null;
}

export const LEAD_CHECK_KEYS = ['whatsapp', 'website', 'instagram', 'cnpj'] as const;
export type LeadCheckKey = (typeof LEAD_CHECK_KEYS)[number];
export type LeadChecks = Partial<Record<LeadCheckKey, LeadCheck>>;

/** The WhatsApp check needs no network: a Brazilian area code in use and a mobile number. */
export function whatsappCheck(value: string | null | undefined, at: Date): LeadCheck {
  const checkedAt = at.toISOString();
  if (!value?.trim())
    return { status: 'nao_verificado', reason: 'O formulário não trouxe WhatsApp', checkedAt };
  const raw = value.replace(/\D/g, '');
  if (raw.length > 13 || (raw.length >= 12 && !raw.startsWith('55') && !raw.startsWith('0'))) {
    return {
      status: 'nao_verificado',
      reason: 'Número de fora do Brasil: só números do Brasil são conferidos',
      checkedAt,
    };
  }
  const digits = brazilianNumber(value);
  if (digits.length !== 10 && digits.length !== 11) {
    return {
      status: 'nao_confere',
      reason: 'Quantidade de dígitos não é de um número do Brasil',
      checkedAt,
    };
  }
  if (!BR_AREA_CODES.has(digits.slice(0, 2))) {
    return { status: 'nao_confere', reason: 'DDD inexistente', checkedAt };
  }
  if (digits.length === 10) {
    return {
      status: 'nao_confere',
      reason: 'Número fixo: o WhatsApp precisa de celular',
      checkedAt,
    };
  }
  if (digits[2] !== '9') {
    return {
      status: 'nao_confere',
      reason: 'Celular do Brasil começa com 9 depois do DDD',
      checkedAt,
    };
  }
  return { status: 'confere', reason: null, checkedAt };
}

/** A field the form did not bring: "—" on screen, with this reason. */
export function missingCheck(field: LeadCheckKey, at: Date): LeadCheck {
  const label = { whatsapp: 'WhatsApp', website: 'site', instagram: 'Instagram', cnpj: 'CNPJ' }[
    field
  ];
  return {
    status: 'nao_verificado',
    reason: `O formulário não trouxe ${label}`,
    checkedAt: at.toISOString(),
  };
}
