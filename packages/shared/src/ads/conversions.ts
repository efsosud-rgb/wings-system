import { z } from 'zod';

/**
 * Closing the loop (docs/ads/fechar-ciclo.md): CRM stages sent back to Meta and
 * Google as events. What the panel reads and what a manager configures.
 *
 *   GET  /ads/conversions                 -> ConversionsPanel   ads.read
 *   PUT  /ads/conversions/mappings        -> { mapping }        ads.approve
 */

export const CONVERSION_PLATFORMS = ['meta', 'google'] as const;
export type ConversionPlatform = (typeof CONVERSION_PLATFORMS)[number];

export const CONVERSION_PLATFORM_LABEL: Record<ConversionPlatform, string> = {
  meta: 'Meta',
  google: 'Google Ads',
};

/** The identifiers a lead's arrival keeps (`lead_ad_identifiers.kind`). */
export const AD_IDENTIFIER_KINDS = [
  'meta_lead_id',
  'fbclid',
  'fbc',
  'fbp',
  'gclid',
  'gbraid',
  'wbraid',
] as const;
export type AdIdentifierKind = (typeof AD_IDENTIFIER_KINDS)[number];

export const CONVERSION_SEND_STATES = ['pending', 'sending', 'sent', 'failed', 'skipped'] as const;
export type ConversionSendState = (typeof CONVERSION_SEND_STATES)[number];

/** Why a stage event was not sent. */
export const CONVERSION_SKIP_REASONS = [
  'no_identifier',
  'expired',
  'opt_out',
  'before_lead',
] as const;
export type ConversionSkipReason = (typeof CONVERSION_SKIP_REASONS)[number];

export const CONVERSION_SKIP_LABEL: Record<ConversionSkipReason, string> = {
  no_identifier: 'Sem identificador da plataforma (e o envio com hash está desligado ou sem dado)',
  expired: 'Fora do prazo da plataforma (Meta 7 dias; Google 90 dias do clique, 63 só com hash)',
  opt_out: 'A pessoa pediu "não me contate"',
  before_lead: 'Etapa registrada antes da entrada do lead',
};

/** Meta's custom event names: letters, digits and underscores (our rule, to keep them readable). */
const EVENT_NAME = /^[a-z][a-z0-9_]{1,49}$/;

export const conversionMappingInputSchema = z
  .object({
    stageId: z.uuid(),
    platform: z.enum(CONVERSION_PLATFORMS),
    eventName: z
      .string()
      .trim()
      .regex(EVENT_NAME, 'Nome do evento: letras minúsculas, números e _ (ex.: reuniao_agendada)'),
    /** The Google Ads conversion action's id (digits); required for Google. */
    googleConversionActionId: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, 'Id da ação de conversão: só números')
      .nullable()
      .optional(),
    active: z.boolean(),
  })
  .refine((input) => input.platform !== 'google' || Boolean(input.googleConversionActionId), {
    message: 'Para o Google, informe o id da ação de conversão',
    path: ['googleConversionActionId'],
  });
export type ConversionMappingInput = z.infer<typeof conversionMappingInputSchema>;

export interface ConversionMapping {
  id: string;
  stageId: string;
  stageName: string;
  pipeline: string;
  platform: ConversionPlatform;
  eventName: string;
  googleConversionActionId: string | null;
  active: boolean;
}

/** One platform's last 30 days: counts and codes only, never a lead's data. */
export interface ConversionPlatformStatus {
  platform: ConversionPlatform;
  /** The platform's switch (CRM_CONVERSIONS_<META|GOOGLE>_ENABLED). */
  enabled: boolean;
  /** Credentials and destination present; what is missing, by variable name. */
  missing: string[];
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
  /** Failures and retries by error code (`http_400:100`, `timeout`…). */
  errors: { code: string; count: number }[];
  skips: { reason: ConversionSkipReason; count: number }[];
  lastSentAt: string | null;
}

export interface ConversionsPanel {
  /** Stage changes before this day are never sent (CRM_CONVERSIONS_SINCE); null: not set, nothing goes. */
  since: string | null;
  /** E-mail and phone, hashed, for leads without a platform id (CRM_CONVERSIONS_HASHED_ENABLED). */
  hashedEnabled: boolean;
  /** Google's requests only validate, nothing is recorded (CRM_CONVERSIONS_GOOGLE_VALIDATE_ONLY). */
  googleValidateOnly: boolean;
  platforms: ConversionPlatformStatus[];
  mappings: ConversionMapping[];
}
