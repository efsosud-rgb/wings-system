import { z } from 'zod';
import { isValidCnpj, normalizeCep, normalizeCnpj } from './cnpj.js';
import { isValidCpf, normalizeCpf } from './cpf.js';
import { BRAZIL_UFS, type ExpansionEntry } from './leads.js';
import type { Client } from './clients.js';
import type { SectorSlug } from './rbac/sectors.js';

/**
 * The client's full record ("ficha"): the company, its partners, the project
 * contacts, the business today, the contract with Wings, the franchise being
 * planned and how documents get signed. Clients are companies being formatted
 * into franchisors; this record is what Jurídico's contracts and the COF
 * (Lei 13.966/2019) are filled from.
 *
 * Every field may be empty: the record fills up over weeks, and
 * `clientCompleteness` says how far along it is. Money is in centavos.
 *
 * CPF, marital status and property regime are sensitive (`CLIENT_SENSITIVE_FIELDS`):
 * only `clients.sensitive` sees or writes them, and the CPF is masked until
 * revealed, one audited reveal at a time.
 */

// --- vocabularies ----------------------------------------------------------------

export const TAX_REGIMES = [
  'simples_nacional',
  'lucro_presumido',
  'lucro_real',
  'mei',
  'imune_isenta',
  'outro',
] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];
export const TAX_REGIME_LABELS: Record<TaxRegime, string> = {
  simples_nacional: 'Simples Nacional',
  lucro_presumido: 'Lucro Presumido',
  lucro_real: 'Lucro Real',
  mei: 'MEI',
  imune_isenta: 'Imune/Isenta',
  outro: 'Outro',
};

export const MARITAL_STATUSES = [
  'solteiro',
  'casado',
  'uniao_estavel',
  'separado',
  'divorciado',
  'viuvo',
] as const;
export type MaritalStatus = (typeof MARITAL_STATUSES)[number];
export const MARITAL_STATUS_LABELS: Record<MaritalStatus, string> = {
  solteiro: 'Solteiro(a)',
  casado: 'Casado(a)',
  uniao_estavel: 'União estável',
  separado: 'Separado(a) judicialmente',
  divorciado: 'Divorciado(a)',
  viuvo: 'Viúvo(a)',
};
/** The statuses a property regime belongs to. */
export const MARITAL_STATUSES_WITH_REGIME: readonly MaritalStatus[] = ['casado', 'uniao_estavel'];

export const PROPERTY_REGIMES = [
  'comunhao_parcial',
  'comunhao_universal',
  'separacao_total',
  'separacao_obrigatoria',
  'participacao_final_aquestos',
] as const;
export type PropertyRegime = (typeof PROPERTY_REGIMES)[number];
export const PROPERTY_REGIME_LABELS: Record<PropertyRegime, string> = {
  comunhao_parcial: 'Comunhão parcial de bens',
  comunhao_universal: 'Comunhão universal de bens',
  separacao_total: 'Separação total de bens',
  separacao_obrigatoria: 'Separação obrigatória de bens',
  participacao_final_aquestos: 'Participação final nos aquestos',
};

export const CLIENT_CONTACT_ROLES = ['principal', 'financeiro', 'marketing'] as const;
export type ClientContactRole = (typeof CLIENT_CONTACT_ROLES)[number];
export const CLIENT_CONTACT_ROLE_LABELS: Record<ClientContactRole, string> = {
  principal: 'Responsável principal',
  financeiro: 'Financeiro',
  marketing: 'Marketing',
};

export const REVENUE_BANDS = [
  'ate_360k',
  'de_360k_a_4_8m',
  'de_4_8m_a_10m',
  'de_10m_a_30m',
  'acima_30m',
] as const;
export type RevenueBand = (typeof REVENUE_BANDS)[number];
export const REVENUE_BAND_LABELS: Record<RevenueBand, string> = {
  ate_360k: 'Até R$ 360 mil/ano',
  de_360k_a_4_8m: 'R$ 360 mil a R$ 4,8 milhões/ano',
  de_4_8m_a_10m: 'R$ 4,8 a R$ 10 milhões/ano',
  de_10m_a_30m: 'R$ 10 a R$ 30 milhões/ano',
  acima_30m: 'Acima de R$ 30 milhões/ano',
};

export const INPI_STATUSES = [
  'nao_depositada',
  'depositada',
  'em_exame',
  'registrada',
  'indeferida',
  'arquivada',
] as const;
export type InpiStatus = (typeof INPI_STATUSES)[number];
export const INPI_STATUS_LABELS: Record<InpiStatus, string> = {
  nao_depositada: 'Não depositada',
  depositada: 'Depositada',
  em_exame: 'Em exame',
  registrada: 'Registrada',
  indeferida: 'Indeferida',
  arquivada: 'Arquivada',
};

export const SIGNATURE_TYPES = ['eletronica_simples', 'icp_brasil'] as const;
export type SignatureType = (typeof SIGNATURE_TYPES)[number];
export const SIGNATURE_TYPE_LABELS: Record<SignatureType, string> = {
  eletronica_simples: 'Eletrônica simples',
  icp_brasil: 'Certificado ICP-Brasil',
};

/**
 * The Formatação areas a contract names a consultant for: the sub-sectors of
 * `formatacao` (a test keeps this list and SECTORS in step).
 */
export const CONSULTANT_AREAS = [
  'formatacao-juridico',
  'formatacao-financeiro',
  'formatacao-processos-projetos',
  'formatacao-contabil-tributario',
  'formatacao-logistica',
  'formatacao-ti',
] as const satisfies readonly SectorSlug[];
export type ConsultantArea = (typeof CONSULTANT_AREAS)[number];

export const SOCIAL_NETWORKS = ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube'] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

/** Written only by `clients.sensitive`; hidden from everyone else. */
export const CLIENT_SENSITIVE_FIELDS = ['cpf', 'maritalStatus', 'propertyRegime'] as const;

export const CLIENT_MAX_PARTNERS = 20;
export const CLIENT_MAX_UNIT_MODELS = 10;
export const CLIENT_MAX_CONTRACTS = 10;
export const CLIENT_MAX_WITNESSES = 2;

// --- field schemas -----------------------------------------------------------------

/** Optional text: trimmed, empty becomes null. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use no máximo ${max} caracteres`)
    .nullish()
    .transform((value) => (value ? value : null));

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .nullish()
  .transform((value) => (value ? value : null))
  .refine((value) => value === null || z.email().safeParse(value).success, 'E-mail inválido');

/** Brazilian phone: digits only, 10 or 11 with the DDD, a leading 55 dropped. */
const phone = z
  .string()
  .nullish()
  .transform((value) => {
    const digits = (value ?? '').replace(/\D/g, '');
    return digits.length === 13 && digits.startsWith('55') ? digits.slice(2) : digits || null;
  })
  .refine((value) => value === null || /^\d{10,11}$/.test(value), 'Telefone com DDD, 10 ou 11 dígitos');

const cents = z
  .number({ error: 'Informe um valor' })
  .int()
  .min(0, 'O valor não pode ser negativo')
  .max(1e13)
  .nullish()
  .transform((value) => value ?? null);

const count = z
  .number({ error: 'Informe um número' })
  .int('Use um número inteiro')
  .min(0)
  .max(1_000_000)
  .nullish()
  .transform((value) => value ?? null);

const percent = z
  .number({ error: 'Informe um percentual' })
  .min(0, 'De 0 a 100')
  .max(100, 'De 0 a 100')
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : Math.round(value * 100) / 100));

const day = z
  .string()
  .nullish()
  .transform((value) => (value ? value : null))
  .refine(
    (value) => value === null || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value))),
    'Data inválida',
  );

const oneOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .enum(values)
    .nullish()
    .transform((value) => value ?? null);

export const clientAddressSchema = z.object({
  cep: z
    .string()
    .nullish()
    .transform((value) => (value ? normalizeCep(value) : null))
    .refine((value) => value === null || /^\d{8}$/.test(value), 'CEP com 8 dígitos'),
  street: text(160),
  number: text(20),
  complement: text(80),
  district: text(80),
  city: text(80),
  state: oneOf(BRAZIL_UFS),
});
export type ClientAddress = z.output<typeof clientAddressSchema>;

export const EMPTY_ADDRESS: ClientAddress = {
  cep: null,
  street: null,
  number: null,
  complement: null,
  district: null,
  city: null,
  state: null,
};

const address = clientAddressSchema.nullish().transform((value) => value ?? EMPTY_ADDRESS);

export const cnpjField = z
  .string()
  .nullish()
  .transform((value) => (value ? normalizeCnpj(value) : null))
  .refine((value) => value === null || isValidCnpj(value), 'CNPJ inválido');

const cpfField = z
  .string()
  .nullable()
  .optional()
  .transform((value) => (value === undefined ? undefined : value ? normalizeCpf(value) : null))
  .refine((value) => value === undefined || value === null || isValidCpf(value), 'CPF inválido');

// --- 1. Empresa ----------------------------------------------------------------------

export const clientCompanySchema = z.object({
  legalName: text(200),
  tradeName: text(200),
  cnpj: cnpjField,
  stateRegistration: text(30),
  municipalRegistration: text(30),
  openedOn: day,
  legalNature: text(120),
  taxRegime: oneOf(TAX_REGIMES),
  /** `9430-8/00`, the main activity. */
  cnaeMain: text(120),
  cnaeSecondary: z
    .array(z.string().trim().min(1).max(120))
    .max(30)
    .nullish()
    .transform((value) => value ?? []),
  shareCapitalCents: cents,
  address,
  phone,
  email,
  website: text(200),
  social: z
    .partialRecord(z.enum(SOCIAL_NETWORKS), z.string().trim().max(200))
    .nullish()
    .transform((value) =>
      Object.fromEntries(Object.entries(value ?? {}).filter(([, handle]) => handle)),
    ),
});
export type ClientCompany = z.output<typeof clientCompanySchema>;
export type ClientCompanyInput = z.input<typeof clientCompanySchema>;

// --- 2. Sócios ------------------------------------------------------------------------

/**
 * A partner, written. The sensitive fields follow `undefined` = keep what is
 * stored, `null` = clear it, a value = set it; anyone without
 * `clients.sensitive` who sends one of them is refused.
 */
export const clientPartnerInputSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome').max(200),
  cpf: cpfField,
  rg: text(30),
  rgIssuer: text(30),
  nationality: text(60),
  profession: text(80),
  maritalStatus: z.enum(MARITAL_STATUSES).nullable().optional(),
  propertyRegime: z.enum(PROPERTY_REGIMES).nullable().optional(),
  address,
  email,
  mobile: phone,
  sharePercent: percent,
  signsForCompany: z.boolean().default(false),
});
export type ClientPartnerInput = z.input<typeof clientPartnerInputSchema>;

/** A partner, read. Sensitive fields are null for who may not see them (`restricted`). */
export interface ClientPartner {
  id: string;
  position: number;
  name: string;
  /** `***.456.789-**`, or null when there is none or it is restricted. */
  cpfMasked: string | null;
  cpfOnFile: boolean;
  rg: string | null;
  rgIssuer: string | null;
  nationality: string | null;
  profession: string | null;
  maritalStatus: MaritalStatus | null;
  propertyRegime: PropertyRegime | null;
  address: ClientAddress;
  email: string | null;
  mobile: string | null;
  sharePercent: number | null;
  signsForCompany: boolean;
  /** True when the sensitive fields were withheld from this reader. */
  restricted: boolean;
}

// --- 3. Contatos do projeto -----------------------------------------------------------

export const clientContactSchema = z.object({
  role: z.enum(CLIENT_CONTACT_ROLES),
  name: z.string().trim().min(2, 'Informe o nome').max(200),
  jobTitle: text(80),
  email,
  whatsapp: phone,
});
export type ClientContact = z.output<typeof clientContactSchema>;

export const clientContactsSchema = z.object({
  contacts: z
    .array(clientContactSchema)
    .max(CLIENT_CONTACT_ROLES.length)
    .refine(
      (list) => new Set(list.map((contact) => contact.role)).size === list.length,
      'Um contato por papel',
    ),
});

// --- 4. Negócio atual -------------------------------------------------------------------

export const clientBusinessSchema = z.object({
  segment: text(120),
  description: text(2000),
  operatingYears: count,
  ownUnits: count,
  revenueBand: oneOf(REVENUE_BANDS),
  averageTicketCents: cents,
  employeesCount: count,
  inpiProcess: text(30),
  inpiClass: text(30),
  inpiStatus: oneOf(INPI_STATUSES),
});
export type ClientBusiness = z.output<typeof clientBusinessSchema>;

// --- 5. Contrato com a Wings -------------------------------------------------------------

export const clientContractSchema = z.object({
  /** Present when the contract already exists; absent for a new one. */
  id: z.uuid().optional(),
  service: z.string().trim().min(2, 'Informe o serviço contratado').max(200),
  number: text(40),
  signedOn: day,
  valueCents: cents,
  paymentMethod: text(120),
  installments: z
    .number()
    .int()
    .min(1)
    .max(120)
    .nullish()
    .transform((value) => value ?? null),
  startsOn: day,
  termMonths: z
    .number()
    .int()
    .min(1)
    .max(240)
    .nullish()
    .transform((value) => value ?? null),
  /** The CRM lead the client came from. */
  leadId: z
    .uuid()
    .nullish()
    .transform((value) => value ?? null),
  /** One employee per Formatação area; the API checks they are active and work in that area. */
  consultants: z
    .partialRecord(z.enum(CONSULTANT_AREAS), z.uuid().nullable())
    .nullish()
    .transform((value) =>
      Object.fromEntries(Object.entries(value ?? {}).filter(([, id]) => id)) as Partial<
        Record<ConsultantArea, string>
      >,
    ),
});
export type ClientContractInput = z.input<typeof clientContractSchema>;
export type ClientContract = Omit<z.output<typeof clientContractSchema>, 'id'> & { id: string };

export const clientContractsSchema = z.object({
  contracts: z.array(clientContractSchema).max(CLIENT_MAX_CONTRACTS),
});

// --- 6. Franquia planejada ---------------------------------------------------------------

export const clientUnitModelSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do modelo').max(120),
  description: text(1000),
  initialInvestmentCents: cents,
  franchiseFeeCents: cents,
  areaM2: count,
});
export type ClientUnitModel = z.output<typeof clientUnitModelSchema>;

export const clientFranchiseSchema = z.object({
  franchiseFeeCents: cents,
  royaltiesPercent: percent,
  adFundPercent: percent,
  initialInvestmentCents: cents,
  franchiseeProfile: text(2000),
  unitModels: z
    .array(clientUnitModelSchema)
    .max(CLIENT_MAX_UNIT_MODELS)
    .nullish()
    .transform((value) => value ?? []),
});
export type ClientFranchise = z.output<typeof clientFranchiseSchema>;

// --- 7. Assinatura -----------------------------------------------------------------------

export const clientWitnessInputSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(2, 'Informe o nome da testemunha').max(200),
  cpf: cpfField,
  email,
});

export const clientSignatureSchema = z.object({
  /** Which partner signs for the company. */
  signerPartnerId: z
    .uuid()
    .nullish()
    .transform((value) => value ?? null),
  signingEmail: email,
  signingMobile: phone,
  signatureType: oneOf(SIGNATURE_TYPES),
  /** "Comarca de São Paulo/SP". */
  forum: text(120),
  witnesses: z
    .array(clientWitnessInputSchema)
    .max(CLIENT_MAX_WITNESSES)
    .nullish()
    .transform((value) => value ?? []),
});
export type ClientSignatureInput = z.input<typeof clientSignatureSchema>;

export interface ClientWitness {
  id: string;
  name: string;
  cpfMasked: string | null;
  cpfOnFile: boolean;
  email: string | null;
}

export interface ClientSignature {
  signerPartnerId: string | null;
  signingEmail: string | null;
  signingMobile: string | null;
  signatureType: SignatureType | null;
  forum: string | null;
  witnesses: ClientWitness[];
}

// --- quick registration ---------------------------------------------------------------------

/** "Cadastro rápido": a name, and when known the CNPJ and the main contact. */
export const clientQuickContactSchema = clientContactSchema.omit({ role: true });

// --- the whole record --------------------------------------------------------------------------

export interface ClientRecord {
  client: Client;
  company: ClientCompany;
  partners: ClientPartner[];
  contacts: ClientContact[];
  business: ClientBusiness;
  contracts: ClientContract[];
  franchise: ClientFranchise;
  signature: ClientSignature;
  completeness: ClientCompleteness;
  /** `Clientes/<NN. Nome>/Documentos Enviados`, opened in the Drive by id. */
  documentsFolderId: string | null;
  access: { canEdit: boolean; canSeeSensitive: boolean };
  /** Active employees of each Formatação area, for the contract's consultants. */
  consultantOptions: Record<ConsultantArea, { id: string; name: string }[]>;
  /** The client's leads, only for who may read leads. */
  leadOptions: { id: string; label: string }[] | null;
}

// --- % preenchido ------------------------------------------------------------------------------

export const CLIENT_RECORD_BLOCKS = [
  'empresa',
  'socios',
  'contatos',
  'negocio',
  'contrato',
  'franquia',
  'assinatura',
] as const;
export type ClientRecordBlock = (typeof CLIENT_RECORD_BLOCKS)[number];
export const CLIENT_RECORD_BLOCK_LABELS: Record<ClientRecordBlock, string> = {
  empresa: 'Empresa',
  socios: 'Sócios',
  contatos: 'Contatos',
  negocio: 'Negócio atual',
  contrato: 'Contrato',
  franquia: 'Franquia planejada',
  assinatura: 'Assinatura',
};

export interface ClientCompleteness {
  percent: number;
  blocks: { block: ClientRecordBlock; filled: number; total: number; missing: string[] }[];
}

/**
 * What completeness needs to see: the record as the server holds it, with the
 * sensitive fields present (a reader without access still gets a true %).
 */
export interface ClientCompletenessInput {
  company: ClientCompany;
  partners: (Pick<
    ClientPartner,
    | 'name'
    | 'rg'
    | 'nationality'
    | 'profession'
    | 'address'
    | 'email'
    | 'mobile'
    | 'sharePercent'
    | 'signsForCompany'
  > & { cpfOnFile: boolean; maritalStatus: MaritalStatus | null; propertyRegime: PropertyRegime | null })[];
  contacts: ClientContact[];
  business: ClientBusiness;
  contracts: ClientContract[];
  franchise: ClientFranchise;
  signature: ClientSignature;
  expansionArea: ExpansionEntry[];
}

const addressComplete = (value: ClientAddress) =>
  Boolean(value.cep && value.street && value.number && value.city && value.state);

/**
 * "% preenchido": every item that a contract or the COF needs, counted once.
 * Optional fields (IE, IM, site, redes, complemento) are not counted.
 */
export function clientCompleteness(record: ClientCompletenessInput): ClientCompleteness {
  const blocks: ClientCompleteness['blocks'] = [];
  const check = (block: ClientRecordBlock, items: [string, boolean][]) => {
    blocks.push({
      block,
      filled: items.filter(([, ok]) => ok).length,
      total: items.length,
      missing: items.filter(([, ok]) => !ok).map(([label]) => label),
    });
  };

  const c = record.company;
  check('empresa', [
    ['Razão social', Boolean(c.legalName)],
    ['Nome fantasia', Boolean(c.tradeName)],
    ['CNPJ', Boolean(c.cnpj)],
    ['Data de abertura', Boolean(c.openedOn)],
    ['Natureza jurídica', Boolean(c.legalNature)],
    ['Regime tributário', Boolean(c.taxRegime)],
    ['CNAE principal', Boolean(c.cnaeMain)],
    ['Capital social', c.shareCapitalCents !== null],
    ['Endereço completo', addressComplete(c.address)],
    ['Telefone', Boolean(c.phone)],
    ['E-mail', Boolean(c.email)],
  ]);

  const partnerItems: [string, boolean][] = [['Ao menos um sócio', record.partners.length > 0]];
  record.partners.forEach((p, index) => {
    const who = `Sócio ${index + 1}`;
    partnerItems.push(
      [`${who}: CPF`, p.cpfOnFile],
      [`${who}: RG`, Boolean(p.rg)],
      [`${who}: nacionalidade`, Boolean(p.nationality)],
      [`${who}: profissão`, Boolean(p.profession)],
      [`${who}: estado civil`, Boolean(p.maritalStatus)],
      [`${who}: endereço completo`, addressComplete(p.address)],
      [`${who}: e-mail`, Boolean(p.email)],
      [`${who}: celular`, Boolean(p.mobile)],
      [`${who}: % de participação`, p.sharePercent !== null],
    );
    if (p.maritalStatus && MARITAL_STATUSES_WITH_REGIME.includes(p.maritalStatus)) {
      partnerItems.push([`${who}: regime de bens`, Boolean(p.propertyRegime)]);
    }
  });
  if (record.partners.length > 0) {
    const shares = record.partners.reduce((sum, p) => sum + (p.sharePercent ?? 0), 0);
    partnerItems.push(
      ['Participações somam 100%', Math.abs(shares - 100) < 0.01],
      ['Quem assina pela empresa', record.partners.some((p) => p.signsForCompany)],
    );
  }
  check('socios', partnerItems);

  check(
    'contatos',
    CLIENT_CONTACT_ROLES.map((role) => {
      const contact = record.contacts.find((item) => item.role === role);
      return [
        `${CLIENT_CONTACT_ROLE_LABELS[role]} (nome, e-mail e WhatsApp)`,
        Boolean(contact?.name && contact.email && contact.whatsapp),
      ];
    }),
  );

  const b = record.business;
  const deposited = b.inpiStatus !== null && b.inpiStatus !== 'nao_depositada';
  check('negocio', [
    ['Segmento', Boolean(b.segment)],
    ['Descrição', Boolean(b.description)],
    ['Tempo de operação', b.operatingYears !== null],
    ['Unidades próprias', b.ownUnits !== null],
    ['Faixa de faturamento', Boolean(b.revenueBand)],
    ['Ticket médio', b.averageTicketCents !== null],
    ['Nº de funcionários', b.employeesCount !== null],
    ['Situação da marca no INPI', Boolean(b.inpiStatus)],
    ...(deposited
      ? ([
          ['Nº do processo no INPI', Boolean(b.inpiProcess)],
          ['Classe no INPI', Boolean(b.inpiClass)],
        ] as [string, boolean][])
      : []),
  ]);

  const contract = record.contracts[0];
  check('contrato', [
    ['Serviço contratado', Boolean(contract?.service)],
    ['Nº do contrato', Boolean(contract?.number)],
    ['Data do contrato', Boolean(contract?.signedOn)],
    ['Valor', contract?.valueCents !== null && contract?.valueCents !== undefined],
    ['Forma de pagamento', Boolean(contract?.paymentMethod)],
    ['Início', Boolean(contract?.startsOn)],
    ['Prazo', Boolean(contract?.termMonths)],
    ['Consultor de alguma área', Object.keys(contract?.consultants ?? {}).length > 0],
  ]);

  const f = record.franchise;
  check('franquia', [
    ['Ao menos um modelo de unidade', f.unitModels.length > 0],
    ['Taxa de franquia', f.franchiseFeeCents !== null],
    ['Royalties', f.royaltiesPercent !== null],
    ['Fundo de propaganda', f.adFundPercent !== null],
    ['Investimento inicial', f.initialInvestmentCents !== null],
    ['Perfil do franqueado', Boolean(f.franchiseeProfile)],
    ['Área de expansão', record.expansionArea.length > 0],
  ]);

  const s = record.signature;
  check('assinatura', [
    ['Quem assina', Boolean(s.signerPartnerId)],
    ['E-mail de assinatura', Boolean(s.signingEmail)],
    ['Celular de assinatura', Boolean(s.signingMobile)],
    ['Tipo de assinatura', Boolean(s.signatureType)],
    ['Foro', Boolean(s.forum)],
    ['Duas testemunhas com CPF', s.witnesses.filter((w) => w.cpfOnFile).length >= CLIENT_MAX_WITNESSES],
  ]);

  const filled = blocks.reduce((sum, block) => sum + block.filled, 0);
  const total = blocks.reduce((sum, block) => sum + block.total, 0);
  return { percent: total === 0 ? 0 : Math.floor((filled / total) * 100), blocks };
}
