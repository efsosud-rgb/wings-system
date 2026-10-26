import { z } from 'zod';
import { scrubForAi, SOFIA_INTENTS } from '../brain.js';

/**
 * A test conversation for Sofia's brain (docs/whatsapp/sofia-avaliacao.md):
 * what the model is shown, and what a good reading of it looks like. Made up
 * by hand, or (later) real conversations with every name, phone, e-mail and
 * CPF already taken out by the server. Either way a file that still holds
 * personal data is refused (`parseEvalCases`).
 */

export const EVAL_CATEGORIES = ['intencao', 'extracao', 'humano', 'injecao', 'regras'] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export const EVAL_CATEGORY_LABELS: Record<EvalCategory, string> = {
  intencao: 'Intenção',
  extracao: 'Campos extraídos',
  humano: 'Passar para pessoa ou encerrar',
  injecao: 'Manipulação das instruções',
  regras: 'Regras comerciais',
};

/** What the lead is trying to get the model to do (injection cases). */
export const EVAL_ATTACKS = [
  'ignorar_regras',
  'trocar_papel',
  'extrair_prompt',
  'falsa_autoridade',
  'dado_falso',
  'texto_oculto',
] as const;

/** The rule a reply would break. */
export const EVAL_VIOLATIONS = [
  'valor',
  'promessa',
  'pessoa',
  'documento',
  'reuniao',
  'link',
  'wings',
  'prompt',
] as const;
export type EvalViolation = (typeof EVAL_VIOLATIONS)[number];

const answerValue = z.union([z.string(), z.array(z.string()).min(1)]);

/** What the scripted model returns for a case when it is not the gold answer. */
const modelAnswer = z.object({
  intent: z.enum(SOFIA_INTENTS).optional(),
  answers: z.record(z.string(), z.string()).optional(),
  understood: z.boolean().optional(),
  asked_values: z.boolean().optional(),
  brand: z.string().nullable().optional(),
  reply: z.string().optional(),
});

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z]{3}-\d{3}$/, 'id: três letras, hífen e três dígitos'),
  category: z.enum(EVAL_CATEGORIES),
  /** Why the case exists, in a line. */
  note: z.string().min(5).max(200),
  /** The funnel the conversation is in; null before it is known. */
  segment: z.enum(['formatacao', 'expansao']).nullable().default(null),
  /** The brand whose expansion team she speaks for (a made-up one), or null for Wings Company. */
  voice: z.string().nullable().default(null),
  /** The question waiting for an answer (its key), if one. */
  step: z.string().nullable().default(null),
  /** Answers already given. */
  known: z.record(z.string(), z.string()).default({}),
  /** The conversation, oldest first: [who, text]. The question at `step` is put before a lead's first line. */
  lines: z
    .array(
      z
        .tuple([z.enum(['lead', 'sofia']), z.string().min(1).max(400)])
        .transform(([from, text]) => ({ from, text })),
    )
    .min(1),
  expect: z.object({
    /** Any of these is a right reading. */
    intents: z.array(z.enum(SOFIA_INTENTS)).min(1),
    /** Exactly these answers, by question key, and no others. A list is the accepted spellings. */
    answers: z.record(z.string(), answerValue).default({}),
    /** What the script does next: a person takes over, she ends it, or she keeps asking. */
    route: z.enum(['human', 'close', 'continue']),
    /** The brand the lead named; null means none. Not checked when left out. */
    brand: z.string().nullable().optional(),
    understood: z.boolean().optional(),
    askedValues: z.boolean().default(false),
  }),
  attack: z.enum(EVAL_ATTACKS).optional(),
  /** The rule the lead pushes on. */
  probe: z.enum(EVAL_VIOLATIONS).optional(),
  /** What the simulated model answers; whatever it leaves out is the gold answer. */
  simulated: modelAnswer.default({}),
  /** The system has a known hole here: the case is expected to fail, and says why. */
  gap: z.string().min(5).optional(),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalCaseInput = z.input<typeof evalCaseSchema>;

const casesSchema = z
  .array(evalCaseSchema)
  .min(1)
  .refine((list) => new Set(list.map((c) => c.id)).size === list.length, {
    message: 'Cada caso precisa de um id diferente.',
  });

/** Text a case may not carry: anything the scrub for the AI would change. */
const holdsPersonalData = (text: string) => scrubForAi(text) !== text;

/** Validates a list of cases (a file, or the built-in set) and refuses personal data in it. */
export function parseEvalCases(raw: unknown): EvalCase[] {
  const cases = casesSchema.parse(raw);
  const leaking = cases.filter((c) =>
    [...c.lines.map((l) => l.text), ...Object.values(c.known), c.simulated.reply ?? ''].some(
      holdsPersonalData,
    ),
  );
  if (leaking.length > 0)
    throw new Error(
      `Dado pessoal (telefone, e-mail, CPF ou número longo) nos casos: ${leaking.map((c) => c.id).join(', ')}`,
    );
  return cases;
}
