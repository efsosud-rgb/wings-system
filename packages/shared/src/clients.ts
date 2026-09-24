import { z } from 'zod';
import { clientQuickContactSchema, cnpjField } from './client-record.js';
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

/** "Cadastro rápido": the name, and the CNPJ and main contact when already known. */
export const clientCreateSchema = z.object({
  name: clientNameSchema,
  cnpj: cnpjField,
  contact: clientQuickContactSchema.nullish().transform((value) => value ?? null),
});

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
  })
  .refine(
    (body) => body.name !== undefined || body.active !== undefined || body.number !== undefined,
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
