/**
 * Media providers: the services that generate images and videos for
 * Marketing → Edição de Fotos e Vídeos. Kairogen was the first; the others
 * plug into the same contract, and the same rule holds for all of them:
 * nothing is generated without a click on a price, and the price is shown
 * before the click, even when it is R$ 0.
 */

export const MEDIA_PROVIDERS = ['kairogen', 'cloudflare', 'gemini', 'higgsfield', 'mpt'] as const;
export type MediaProviderId = (typeof MEDIA_PROVIDERS)[number];

export const MEDIA_PROVIDER_LABEL: Record<MediaProviderId, string> = {
  kairogen: 'Kairogen',
  cloudflare: 'Cloudflare Workers AI',
  gemini: 'Gemini',
  higgsfield: 'Higgsfield',
  mpt: 'MoneyPrinterTurbo',
};

/** What a provider can do. A model belongs to one provider and does one of these. */
export const MEDIA_CAPABILITIES = ['generate_image', 'generate_video', 'animate', 'upscale'] as const;
export type MediaCapability = (typeof MEDIA_CAPABILITIES)[number];

/**
 * How a provider charges. It decides the failover order: free with a quota
 * first, then the month's credits, then pay-per-use. Our own service costs
 * nothing per output and ranks with the free ones.
 */
export const MEDIA_BILLINGS = ['free_quota', 'own_service', 'credits', 'per_use'] as const;
export type MediaBilling = (typeof MEDIA_BILLINGS)[number];
export const MEDIA_BILLING_RANK: Record<MediaBilling, number> = {
  free_quota: 0,
  own_service: 0,
  credits: 1,
  per_use: 2,
};
export const MEDIA_BILLING_LABEL: Record<MediaBilling, string> = {
  free_quota: 'Grátis, com cota',
  own_service: 'Serviço próprio',
  credits: 'Créditos do mês',
  per_use: 'Pago por uso',
};

/** The one ceiling over every provider, in BRL per month (America/Sao_Paulo). */
export const DEFAULT_MEDIA_MONTHLY_BRL = 300;
/** Converts a provider's dollars into the reais the ledger and the ceiling count. */
export const DEFAULT_BRL_PER_USD = 5.5;

export const formatBrl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** A free provider's local counters. The quota is ours: the service is never asked. */
export interface MediaProviderQuota {
  usedToday: number;
  dailyLimit: number;
  /** Null when the provider has no per-minute ceiling. */
  usedThisMinute: number | null;
  perMinuteLimit: number | null;
}

/** What the provider says it holds, in its own unit and in reais. */
export interface MediaProviderBalance {
  credits: number | null;
  usd: number | null;
  brlCents: number | null;
}

export interface MediaProviderStatus {
  id: MediaProviderId;
  name: string;
  billing: MediaBilling;
  capabilities: MediaCapability[];
  /** The environment names its key (or address). Never the key itself. */
  configured: boolean;
  /** Usable right now: configured, connected, quota left. */
  available: boolean;
  /** Why not, in words for the screen. */
  reason: string | null;
  balance: MediaProviderBalance | null;
  quota: MediaProviderQuota | null;
  /** What this provider spent this month, in reais estimated, from the ledger. */
  usedThisMonthBrlCents: number;
  /**
   * False while the request and answer formats come from public documentation
   * that could not be checked against the real service. The docs say what.
   */
  verified: boolean;
}

/** The whole studio's spend across providers, against the one ceiling. */
export interface MediaSpend {
  usedThisMonthBrlCents: number;
  monthlyLimitBrlCents: number;
}

//   GET /media/providers -> { providers: MediaProviderStatus[], spend: MediaSpend }   marketing.media.read
