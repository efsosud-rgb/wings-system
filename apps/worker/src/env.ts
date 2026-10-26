import {
  AGENT_MODELS,
  JOB_TYPES,
  JOB_TYPES_IMPLEMENTED,
  LEAD_RESEARCH_DEFAULT_SINCE,
  type JobType,
} from '@wings/shared';
import { z } from 'zod';

const requiredString = z.string().trim().min(1);
const optionalString = requiredString.optional().or(z.literal('').transform(() => undefined));
/** An empty variable counts as unset, so its default applies (a blank line copied from .env.example must not stop the worker). */
const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);
/**
 * A YYYY-MM-DD that exists on the calendar. `Date` alone accepts "2026-02-30" and rolls it to
 * 02/03, which would move a cut-off by days without a word: the day must survive a round trip.
 */
const isRealDay = (value: string) => {
  const date = new Date(`${value}T03:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),

  /**
   * The Drive's own storage. Unlike the API, the worker has no local-volume
   * fallback: it reads and writes only through R2, never through a mounted
   * volume, so all four are required here.
   */
  R2_ENDPOINT: requiredString,
  R2_BUCKET: requiredString,
  R2_ACCESS_KEY_ID: requiredString,
  R2_SECRET_ACCESS_KEY: requiredString,
  R2_REGION: requiredString.optional(),

  /**
   * How much of the host this worker may use, split across the jobs it runs
   * at once. Unset, `WORKER_CPU_LIMIT` defaults to half the container's cores
   * (at least 1) and `WORKER_MEMORY_LIMIT_MB` to 2048 — the defaults asked
   * for. Both are read at startup, not renegotiated while running.
   */
  WORKER_CPU_LIMIT: z.coerce.number().int().positive().optional(),
  WORKER_MEMORY_LIMIT_MB: z.coerce.number().int().positive().default(2048),
  /** Rough memory budget per concurrent job, used with the two limits above
   * to size how many jobs run at once. Not a hard cap: Node cannot enforce
   * one on a child process by itself. */
  WORKER_MEMORY_PER_JOB_MB: z.coerce.number().int().positive().default(1024),

  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  /** For every type except `render`, which is always 1 attempt (docs/studio/jobs.md: "a job is one attempt"). */
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /** Comma-separated job types this instance claims. */
  WORKER_JOB_TYPES: requiredString.default(JOB_TYPES_IMPLEMENTED.join(',')),

  /** Limits for the `render` job (docs/studio/jobs.md). */
  RENDER_MAX_SECONDS: z.coerce.number().int().positive().default(3600),
  RENDER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(7200),
  RENDER_MAX_INPUT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024 * 1024),
  /** Where downloaded assets and the render result live until uploaded;
   * always removed at the end, success or failure. */
  RENDER_TMP_DIR: requiredString.optional(),

  /**
   * The `enrich_lead` job (docs/leads/intake.md). Z-API reads the WhatsApp
   * profile of a number (the same instance the API notifies with); Brave
   * Search finds public LinkedIn/Instagram pages and is PAID per query;
   * BrasilAPI is public. Unset, a step is skipped and the lead says so.
   */
  ZAPI_INSTANCE_ID: optionalString,
  ZAPI_INSTANCE_TOKEN: optionalString,
  ZAPI_CLIENT_TOKEN: optionalString,
  BRAVE_SEARCH_API_KEY: optionalString,
  /** What one search query costs, in US dollars (Brave: US$ 5 per 1,000). */
  ENRICH_SEARCH_USD_PER_QUERY: z.coerce.number().min(0).default(0.005),
  /** The ceiling on paid enrichment for everyone, per day (America/Sao_Paulo). */
  ENRICH_DAILY_USD: z.coerce.number().positive().max(100).default(2),
  BRASILAPI_BASE_URL: optionalString,

  /**
   * Company research on arrival (docs/leads/pesquisa-da-empresa.md): OpenRouter
   * with a web search of at most 5 results, told only the company's name, site,
   * Instagram and the domain of a corporate e-mail. Off unless LEAD_RESEARCH_ENABLED is "true" AND the key
   * is set (the same OpenRouter account the API uses). It has its own ceiling,
   * apart from ENRICH_DAILY_USD, summed over the ledger per day in São Paulo.
   */
  OPENROUTER_API_KEY: optionalString,
  LEAD_RESEARCH_ENABLED: optionalString.refine(
    (value) => value === undefined || value === 'true' || value === 'false',
    'must be "true" or "false"',
  ),
  LEAD_RESEARCH_MODEL: z.preprocess(emptyAsUnset, z.enum(AGENT_MODELS).default('anthropic/claude-haiku-4.5')),
  /** The company research's ceiling per day (America/Sao_Paulo), in US dollars. */
  LEAD_RESEARCH_DAILY_USD: z.preprocess(emptyAsUnset, z.coerce.number().positive().max(100).default(1)),
  /** What one research is expected to cost (5 web results plus the model); reserved before the call. */
  LEAD_RESEARCH_USD_PER_CALL: z.preprocess(emptyAsUnset, z.coerce.number().positive().max(1).default(0.06)),
  /**
   * The Instagram check of a site-form lead (docs/leads/instagram.md, job `check_instagram`): Meta's
   * Business Discovery through Wings' own Instagram business account (the same two variables the
   * API reads for "Conferir de novo"), then a Brave search, then a model (`LEAD_RESEARCH_MODEL`,
   * `OPENROUTER_API_KEY`) comparing the profile with the company. Off unless
   * INSTAGRAM_CHECK_ENABLED is "true". The paid steps have a ceiling of their own per day
   * (America/Sao_Paulo), summed over the same ledger as LEAD_RESEARCH_DAILY_USD.
   */
  INSTAGRAM_CHECK_ENABLED: optionalString.refine(
    (value) => value === undefined || value === 'true' || value === 'false',
    'must be "true" or "false"',
  ),
  INSTAGRAM_DISCOVERY_ACCOUNT_ID: optionalString.refine(
    (value) => value === undefined || /^\d+$/.test(value),
    'must be the numeric Instagram business account id',
  ),
  INSTAGRAM_DISCOVERY_TOKEN: optionalString,
  INSTAGRAM_CHECK_DAILY_USD: z.preprocess(emptyAsUnset, z.coerce.number().positive().max(100).default(0.5)),
  /** What one comparison is expected to cost; reserved before the call (a few thousandths of a dollar). */
  INSTAGRAM_CHECK_AI_USD_PER_CALL: z.preprocess(emptyAsUnset, z.coerce.number().positive().max(1).default(0.004)),
  /**
   * Meta's Conversions API (docs/ads/conversions-api.md, job `meta_capi_lead`): sends the Lead
   * event of a site-form lead that gave consent. Off unless META_CAPI_ENABLED is "true".
   * META_PIXEL_ID is the same public id the API uses; META_CAPI_ACCESS_TOKEN is the token
   * Events Manager generates for that pixel (a secret: it lives only in Coolify).
   * META_CAPI_TEST_EVENT_CODE sends to "Testar eventos" instead of the real count.
   */
  META_CAPI_ENABLED: optionalString.refine(
    (value) => value === undefined || value === 'true' || value === 'false',
    'must be "true" or "false"',
  ),
  META_PIXEL_ID: optionalString.refine(
    (value) => value === undefined || /^\d{5,25}$/.test(value),
    'must be the numeric pixel id',
  ),
  META_CAPI_ACCESS_TOKEN: optionalString,
  META_CAPI_TEST_EVENT_CODE: optionalString,
  /**
   * The research cut-off, a São Paulo day (YYYY-MM-DD): only leads that arrived from 00:00 of
   * that day on are researched; an older lead that converts again is not.
   */
  LEAD_RESEARCH_SINCE: z.preprocess(
    emptyAsUnset,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
      .refine(isRealDay, 'not a real calendar day')
      .default(LEAD_RESEARCH_DEFAULT_SINCE),
  ),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

/** `WORKER_JOB_TYPES`, parsed and checked against the types the contract knows. */
export function jobTypesOf(env: Env): JobType[] {
  const names = env.WORKER_JOB_TYPES.split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = names.filter((name) => !(JOB_TYPES as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`WORKER_JOB_TYPES has unknown type(s): ${unknown.join(', ')}`);
  if (names.length === 0) throw new Error('WORKER_JOB_TYPES must name at least one job type');
  return names as JobType[];
}
