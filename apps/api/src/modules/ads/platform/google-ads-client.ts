import { GOOGLE_ADS_API_VERSION, GoogleAdsReadClient, centsFromMicros } from './google-client.js';
import type { Cents } from './money.js';
import type {
  AdsPlatformClient,
  CampaignStatus,
  CreateCampaignSpec,
  InsightRow,
  MetricsLevel,
  MutationOutcome,
  PlatformAccount,
  PlatformAd,
  PlatformAdSet,
  PlatformCampaign,
  PlatformReach,
  SpendRow,
} from './types.js';

/**
 * Google Ads behind the same narrow interface as Meta.
 *
 * Reading mirrors campaigns, their budgets and their spend, which is what lets
 * a Google account be reconciled — and an account that is never reconciled can
 * never be written to: the executor's dead-man switch refuses it.
 *
 * Writing is one thing only: creating a campaign shell, always PAUSED, with its
 * own budget. No ad group, no ad, no keyword is created, and nothing that
 * already exists can be touched — `setDailyBudget`, `pauseCampaign` and
 * `resumeCampaign` refuse without calling Google. What the client cannot
 * express, no bug and no agent can do.
 *
 * Verified against the live account (stage-google-spike.md): v22, no
 * `login-customer-id`, budgets only at campaign level, money in micros.
 * NOT verified until the first supervised write: the mutate itself.
 */

interface CampaignRow {
  campaign?: { id?: string; name?: string; status?: string };
  campaignBudget?: {
    resourceName?: string;
    amountMicros?: string;
    totalAmountMicros?: string;
    period?: string;
    explicitlyShared?: boolean;
  };
}

interface MetricsRow {
  campaign?: { id?: string };
  segments?: { date?: string };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: number;
  };
}

interface GeoRow {
  geoTargetConstant?: {
    id?: string;
    name?: string;
    canonicalName?: string;
    targetType?: string;
    status?: string;
  };
}

const STATUS: Record<string, CampaignStatus> = {
  ENABLED: 'ACTIVE',
  PAUSED: 'PAUSED',
  REMOVED: 'DELETED',
};

/** Google's criterion id for Portuguese. */
export const PORTUGUESE_LANGUAGE_CONSTANT = 'languageConstants/1014';

const STATE_NAMES: Record<string, string> = {
  AC: 'Acre',
  AL: 'Alagoas',
  AP: 'Amapa',
  AM: 'Amazonas',
  BA: 'Bahia',
  CE: 'Ceara',
  DF: 'Federal District',
  ES: 'Espirito Santo',
  GO: 'Goias',
  MA: 'Maranhao',
  MT: 'Mato Grosso',
  MS: 'Mato Grosso do Sul',
  MG: 'Minas Gerais',
  PA: 'Para',
  PB: 'Paraiba',
  PR: 'Parana',
  PE: 'Pernambuco',
  PI: 'Piaui',
  RJ: 'Rio de Janeiro',
  RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul',
  RO: 'Rondonia',
  RR: 'Roraima',
  SC: 'Santa Catarina',
  SP: 'Sao Paulo',
  SE: 'Sergipe',
  TO: 'Tocantins',
};

/** Lower case, no accents, no "State of" — how two spellings of a place compare. */
function foldPlace(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^state of\s+/, '')
    .trim();
}

export interface ResolvedLocation {
  /** What the operator asked for, e.g. "SP" or "Campinas/SP". */
  asked: string;
  resourceName: string;
  canonicalName: string;
}

export class GeoResolutionError extends Error {
  constructor(
    readonly asked: string,
    readonly matches: number,
  ) {
    super(
      matches === 0
        ? `Google não conhece a localidade "${asked}"`
        : `"${asked}" corresponde a ${matches} localidades no Google; escreva o nome como aparece no Google Ads`,
    );
    this.name = 'GeoResolutionError';
  }
}

export class GoogleAdsPlatformClient implements AdsPlatformClient {
  readonly platform = 'google' as const;
  readonly isLive = true;
  readonly accountExternalId: string;
  /** A prepaid balance, not a cap somebody set. */
  readonly spendLimitSource = 'google.account_budget';

  /** Name → constant. Geo target constants are stable, so this never expires. */
  private readonly geoCache = new Map<string, ResolvedLocation>();
  private statesLoaded = false;

  constructor(
    protected readonly reader: GoogleAdsReadClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.accountExternalId = reader.customerId;
  }

  async getAccount(): Promise<PlatformAccount> {
    const budget = await this.reader.getAccountBudget();
    const spendCapCents = budget?.limitCents ?? null;
    const amountSpentCents = budget?.servedCents ?? 0;
    return {
      id: this.accountExternalId,
      currency: 'BRL',
      spendCapCents,
      amountSpentCents,
      capReached: spendCapCents !== null && amountSpentCents >= spendCapCents,
    };
  }

  private today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(this.now());
  }

  private async campaignRows(where: string): Promise<CampaignRow[]> {
    return this.reader.search<CampaignRow>(`
      SELECT campaign.id, campaign.name, campaign.status,
             campaign_budget.resource_name, campaign_budget.amount_micros,
             campaign_budget.total_amount_micros, campaign_budget.period,
             campaign_budget.explicitly_shared
        FROM campaign
       WHERE ${where}
    `);
  }

  private async monthSpendByCampaign(): Promise<Map<string, Cents>> {
    const today = this.today();
    const rows = await this.reader.search<MetricsRow>(`
      SELECT campaign.id, metrics.cost_micros
        FROM campaign
       WHERE segments.date BETWEEN '${today.slice(0, 8)}01' AND '${today}'
    `);
    const spend = new Map<string, Cents>();
    for (const row of rows) {
      const id = row.campaign?.id;
      if (!id) continue;
      spend.set(id, (spend.get(id) ?? 0) + centsFromMicros(row.metrics?.costMicros));
    }
    return spend;
  }

  private toCampaign(
    row: CampaignRow,
    spend: Map<string, Cents>,
    sharedSeen: Set<string>,
  ): PlatformCampaign | null {
    const id = row.campaign?.id;
    if (!id) return null;

    const budget = row.campaignBudget;
    // Exposure follows the budget, not the campaign: a shared budget is one
    // pot of money, so only the first campaign that draws on it carries it.
    let counted = true;
    if (budget?.explicitlyShared && budget.resourceName) {
      counted = !sharedSeen.has(budget.resourceName);
      sharedSeen.add(budget.resourceName);
    }
    const daily = budget?.period === 'DAILY' ? centsFromMicros(budget.amountMicros) : null;
    const lifetime = budget?.totalAmountMicros ? centsFromMicros(budget.totalAmountMicros) : null;

    return {
      id,
      name: row.campaign?.name ?? '',
      status: STATUS[row.campaign?.status ?? ''] ?? 'PAUSED',
      dailyBudgetCents: counted ? daily : 0,
      lifetimeBudgetCents: counted ? lifetime : null,
      spendCents: spend.get(id) ?? 0,
    };
  }

  async listCampaigns(): Promise<PlatformCampaign[]> {
    const [rows, spend] = await Promise.all([
      this.campaignRows(`campaign.status != 'REMOVED'`),
      this.monthSpendByCampaign(),
    ]);
    const sharedSeen = new Set<string>();
    // Active campaigns first, so a shared budget lands on one that is spending.
    const ordered = [...rows].sort(
      (a, b) => Number(b.campaign?.status === 'ENABLED') - Number(a.campaign?.status === 'ENABLED'),
    );
    return ordered
      .map((row) => this.toCampaign(row, spend, sharedSeen))
      .filter((campaign): campaign is PlatformCampaign => campaign !== null);
  }

  async getCampaign(campaignId: string): Promise<PlatformCampaign | null> {
    // The id goes into a query string: digits only, or nothing is asked.
    if (!/^\d+$/.test(campaignId)) return null;
    const [rows, spend] = await Promise.all([
      this.campaignRows(`campaign.id = ${campaignId}`),
      this.monthSpendByCampaign(),
    ]);
    const row = rows[0];
    return row ? this.toCampaign(row, spend, new Set()) : null;
  }

  /** Budgets live on the campaign in Google; there is no ad-set level to mirror. */
  async listAdSets(): Promise<PlatformAdSet[]> {
    return [];
  }

  /** Ads and their review state are not mirrored yet (P-max needs asset groups too). */
  async listAds(): Promise<PlatformAd[]> {
    return [];
  }

  private async dailyRows(sinceDate: string, untilDate?: string): Promise<MetricsRow[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) throw new Error('google: invalid since date');
    const until = untilDate ?? this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error('google: invalid until date');
    return this.reader.search<MetricsRow>(`
      SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions,
             metrics.clicks, metrics.conversions
        FROM campaign
       WHERE segments.date BETWEEN '${sinceDate}' AND '${until}'
    `);
  }

  async getInsights(
    level: MetricsLevel,
    sinceDate: string,
    untilDate?: string,
  ): Promise<InsightRow[]> {
    if (level !== 'campaign') return [];
    const rows = await this.dailyRows(sinceDate, untilDate);
    return rows.flatMap((row) => {
      const entityId = row.campaign?.id;
      const date = row.segments?.date;
      if (!entityId || !date) return [];
      const impressions = Number(row.metrics?.impressions ?? 0);
      const clicks = Number(row.metrics?.clicks ?? 0);
      const conversions = Math.round(row.metrics?.conversions ?? 0);
      // On this account the only conversion that fires is the site's lead form
      // (stage-google-spike.md), so Google's conversions are leads.
      const actions: Record<string, number> = conversions > 0 ? { lead: conversions } : {};
      return [
        {
          level,
          entityId,
          date,
          spendCents: centsFromMicros(row.metrics?.costMicros),
          impressions,
          clicks,
          reach: 0,
          ctrMilli: impressions > 0 ? Math.round((clicks / impressions) * 100_000) : 0,
          frequencyMilli: 0,
          actions,
          qualityRanking: null,
          engagementRateRanking: null,
          conversionRateRanking: null,
        },
      ];
    });
  }

  async getSpend(sinceDate: string): Promise<SpendRow[]> {
    const rows = await this.dailyRows(sinceDate);
    return rows.flatMap((row) =>
      row.campaign?.id && row.segments?.date
        ? [
            {
              campaignId: row.campaign.id,
              date: row.segments.date,
              spendCents: centsFromMicros(row.metrics?.costMicros),
            },
          ]
        : [],
    );
  }

  // --- locations -----------------------------------------------------------

  private async geoRows(where: string): Promise<GeoRow[]> {
    return this.reader.search<GeoRow>(`
      SELECT geo_target_constant.id, geo_target_constant.name,
             geo_target_constant.canonical_name, geo_target_constant.target_type,
             geo_target_constant.status
        FROM geo_target_constant
       WHERE geo_target_constant.country_code = 'BR'
         AND geo_target_constant.status = 'ENABLED'
         AND ${where}
    `);
  }

  private async loadStates(): Promise<void> {
    if (this.statesLoaded) return;
    const rows = await this.geoRows(`geo_target_constant.target_type = 'State'`);
    for (const [uf, stateName] of Object.entries(STATE_NAMES)) {
      const matches = rows.filter(
        (row) => foldPlace(row.geoTargetConstant?.name ?? '') === foldPlace(stateName),
      );
      const constant = matches[0]?.geoTargetConstant;
      if (matches.length === 1 && constant?.id) {
        this.geoCache.set(`state:${uf}`, {
          asked: uf,
          resourceName: `geoTargetConstants/${constant.id}`,
          canonicalName: constant.canonicalName ?? constant.name ?? uf,
        });
      }
    }
    this.statesLoaded = true;
  }

  /**
   * Turns the builder's states and typed city names into geo target constants.
   *
   * A city must match exactly one constant by name, inside the state the
   * operator picked. None or several is a refusal, never a guess: aiming a
   * campaign at the wrong Campinas is not something to find out afterwards.
   */
  async resolveLocations(locations: {
    states: string[];
    cities: { name: string; state: string }[];
  }): Promise<ResolvedLocation[]> {
    const resolved: ResolvedLocation[] = [];
    if (locations.states.length > 0 || locations.cities.length > 0) await this.loadStates();

    for (const uf of locations.states) {
      const state = this.geoCache.get(`state:${uf}`);
      if (!state) throw new GeoResolutionError(uf, 0);
      resolved.push(state);
    }

    for (const city of locations.cities) {
      const asked = `${city.name}/${city.state}`;
      const key = `city:${foldPlace(city.name)}:${city.state}`;
      const cached = this.geoCache.get(key);
      if (cached) {
        resolved.push(cached);
        continue;
      }

      const state = this.geoCache.get(`state:${city.state}`);
      if (!state) throw new GeoResolutionError(asked, 0);

      // The name goes into a query string, so it is reduced to letters first.
      const safeName = city.name.replace(/[^\p{L}\p{N} .'-]/gu, '').replace(/'/g, "\\'");
      const rows = await this.geoRows(
        `geo_target_constant.target_type = 'City' AND geo_target_constant.name LIKE '${safeName}'`,
      );
      const stateFolded = foldPlace(state.canonicalName.split(',')[0] ?? '');
      const matches = rows.filter((row) => {
        const constant = row.geoTargetConstant;
        if (foldPlace(constant?.name ?? '') !== foldPlace(city.name)) return false;
        const parts = (constant?.canonicalName ?? '').split(',').map(foldPlace);
        return parts.includes(stateFolded);
      });
      const constant = matches[0]?.geoTargetConstant;
      if (matches.length !== 1 || !constant?.id)
        throw new GeoResolutionError(asked, matches.length);

      const location: ResolvedLocation = {
        asked,
        resourceName: `geoTargetConstants/${constant.id}`,
        canonicalName: constant.canonicalName ?? asked,
      };
      this.geoCache.set(key, location);
      resolved.push(location);
    }
    return resolved;
  }

  // --- writes: refused here, and mostly refused in the write client too ------

  protected notSupported(what: string): MutationOutcome {
    return {
      status: 'rejected',
      code: 'google_not_supported',
      message: `${what} não existe para o Google: o sistema só cria campanhas novas, pausadas.`,
    };
  }

  async setDailyBudget(): Promise<MutationOutcome> {
    return this.notSupported('Alterar orçamento');
  }

  async pauseCampaign(): Promise<MutationOutcome> {
    return this.notSupported('Pausar campanha');
  }

  async resumeCampaign(): Promise<MutationOutcome> {
    return this.notSupported('Reativar campanha');
  }

  async createCampaign(_spec: CreateCampaignSpec): Promise<MutationOutcome> {
    return {
      status: 'rejected',
      code: 'writes_disabled',
      message: 'Este cliente do Google é somente leitura.',
    };
  }

  async setAccountSpendCap(): Promise<{ status: 'applied' | 'rejected'; message?: string }> {
    return { status: 'rejected', message: 'O saldo pré-pago do Google não é ajustável pela API.' };
  }
}

export interface GoogleWriteClientOptions {
  /** Must be true. Exists so enabling writes is a visible, deliberate act. */
  confirmWrites: true;
  timeoutMs?: number;
  now?: () => Date;
}

/** Cents to micros: 1 cent is 10 000 micros. */
export function microsFromCents(cents: Cents): string {
  return String(cents * 10_000);
}

/**
 * The only Google client that can change anything, and the only thing it can
 * change is the number of campaigns: one more, paused.
 */
export class GoogleAdsWriteClient extends GoogleAdsPlatformClient {
  private readonly timeoutMs: number;

  constructor(reader: GoogleAdsReadClient, options: GoogleWriteClientOptions) {
    super(reader, options.now);
    if (options.confirmWrites !== true) {
      throw new Error('GoogleAdsWriteClient requires confirmWrites: true');
    }
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /**
   * Budget and campaign (and, for Search, its locations and language) in ONE
   * atomic `googleAds:mutate`: all of it lands or none of it does, so an
   * `unknown` outcome leaves exactly one thing to look for and never an
   * orphaned budget.
   */
  override async createCampaign(spec: CreateCampaignSpec): Promise<MutationOutcome> {
    const google = spec.google;
    if (!google) {
      return {
        status: 'rejected',
        code: 'google_spec_missing',
        message: 'Rascunho sem dados do Google.',
      };
    }
    // Defence in depth: the draft schema already refuses this.
    if (spec.status !== 'PAUSED') {
      return {
        status: 'rejected',
        code: 'google_must_start_paused',
        message: 'Campanhas do Google nascem sempre pausadas.',
      };
    }

    // Reads first. A location Google cannot place is a refusal with nothing sent.
    let locations: ResolvedLocation[] = [];
    if (google.channel === 'SEARCH') {
      try {
        locations = await this.resolveLocations(google.reach);
      } catch (error) {
        if (error instanceof GeoResolutionError) {
          return { status: 'rejected', code: 'geo_unresolved', message: error.message };
        }
        throw error;
      }
    }

    const customer = `customers/${this.accountExternalId}`;
    const budgetName = `${customer}/campaignBudgets/-1`;
    const campaignName = `${customer}/campaigns/-2`;

    const campaign: Record<string, unknown> = {
      resourceName: campaignName,
      name: spec.name,
      status: 'PAUSED',
      advertisingChannelType: google.channel,
      campaignBudget: budgetName,
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      ...campaignDates(google.startDate, google.endDate),
      ...(google.bidding === 'MAXIMIZE_CLICKS' ? { targetSpend: {} } : { maximizeConversions: {} }),
    };
    if (google.channel === 'SEARCH') {
      // Google Search only: no partners, no Display expansion.
      campaign.networkSettings = {
        targetGoogleSearch: true,
        targetSearchNetwork: false,
        targetContentNetwork: false,
        targetPartnerSearchNetwork: false,
      };
      // People who are in the place, not people who searched about it.
      campaign.geoTargetTypeSetting = { positiveGeoTargetType: 'PRESENCE' };
    }

    const mutateOperations: Record<string, unknown>[] = [
      {
        campaignBudgetOperation: {
          create: {
            resourceName: budgetName,
            name: `${spec.name} · orçamento`,
            amountMicros: microsFromCents(spec.dailyBudgetCents),
            deliveryMethod: 'STANDARD',
            // One budget per campaign, so exposure is never counted twice.
            explicitlyShared: false,
          },
        },
      },
      { campaignOperation: { create: campaign } },
    ];
    if (google.channel === 'SEARCH') {
      mutateOperations.push(
        ...googleLocationCriteria(campaignName, locations, google.reach.customLocations),
      );
      mutateOperations.push({
        campaignCriterionOperation: {
          create: {
            campaign: campaignName,
            language: { languageConstant: PORTUGUESE_LANGUAGE_CONSTANT },
          },
        },
      });
    }

    let response: Response;
    try {
      response = await this.reader.transport(
        `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/${customer}/googleAds:mutate`,
        {
          method: 'POST',
          headers: await this.reader.requestHeaders(),
          body: JSON.stringify({ mutateOperations, partialFailure: false }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      return {
        status: 'unknown',
        reason: `transport failure: ${error instanceof Error ? error.name : 'unknown'}`,
      };
    }

    const text = await response.text();
    if (!response.ok) {
      // 5xx means the request may or may not have taken effect.
      if (response.status >= 500) {
        return { status: 'unknown', reason: `platform error ${response.status}` };
      }
      const failure = googleFailure(text);
      return {
        status: 'rejected',
        code: failure.code ?? String(response.status),
        message: failure.message ?? `O Google recusou a criação (${response.status})`,
      };
    }

    const id = createdCampaignId(text);
    // Google said yes but we cannot tell what it made: it exists, id unknown.
    if (!id)
      return { status: 'unknown', reason: 'campaign created but the response carried no id' };

    const created = await this.getCampaign(id);
    if (!created) return { status: 'unknown', reason: 'campaign unreadable after creation' };
    return {
      status: 'applied',
      campaign: created,
      detail: {
        channel: google.channel,
        locations: locations.map(({ asked, canonicalName }) => ({ asked, canonicalName })),
        radii:
          google.channel === 'SEARCH'
            ? google.reach.customLocations.map(({ latitude, longitude, radiusKm }) => ({
                latitude,
                longitude,
                radiusKm,
              }))
            : [],
        language: google.channel === 'SEARCH' ? PORTUGUESE_LANGUAGE_CONSTANT : null,
      },
    };
  }
}

/**
 * Google's translation of a draft's reach: one campaign criterion per place.
 *
 * A state or a city is a `location` pointing at its geo target constant. A
 * radius is a `proximity`: the point in micro degrees (degrees x 1 000 000,
 * integers) and the radius in kilometres. The two kinds live side by side on
 * the same campaign, and Google reaches the union of them — the same meaning a
 * mixed reach has on Meta.
 */
export function googleLocationCriteria(
  campaignResourceName: string,
  locations: Pick<ResolvedLocation, 'resourceName'>[],
  radii: PlatformReach['customLocations'],
): Record<string, unknown>[] {
  return [
    ...locations.map((location) => ({
      campaignCriterionOperation: {
        create: {
          campaign: campaignResourceName,
          location: { geoTargetConstant: location.resourceName },
        },
      },
    })),
    ...radii.map((radius) => ({
      campaignCriterionOperation: {
        create: {
          campaign: campaignResourceName,
          proximity: {
            geoPoint: {
              latitudeInMicroDegrees: Math.round(radius.latitude * 1_000_000),
              longitudeInMicroDegrees: Math.round(radius.longitude * 1_000_000),
            },
            radius: radius.radiusKm,
            radiusUnits: 'KILOMETERS',
          },
        },
      },
    })),
  ];
}

/**
 * The campaign's run dates as v22 wants them. v23 replaces these two fields
 * with `startDateTime`/`endDateTime` ("yyyy-MM-dd HH:mm:ss"); when the API
 * version moves, this is the only place that changes.
 */
function campaignDates(startDate: string, endDate: string): Record<string, string> {
  return { startDate, endDate };
}

function createdCampaignId(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      mutateOperationResponses?: { campaignResult?: { resourceName?: string } }[];
    };
    for (const entry of parsed.mutateOperationResponses ?? []) {
      const match = /\/campaigns\/(\d+)$/.exec(entry.campaignResult?.resourceName ?? '');
      if (match?.[1]) return match[1];
    }
  } catch {
    // Not JSON: fall through.
  }
  return null;
}

function googleFailure(body: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        details?: { errors?: { message?: string; errorCode?: Record<string, string> }[] }[];
      };
    };
    const first = parsed.error?.details?.[0]?.errors?.[0];
    const code = first?.errorCode ? Object.values(first.errorCode)[0] : undefined;
    return { code, message: first?.message ?? parsed.error?.message };
  } catch {
    return {};
  }
}
