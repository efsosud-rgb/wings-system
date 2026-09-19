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

  /**
   * Meta write credentials, kept separate from the read-only token so that
   * revoking writes never breaks reading. Writes stay OFF until
   * ADS_WRITES_ENABLED is explicitly set to true: having the token is not the
   * same as being allowed to use it.
   */
  META_WRITE_TOKEN: optionalString,
  META_WRITE_ACCOUNT_ID: optionalString,
  /** The pixel whose Lead event a leads ad set optimises for. Not a secret. */
  META_PIXEL_ID: z
    .string()
    .regex(/^\d{5,25}$/)
    .default('1116678872845520'),
  /**
   * A mounted volume for ad videos (up to 4 GB each — too large for the
   * database). Unset, the video routes answer 503, never a fake success.
   */
  CREATIVE_VIDEO_DIR: optionalString,
  ADS_WRITES_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /** Z-API (WhatsApp) for approval notifications. Optional: without it the
   * gate falls back to logging, and requests still wait for a decision. */
  ZAPI_INSTANCE_ID: optionalString,
  ZAPI_INSTANCE_TOKEN: optionalString,
  ZAPI_CLIENT_TOKEN: optionalString,
  /** Numbers of approvers who are not employees in the system yet. */
  /**
   * Google Ads, read-only for now (the spending ceiling on a prepaid account).
   *
   * GOOGLE_ADS_LOGIN_CUSTOMER_ID is recorded for documentation only: it names
   * the MCC that owns the developer token. The client must NOT send it while
   * the authorising user has direct access to the ad account — doing so makes
   * Google check the MCC instead and refuse with USER_PERMISSION_DENIED.
   */
  GOOGLE_ADS_CLIENT_ID: optionalString,
  GOOGLE_ADS_CLIENT_SECRET: optionalString,
  GOOGLE_ADS_REFRESH_TOKEN: optionalString,
  GOOGLE_ADS_DEVELOPER_TOKEN: optionalString,
  GOOGLE_ADS_CUSTOMER_ID: optionalString,
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: optionalString,
  /**
   * Wings' own WordPress site, for draft posts created from the studio. All
   * three must be set; otherwise the routes answer 503, never a fake success.
   * The password is a WordPress *application password* for a user who may
   * write posts and nothing more.
   */
  WORDPRESS_BASE_URL: optionalString.refine(
    (value) => value === undefined || /^https:\/\/[^\s]+$/.test(value),
    'must be an https:// URL',
  ),
  WORDPRESS_USERNAME: optionalString,
  WORDPRESS_APP_PASSWORD: optionalString,
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
