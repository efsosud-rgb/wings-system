import {
  WINGS_CLIENT_ID,
  declaresNone,
  type SofiaFieldTarget,
  type SofiaSettings,
} from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leads } from '../../db/schema/index.js';
import type { SofiaFacts } from './state.js';

/**
 * What Sofia knows when a conversation is tied to the lead a site form made (docs/whatsapp/sofia.md):
 * the answers the form already brought go in as hers, so she does not ask them again, and the
 * greeting uses the person's first name. Only the form's own text reaches her: no check result,
 * no research, nothing the person was not shown.
 */

/** Said instead of the settings' greeting when the form already told who the person is. */
export const SOFIA_FORM_GREETING =
  'Olá, {nome}! Eu sou a Sofia, atendente virtual {quem}. Recebi o seu contato pelo formulário e só vou confirmar o que faltou.';

export const formGreetingOf = (name: string | null): string =>
  name
    ? SOFIA_FORM_GREETING.replace('{nome}', name)
    : SOFIA_FORM_GREETING.replace('Olá, {nome}!', 'Olá!');

const firstNameOf = (name: string | null | undefined): string | null => {
  const first = name?.trim().split(/\s+/)[0] ?? '';
  return first.length >= 2 ? first.slice(0, 40) : null;
};

/** The facts a form-tied conversation starts with, or null when the lead has no funnel to pick questions from. */
export async function formContextOf(
  db: Database,
  leadId: string,
  settings: SofiaSettings,
): Promise<Pick<
  SofiaFacts,
  'answers' | 'formKnown' | 'formName' | 'formPage' | 'formAnswers' | 'brandConfirmed'
> | null> {
  const lead = await db.query.leads.findFirst({
    where: eq(leads.id, leadId),
    columns: {
      name: true,
      companyName: true,
      instagram: true,
      website: true,
      city: true,
      pipeline: true,
      clientId: true,
      landingPage: true,
      formAnswers: true,
    },
  });
  if (!lead || (lead.pipeline !== 'expansao' && lead.pipeline !== 'formatacao')) return null;
  const questions = lead.pipeline === 'expansao' ? settings.expansao : settings.formatacao;
  const given: Record<SofiaFieldTarget, string | null> = {
    name: lead.name,
    companyName: lead.companyName,
    // "Não tenho" is an answer: Sofia keeps it as hers ("Não tem") rather than asking again.
    instagram: lead.instagram && declaresNone(lead.instagram) ? 'Não tem' : lead.instagram,
    website: lead.website && declaresNone(lead.website) ? 'Não tem' : lead.website,
    city: lead.city,
  };
  const answers: Record<string, string> = {};
  for (const question of questions) {
    if (!question.field || question.kind === 'choice') continue;
    const value = given[question.field]?.trim();
    if (value) answers[question.key] = value.slice(0, 300);
  }
  const formAnswers = Object.fromEntries(
    Object.entries((lead.formAnswers ?? {}) as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .slice(0, 5)
      .map(([question, value]) => [question.slice(0, 120), String(value).slice(0, 120)]),
  );
  return {
    answers,
    formKnown: true,
    formName: firstNameOf(lead.name),
    formPage: lead.landingPage ? lead.landingPage.replace(/[?#].*$/, '').slice(0, 120) : null,
    formAnswers,
    // The person filled in the brand's own page: there is nothing to confirm.
    ...(lead.pipeline === 'expansao' && lead.clientId !== WINGS_CLIENT_ID
      ? { brandConfirmed: true }
      : {}),
  };
}
