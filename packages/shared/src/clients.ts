import { z } from 'zod';
import { clientQuickContactSchema, cnpjField, FIT_LEVELS, REVENUE_BANDS } from './client-record.js';
import type { ExpansionEntry } from './leads.js';

/**
 * Clients: who a piece of work is for. Wings Company itself is the first one,
 * with a fixed id, so that "for us" is a row like any other and never a null.
 *
 * A minimal register on purpose (id, name, slug, active). When the CRM brings
 * its own customer records, this is the table they grow from.
 */

export const WINGS_CLIENT_ID = '00000000-0000-4000-8000-0000000000c1';
export const WINGS_CLIENT_NAME = 'Wings Company';
export const WINGS_CLIENT_SLUG = 'wings-company';

export const CLIENT_NAME_MAX = 80;

export interface Client {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  /** Where the client is looking for franchisees: states, or cities in them. */
  expansionArea: ExpansionEntry[];
  /**
   * The client's number, `NN` in `Clientes/<NN. Nome>`: the next one when the
   * client is registered, editable, never repeated. Null for Wings Company,
   * which has no client folder.
   */
  number: number | null;
  /** Formatação, Expansão or both; null on records made before it was asked. */
  relationship?: ClientRelationship | null;
  /** What the register lacks (empty when complete); for Wings Company, always empty. */
  registerMissing?: string[];
}

/** Accent- and case-blind, with every run of anything else collapsed to one space. */
const plain = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const clientSlugOf = (name: string) => plain(name).replace(/ /g, '-').slice(0, 60);

const clientNameSchema = z
  .string()
  .trim()
  .min(2, 'Informe o nome do cliente')
  .max(CLIENT_NAME_MAX)
  .refine((name) => clientSlugOf(name).length >= 2, 'Informe um nome com letras ou números');

/** What the client is to Wings: Formatação (we build its franchise), Expansão (we sell its franchise), or both. */
export const CLIENT_RELATIONSHIPS = ['formatacao', 'expansao', 'ambos'] as const;
export type ClientRelationship = (typeof CLIENT_RELATIONSHIPS)[number];
export const CLIENT_RELATIONSHIP_LABELS: Record<ClientRelationship, string> = {
  formatacao: 'Formatação',
  expansao: 'Expansão',
  ambos: 'Formatação e Expansão',
};
/** A Formatação project opens with the client only when Formatação is part of the relationship. */
export const opensFormatacaoProject = (relationship: ClientRelationship | null) =>
  relationship === 'formatacao' || relationship === 'ambos';

const required = <T>(schema: z.ZodType<T | null>, message: string) =>
  schema.refine((value) => value !== null && value !== undefined, message);

/**
 * The new register (Eric, 30/09): CNPJ (the Receita's data through BrasilAPI
 * fills the company), the main contact with e-mail and WhatsApp, the
 * relationship with Wings, and the franchise profile of the CRM plan
 * (segment, units, revenue band, franqueabilidade, fit Wings, source and date
 * of the profile). Records made before keep what they have and show what is
 * missing (`clientRegisterMissing`).
 */
export const clientCreateSchema = z.object({
  name: clientNameSchema,
  cnpj: required(cnpjField, 'Informe o CNPJ'),
  company: z.object({
    legalName: z.string().trim().min(2, 'Informe a razão social').max(200),
    tradeName: z
      .string()
      .trim()
      .max(200)
      .nullish()
      .transform((value) => value || null),
    cnaeMain: z
      .string()
      .trim()
      .max(120)
      .nullish()
      .transform((value) => value || null),
    openedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida')
      .nullish()
      .transform((value) => value || null),
    city: z
      .string()
      .trim()
      .max(120)
      .nullish()
      .transform((value) => value || null),
    state: z
      .string()
      .trim()
      .length(2)
      .toUpperCase()
      .nullish()
      .transform((value) => value || null),
  }),
  contact: clientQuickContactSchema.refine(
    (contact) => Boolean(contact.email) && Boolean(contact.whatsapp),
    'Informe e-mail e WhatsApp do contato principal',
  ),
  relationship: z.enum(CLIENT_RELATIONSHIPS, { error: 'Diga a relação com a Wings' }),
  business: z.object({
    segment: z.string().trim().min(2, 'Informe o segmento').max(120),
    ownUnits: z.number({ error: 'Informe o número de unidades' }).int().min(0).max(1_000_000),
    /** Null when the client did not say (the form asks, and "não informado" is an answer). */
    revenueBand: z.enum(REVENUE_BANDS).nullable(),
    franchisability: z.enum(FIT_LEVELS, {
      error: 'Informe a franqueabilidade (ou "Não avaliado")',
    }),
    wingsFit: z.enum(FIT_LEVELS, { error: 'Informe o fit Wings (ou "Não avaliado")' }),
    profileSource: z.string().trim().min(2, 'Diga de onde veio o dado').max(200),
    profileDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Informe a data do dado'),
  }),
});
export type ClientCreateInput = z.input<typeof clientCreateSchema>;

/** What a client's register lacks against the new register; old records show it as "Cadastro incompleto". */
export interface ClientRegisterInput {
  cnpj: string | null;
  legalName: string | null;
  tradeName: string | null;
  cnaeMain: string | null;
  openedOn: string | null;
  city: string | null;
  state: string | null;
  relationship: string | null;
  contact: { name: string | null; email: string | null; whatsapp: string | null } | null;
  business: {
    segment: string | null;
    ownUnits: number | null;
    franchisability: string | null;
    wingsFit: string | null;
    profileSource: string | null;
    profileDate: string | null;
  } | null;
}

export function clientRegisterMissing(input: ClientRegisterInput): string[] {
  const items: [string, unknown][] = [
    ['CNPJ', input.cnpj],
    ['Razão social', input.legalName],
    ['Nome fantasia', input.tradeName],
    ['CNAE principal', input.cnaeMain],
    ['Data de abertura', input.openedOn],
    ['Cidade/UF', input.city && input.state],
    ['Contato principal', input.contact?.name],
    ['E-mail do contato principal', input.contact?.email],
    ['WhatsApp do contato principal', input.contact?.whatsapp],
    ['Relação com a Wings', input.relationship],
    ['Segmento', input.business?.segment],
    ['Unidades', input.business?.ownUnits ?? null],
    ['Franqueabilidade', input.business?.franchisability],
    ['Fit Wings', input.business?.wingsFit],
    ['Fonte e data do dado', input.business?.profileSource && input.business?.profileDate],
  ];
  return items
    .filter(([, value]) => value === null || value === undefined || value === '')
    .map(([label]) => label);
}

export const CLIENT_NUMBER_MAX = 9999;

export const clientUpdateSchema = z
  .object({
    name: clientNameSchema.optional(),
    active: z.boolean().optional(),
    number: z
      .number({ error: 'Informe um número' })
      .int('Use um número inteiro')
      .min(1, 'O número começa em 1')
      .max(CLIENT_NUMBER_MAX)
      .optional(),
    relationship: z.enum(CLIENT_RELATIONSHIPS).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.active !== undefined ||
      body.number !== undefined ||
      body.relationship !== undefined,
    'Nada a alterar',
  );

/**
 * True when `text` names the client. What is generated for a client is filed
 * under the client here; the supplier that draws it never learns who it is for.
 */
export function mentionsClient(text: string, clientName: string): boolean {
  const name = plain(clientName);
  return name.length >= 2 && ` ${plain(text)} `.includes(` ${name} `);
}

//   GET   /clients            -> { clients: Client[] }  active first   marketing.media.read or clients.manage
//   POST  /clients  { name }  -> { client }                            clients.manage
//   PATCH /clients/:id { name?, active?, number? } -> { client }       clients.manage (number taken -> 409)
//   Wings Company can be neither renamed nor deactivated. Registering a client also opens its project (projects.ts).
