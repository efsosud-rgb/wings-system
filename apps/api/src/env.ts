import { z } from 'zod';

/** 32-byte key, base64-encoded. */
const base64Key32 = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'must be 32 bytes, base64-encoded');

const optionalString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(z.literal('').transform(() => undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  CPF_ENCRYPTION_KEY: base64Key32,
  CPF_INDEX_KEY: base64Key32,

  /** Public base URL, used to build invite and password-reset links. */
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),

  /** Z-API (WhatsApp) for approval notifications. Optional: without it the
   * gate falls back to logging, and requests still wait for a decision. */
  ZAPI_INSTANCE_ID: optionalString,
  ZAPI_INSTANCE_TOKEN: optionalString,
  ZAPI_CLIENT_TOKEN: optionalString,
  /** Numbers of approvers who are not employees in the system yet. */
  ADS_APPROVAL_ADMIN_PHONES: optionalString,
  ADS_APPROVAL_DIRETORIA_PHONES: optionalString,

  /** Google Workspace SMTP. Optional in development; required in production. */
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: optionalString,
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
  if (parsed.data.CPF_ENCRYPTION_KEY === parsed.data.CPF_INDEX_KEY) {
    throw new Error('CPF_ENCRYPTION_KEY and CPF_INDEX_KEY must be different keys');
  }
  return parsed.data;
}
