import { GOOGLE_ADS_API_VERSION, GoogleAdsReadClient, centsFromMicros } from './google-client.js';
import type { Cents } from './money.js';
import type {
  AdsPlatformClient,
  BreakdownInsightRow,
  BreakdownKind,
  CampaignStatus,
  ConversionSource,
  CreateCampaignSpec,
  CreatedObject,
  GoogleSearchSpec,
  InsightRow,
  MetricsLevel,
  MutationOutcome,
  PlannedWrite,
  PlatformAccount,
  PlatformAd,
  PlatformAdSet,
  PlatformCampaign,
  PlatformReach,
  PreflightCapable,
  PreflightOutcome,
  ResumeCompanions,
  SpendRow,
} from './types.js';

/**
 * Google Ads behind the same narrow interface as Meta.
 *
 * Reading mirrors campaigns, their budgets and their spend, which is what lets
 * a Google account be reconciled — and an account that is never reconciled can
 * never be written to: the executor's dead-man switch refuses it.
 *
 * Writing (the write client only) is four things: creating a Search campaign
 * with everything it needs to deliver — budget, locations, language,
 * negatives, one ad group, its keywords and one responsive search ad — in ONE
 * atomic mutate, all of it PAUSED; and, on a campaign that exists, changing
 * its daily budget, pausing it and resuming it. Nothing else: no delete, no
 * edit of an ad group or an ad. What the client cannot express, no bug and no
 * agent can do.
 *
 * Every write can be rehearsed first: `validateWrite` sends the same request
 * with Google's `validateOnly`, which checks it against the real account and
 * writes nothing. The read-only client offers that too, since it changes
 * nothing — and its transport refuses any mutate that is not validate-only.
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
  segments?: {
    date?: string;
    hour?: number | string;
    adNetworkType?: string;
    geoTargetRegion?: string;
    device?: string;
  };
  adGroupCriterion?: { ageRange?: { type?: string }; gender?: { type?: string } };
  metrics?: {
    costMicros?: string;
    impressions?: string;
    clicks?: string;
    conversions?: number;
    videoViews?: string;
    videoQuartileP25Rate?: number;
    videoQuartileP50Rate?: number;
    videoQuartileP75Rate?: number;
    videoQuartileP100Rate?: number;
  };
}

const METRIC_FIELDS =
  'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions';

/**
 * Google's age bands and genders, renamed to the words Meta uses so one
 * audience table can hold both platforms.
 */
const AGE_RANGE: Record<string, string> = {
  AGE_RANGE_18_24: '18-24',
  AGE_RANGE_25_34: '25-34',
  AGE_RANGE_35_44: '35-44',
  AGE_RANGE_45_54: '45-54',
  AGE_RANGE_55_64: '55-64',
  AGE_RANGE_65_UP: '65+',
  AGE_RANGE_UNDETERMINED: 'unknown',
};
const GENDER: Record<string, string> = {
  MALE: 'male',
  FEMALE: 'female',
  UNDETERMINED: 'unknown',
};

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

export class GoogleAdsPlatformClient implements AdsPlatformClient, PreflightCapable {
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
      // The account budget of a prepaid account IS the balance: what was
      // loaded, less what was served (google-client.ts).
      prepaidBalanceCents:
        spendCapCents === null ? null : Math.max(0, spendCapCents - amountSpentCents),
      fundingKind: budget ? 'prepaid' : null,
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

  /**
   * Whether this API version answers the video metrics on `campaign`. On the
   * first real run v22 refused `metrics.video_views` ("Unrecognized field in
   * the query"); a field the API does not know makes video "não disponível"
   * for the account, with a warning, and never fails the account. NOT verified
   * live: which of the video fields this version does accept on campaign.
   */
  private videoFields: 'try' | 'none' = 'try';
  private readonly warnings: string[] = [];

  drainWarnings(): string[] {
    return this.warnings.splice(0);
  }

  private async dailyRows(sinceDate: string, untilDate?: string): Promise<MetricsRow[]> {
    const { until } = this.dateBounds(sinceDate, untilDate);
    const where = `WHERE segments.date BETWEEN '${sinceDate}' AND '${until}'`;
    if (this.videoFields === 'try') {
      // The video figures ride on the same query. YouTube reports views and
      // the quartiles as rates of views.
      try {
        return await this.reader.search<MetricsRow>(`
          SELECT campaign.id, segments.date, ${METRIC_FIELDS},
                 metrics.video_views, metrics.video_quartile_p25_rate,
                 metrics.video_quartile_p50_rate, metrics.video_quartile_p75_rate,
                 metrics.video_quartile_p100_rate
            FROM campaign
           ${where}
        `);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const field = /Unrecognized field in the query: '([^']+)'/i.exec(message)?.[1];
        if (!field) throw error;
        this.videoFields = 'none';
        this.warnings.push(
          `métricas de vídeo não disponíveis: a API do Google não reconhece ${field} em campaign; plays e quartis ficam zerados`,
        );
      }
    }
    return this.reader.search<MetricsRow>(`
      SELECT campaign.id, segments.date, ${METRIC_FIELDS}
        FROM campaign
       ${where}
    `);
  }

  private dateBounds(sinceDate: string, untilDate?: string): { since: string; until: string } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) throw new Error('google: invalid since date');
    const until = untilDate ?? this.today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error('google: invalid until date');
    return { since: sinceDate, until };
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
      // Once the API said it does not know the video fields, nothing is read from them.
      const views = this.videoFields === 'none' ? 0 : Number(row.metrics?.videoViews ?? 0);
      const quartile = (rate: number | undefined) => Math.round(views * (rate ?? 0));
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
          video: {
            plays: views,
            // Google has no ThruPlay; the closest honest figure is a view that
            // reached the end.
            thruplays: quartile(row.metrics?.videoQuartileP100Rate),
            p25: quartile(row.metrics?.videoQuartileP25Rate),
            p50: quartile(row.metrics?.videoQuartileP50Rate),
            p75: quartile(row.metrics?.videoQuartileP75Rate),
            p100: quartile(row.metrics?.videoQuartileP100Rate),
          },
        },
      ];
    });
  }

  /**
   * Google's splits, each its own report. Placement is the network the ad
   * served on (Search, YouTube, Display…); age and gender are two separate
   * views on Google, so they arrive as two sets of rows with `all` on the
   * side Google did not split (the screen groups by one side at a time).
   * Region comes back as a geo target constant and is turned into a name
   * with one more read. NOT verified live: every query here.
   */
  async getBreakdowns(
    kind: BreakdownKind,
    sinceDate: string,
    untilDate?: string,
  ): Promise<BreakdownInsightRow[]> {
    const { since, until } = this.dateBounds(sinceDate, untilDate);
    const where = `segments.date BETWEEN '${since}' AND '${until}'`;
    const query = (select: string, from: string) =>
      this.reader.search<MetricsRow>(
        `SELECT campaign.id, segments.date, ${select}, ${METRIC_FIELDS} FROM ${from} WHERE ${where}`,
      );

    const base = (row: MetricsRow, key: string, subKey: string): BreakdownInsightRow[] => {
      const campaignId = row.campaign?.id;
      const date = row.segments?.date;
      if (!campaignId || !date) return [];
      const conversions = Math.round(row.metrics?.conversions ?? 0);
      return [
        {
          kind,
          campaignId,
          date,
          key,
          subKey,
          spendCents: centsFromMicros(row.metrics?.costMicros),
          impressions: Number(row.metrics?.impressions ?? 0),
          clicks: Number(row.metrics?.clicks ?? 0),
          reach: 0,
          actions: conversions > 0 ? { lead: conversions } : {},
        },
      ];
    };

    switch (kind) {
      case 'placement': {
        const rows = await query('segments.ad_network_type', 'campaign');
        return rows.flatMap((row) =>
          base(row, (row.segments?.adNetworkType ?? 'UNKNOWN').toLowerCase(), ''),
        );
      }
      case 'hour': {
        const rows = await query('segments.hour', 'campaign');
        return rows.flatMap((row) =>
          base(row, String(row.segments?.hour ?? '0').padStart(2, '0'), ''),
        );
      }
      case 'device': {
        // MOBILE, DESKTOP, TABLET, CONNECTED_TV, OTHER. Confirmed live
        // 2026-09-23 on this account: MOBILE and DESKTOP came back correctly
        // lowercased (TABLET/CONNECTED_TV/OTHER not yet observed — no spend
        // on those in the window checked).
        const rows = await query('segments.device', 'campaign');
        return rows.flatMap((row) =>
          base(row, (row.segments?.device ?? 'UNKNOWN').toLowerCase(), ''),
        );
      }
      case 'age_gender': {
        const [ages, genders] = await Promise.all([
          query('ad_group_criterion.age_range.type', 'age_range_view'),
          query('ad_group_criterion.gender.type', 'gender_view'),
        ]);
        return [
          ...ages.flatMap((row) => {
            const type = row.adGroupCriterion?.ageRange?.type ?? '';
            return base(row, AGE_RANGE[type] ?? 'unknown', 'all');
          }),
          ...genders.flatMap((row) => {
            const type = row.adGroupCriterion?.gender?.type ?? '';
            return base(row, 'all', GENDER[type] ?? 'unknown');
          }),
        ];
      }
      case 'region': {
        const rows = await query('segments.geo_target_region', 'geographic_view');
        const constants = [
          ...new Set(rows.map((row) => row.segments?.geoTargetRegion).filter(Boolean)),
        ] as string[];
        const names = await this.regionNames(constants);
        return rows.flatMap((row) => {
          const constant = row.segments?.geoTargetRegion ?? '';
          return base(row, names.get(constant) ?? constant, '');
        });
      }
    }
  }

  /**
   * The account's conversion actions and their status. Google's report has no
   * "last fired" time, so an ENABLED action is `active` and nothing more is
   * claimed. NOT verified live.
   */
  async getConversionSources(): Promise<ConversionSource[]> {
    const rows = await this.reader.search<{
      conversionAction?: { id?: string; name?: string; status?: string; type?: string };
    }>(`
      SELECT conversion_action.id, conversion_action.name, conversion_action.status,
             conversion_action.type
        FROM conversion_action
    `);
    return rows.flatMap((row) => {
      const action = row.conversionAction;
      if (!action?.id) return [];
      return [
        {
          id: String(action.id),
          name: action.name ?? String(action.id),
          status:
            action.status === 'ENABLED'
              ? ('active' as const)
              : action.status === 'REMOVED' || action.status === 'HIDDEN'
                ? ('inactive' as const)
                : ('unknown' as const),
          lastEventAt: null,
        },
      ];
    });
  }

  /** Names for geo target constants, one read for all of them. */
  private async regionNames(resourceNames: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const safe = resourceNames.filter((name) => /^geoTargetConstants\/\d+$/.test(name));
    if (safe.length === 0) return names;
    const rows = await this.reader.search<{
      geoTargetConstant?: { resourceName?: string; name?: string };
    }>(`
      SELECT geo_target_constant.resource_name, geo_target_constant.name
        FROM geo_target_constant
       WHERE geo_target_constant.resource_name IN (${safe.map((name) => `'${name}'`).join(', ')})
    `);
    for (const row of rows) {
      const constant = row.geoTargetConstant;
      if (constant?.resourceName && constant.name) names.set(constant.resourceName, constant.name);
    }
    return names;
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

  // --- writes: refused here; rehearsed (validateOnly) here and in the write client ---

  protected notSupported(what: string): MutationOutcome {
    return {
      status: 'rejected',
      code: 'google_read_only',
      message: `${what}: este cliente do Google é somente leitura.`,
    };
  }

  async setDailyBudget(_campaignId: string, _dailyBudgetCents: Cents): Promise<MutationOutcome> {
    return this.notSupported('Alterar orçamento');
  }

  async pauseCampaign(_campaignId: string): Promise<MutationOutcome> {
    return this.notSupported('Pausar campanha');
  }

  async resumeCampaign(_campaignId: string, _enableWith?: ResumeCompanions): Promise<MutationOutcome> {
    return this.notSupported('Reativar campanha');
  }

  async createCampaign(_spec: CreateCampaignSpec): Promise<MutationOutcome> {
    return this.notSupported('Criar campanha');
  }

  async setAccountSpendCap(): Promise<{ status: 'applied' | 'rejected'; message?: string }> {
    return { status: 'rejected', message: 'O saldo pré-pago do Google não é ajustável pela API.' };
  }

  /** True only on the write client. The transport checks it on every mutate. */
  protected get mayWrite(): boolean {
    return false;
  }

  protected get timeoutMs(): number {
    return 20_000;
  }

  protected get customer(): string {
    return `customers/${this.accountExternalId}`;
  }

  /**
   * The same request the write would send, checked by Google against the real
   * account with `validateOnly: true`: every field, every limit, every policy
   * the API enforces at write time — and nothing is created or changed.
   */
  async validateWrite(write: PlannedWrite): Promise<PreflightOutcome> {
    const plan = await this.plan(write);
    if (!plan.ok) return { status: 'rejected', code: plan.code, message: plan.message };
    const sent = await this.mutate(plan.operations, { validateOnly: true });
    if (sent.status === 'ok') return { status: 'ok', operations: plan.labels.map(labelOf) };
    if (sent.status === 'rejected') return sent;
    return { status: 'unavailable', reason: sent.reason };
  }

  /**
   * Turns a planned write into Google's operations. Reads only — locations are
   * resolved, a budget is looked up — so a plan that cannot be made sends
   * nothing, and a plan made once serves both the rehearsal and the write.
   */
  protected async plan(write: PlannedWrite): Promise<Plan> {
    switch (write.kind) {
      case 'create_campaign':
        return this.planCreate(write.spec);
      case 'set_daily_budget': {
        const budget = await this.budgetOf(write.campaignId);
        if (!budget.ok) return budget;
        if (budget.explicitlyShared) {
          return {
            ok: false,
            code: 'google_shared_budget',
            message:
              'Esta campanha usa um orçamento compartilhado no Google: alterá-lo mudaria outras campanhas. Ajuste no Google Ads.',
          };
        }
        return {
          ok: true,
          operations: [
            {
              campaignBudgetOperation: {
                update: {
                  resourceName: budget.resourceName,
                  amountMicros: microsFromCents(write.dailyBudgetCents),
                },
                updateMask: 'amount_micros',
              },
            },
          ],
          labels: [{ kind: 'budget', label: 'Orçamento diário' }],
          detail: { budget: budget.resourceName },
        };
      }
      case 'pause_campaign':
        return {
          ok: true,
          operations: [statusUpdate('campaignOperation', this.campaignName(write.campaignId), 'PAUSED')],
          labels: [{ kind: 'campaign', label: 'Campanha pausada' }],
          detail: {},
        };
      case 'resume_campaign': {
        const companions = write.enableWith ?? { adGroupIds: [], adIds: [] };
        return {
          ok: true,
          operations: [
            statusUpdate('campaignOperation', this.campaignName(write.campaignId), 'ENABLED'),
            ...companions.adGroupIds.map((id) =>
              statusUpdate('adGroupOperation', `${this.customer}/adGroups/${id}`, 'ENABLED'),
            ),
            ...companions.adIds.map((id) =>
              statusUpdate('adGroupAdOperation', `${this.customer}/adGroupAds/${id}`, 'ENABLED'),
            ),
          ],
          labels: [
            { kind: 'campaign', label: 'Campanha ativada' },
            ...companions.adGroupIds.map(
              (id): PlanLabel => ({ kind: 'ad_group', label: `Grupo ${id} ativado` }),
            ),
            ...companions.adIds.map(
              (id): PlanLabel => ({ kind: 'ad', label: `Anúncio ${id} ativado` }),
            ),
          ],
          detail: { enabled: companions },
        };
      }
    }
  }

  private campaignName(campaignId: string): string {
    return `${this.customer}/campaigns/${campaignId}`;
  }

  private async budgetOf(
    campaignId: string,
  ): Promise<
    | { ok: true; resourceName: string; explicitlyShared: boolean }
    | { ok: false; code: string; message: string }
  > {
    if (!/^\d+$/.test(campaignId)) {
      return { ok: false, code: 'campaign_not_found', message: 'Id de campanha inválido.' };
    }
    const [row] = await this.campaignRows(`campaign.id = ${campaignId}`);
    const resourceName = row?.campaignBudget?.resourceName;
    if (!row || !resourceName) {
      return {
        ok: false,
        code: 'campaign_not_found',
        message: 'Campanha não encontrada no Google, ou sem orçamento próprio.',
      };
    }
    return { ok: true, resourceName, explicitlyShared: row.campaignBudget?.explicitlyShared ?? false };
  }

  /**
   * Budget, campaign, its criteria (locations, radii, language, negatives),
   * one ad group, its keywords and its responsive search ad — ONE atomic
   * `googleAds:mutate` with temporary ids: all of it lands or none of it
   * does, so an `unknown` outcome leaves exactly one thing to look for and
   * never an orphaned budget or a campaign that cannot deliver.
   */
  protected async planCreate(spec: CreateCampaignSpec): Promise<Plan> {
    const google = spec.google;
    if (!google) {
      return { ok: false, code: 'google_spec_missing', message: 'Rascunho sem dados do Google.' };
    }
    // Defence in depth: the draft schema already refuses this.
    if (spec.status !== 'PAUSED') {
      return {
        ok: false,
        code: 'google_must_start_paused',
        message: 'Campanhas do Google nascem sempre pausadas.',
      };
    }
    if (google.channel === 'SEARCH' && !google.search) {
      return {
        ok: false,
        code: 'google_search_spec_missing',
        message: 'Rascunho de Pesquisa sem grupo de anúncios, palavras-chave ou anúncio.',
      };
    }

    // Reads first. A location Google cannot place is a refusal with nothing sent.
    let locations: ResolvedLocation[] = [];
    if (google.channel === 'SEARCH') {
      try {
        locations = await this.resolveLocations(google.reach);
      } catch (error) {
        if (error instanceof GeoResolutionError) {
          return { ok: false, code: 'geo_unresolved', message: error.message };
        }
        throw error;
      }
    }

    const budgetName = `${this.customer}/campaignBudgets/-1`;
    const campaignName = `${this.customer}/campaigns/-2`;
    const adGroupName = `${this.customer}/adGroups/-3`;

    const campaign: Record<string, unknown> = {
      resourceName: campaignName,
      name: spec.name,
      status: 'PAUSED',
      advertisingChannelType: google.channel,
      campaignBudget: budgetName,
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      ...campaignDates(google.startDate, google.endDate),
      ...googleBidding(google),
    };
    if (google.channel === 'SEARCH') {
      // Google Search only: no partners, no Display expansion. The draft's
      // `network` has one value, and this is it.
      campaign.networkSettings = {
        targetGoogleSearch: true,
        targetSearchNetwork: false,
        targetContentNetwork: false,
        targetPartnerSearchNetwork: false,
      };
      // From the approved draft: people who are in the place (PRESENCE), or
      // also people who searched about it.
      campaign.geoTargetTypeSetting = {
        positiveGeoTargetType: google.search?.locationMode ?? 'PRESENCE',
      };
    }

    const operations: Record<string, unknown>[] = [
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
    const labels: PlanLabel[] = [
      { kind: 'budget', label: `Orçamento ${spec.name}` },
      { kind: 'campaign', label: `Campanha ${spec.name}` },
    ];

    if (google.channel === 'SEARCH' && google.search) {
      const geo = googleLocationCriteria(campaignName, locations, google.reach.customLocations);
      operations.push(...geo);
      labels.push(...geo.map((): PlanLabel => ({ kind: 'criterion', label: 'Localização' })));
      operations.push({
        campaignCriterionOperation: {
          create: {
            campaign: campaignName,
            language: { languageConstant: PORTUGUESE_LANGUAGE_CONSTANT },
          },
        },
      });
      labels.push({ kind: 'criterion', label: 'Idioma português' });

      const tree = googleSearchOperations(campaignName, adGroupName, google.search);
      operations.push(...tree.operations);
      labels.push(...tree.labels);
    }

    return {
      ok: true,
      operations,
      labels,
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
        ...(google.search
          ? {
              adGroup: google.search.adGroupName,
              network: 'google_search_only',
              locationMode: google.search.locationMode,
              bidding: google.search.bidding,
              maxCpcCents: google.search.maxCpcCents ?? null,
              keywords: google.search.keywords.length,
              negativeKeywords: google.search.negativeKeywords.length,
              headlines: google.search.headlines.length,
              descriptions: google.search.descriptions.length,
            }
          : {}),
      },
    };
  }

  /**
   * The one place a mutate leaves this process. A validate-only request is
   * exactly the write with one more flag; a real write is refused unless this
   * is the write client — the reader cannot be talked into writing.
   */
  protected async mutate(
    operations: Record<string, unknown>[],
    options: { validateOnly: boolean },
  ): Promise<MutateResult> {
    if (!options.validateOnly && !this.mayWrite) {
      return {
        status: 'rejected',
        code: 'google_read_only',
        message: 'Este cliente do Google é somente leitura.',
      };
    }
    let response: Response;
    try {
      response = await this.reader.transport(
        `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/${this.customer}/googleAds:mutate`,
        {
          method: 'POST',
          headers: await this.reader.requestHeaders(),
          body: JSON.stringify({
            mutateOperations: operations,
            partialFailure: false,
            ...(options.validateOnly ? { validateOnly: true } : {}),
          }),
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
        message: failure.message ?? `O Google recusou a operação (${response.status})`,
      };
    }
    return { status: 'ok', body: text };
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
 * The only Google client that can change anything: one more campaign (paused,
 * with its ad group and ad), or the budget or status of one that exists.
 */
export class GoogleAdsWriteClient extends GoogleAdsPlatformClient {
  private readonly writeTimeoutMs: number;

  constructor(reader: GoogleAdsReadClient, options: GoogleWriteClientOptions) {
    super(reader, options.now);
    if (options.confirmWrites !== true) {
      throw new Error('GoogleAdsWriteClient requires confirmWrites: true');
    }
    this.writeTimeoutMs = options.timeoutMs ?? 20_000;
  }

  protected override get mayWrite(): boolean {
    return true;
  }

  protected override get timeoutMs(): number {
    return this.writeTimeoutMs;
  }

  override async createCampaign(spec: CreateCampaignSpec): Promise<MutationOutcome> {
    const plan = await this.planCreate(spec);
    if (!plan.ok) return { status: 'rejected', code: plan.code, message: plan.message };

    const sent = await this.mutate(plan.operations, { validateOnly: false });
    if (sent.status !== 'ok') return sent;

    const results = mutateResults(sent.body);
    const id = createdCampaignId(results);
    // Google said yes but we cannot tell what it made: it exists, id unknown.
    if (!id)
      return { status: 'unknown', reason: 'campaign created but the response carried no id' };

    const created = await this.getCampaign(id);
    if (!created) return { status: 'unknown', reason: 'campaign unreadable after creation' };
    return {
      status: 'applied',
      campaign: created,
      detail: plan.detail,
      created: createdObjects(plan.labels, results),
    };
  }

  private async applyToCampaign(
    campaignId: string,
    write: PlannedWrite,
  ): Promise<MutationOutcome> {
    const plan = await this.plan(write);
    if (!plan.ok) return { status: 'rejected', code: plan.code, message: plan.message };
    const sent = await this.mutate(plan.operations, { validateOnly: false });
    if (sent.status !== 'ok') return sent;
    const campaign = await this.getCampaign(campaignId);
    if (!campaign) return { status: 'unknown', reason: 'campaign unreadable after the change' };
    return { status: 'applied', campaign, detail: plan.detail };
  }

  override async setDailyBudget(campaignId: string, dailyBudgetCents: Cents): Promise<MutationOutcome> {
    return this.applyToCampaign(campaignId, { kind: 'set_daily_budget', campaignId, dailyBudgetCents });
  }

  override async pauseCampaign(campaignId: string): Promise<MutationOutcome> {
    return this.applyToCampaign(campaignId, { kind: 'pause_campaign', campaignId });
  }

  override async resumeCampaign(
    campaignId: string,
    enableWith?: ResumeCompanions,
  ): Promise<MutationOutcome> {
    return this.applyToCampaign(campaignId, { kind: 'resume_campaign', campaignId, enableWith });
  }
}

interface PlanLabel {
  kind: 'budget' | 'campaign' | 'criterion' | CreatedObject['kind'];
  label: string;
}

type Plan =
  | {
      ok: true;
      operations: Record<string, unknown>[];
      /** One per operation, in order: what each one is, for people. */
      labels: PlanLabel[];
      detail: Record<string, unknown>;
    }
  | { ok: false; code: string; message: string };

type MutateResult =
  | { status: 'ok'; body: string }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unknown'; reason: string };

function labelOf(label: PlanLabel): string {
  return label.label;
}

/**
 * The bidding strategy, from the approved draft. A Search campaign says how
 * it bids in `search` (maximize clicks with a CPC ceiling, or maximize
 * conversions); Demand Gen keeps the objective-derived choice.
 */
function googleBidding(google: NonNullable<CreateCampaignSpec['google']>): Record<string, unknown> {
  const bidding = google.search?.bidding ?? google.bidding;
  if (bidding === 'MAXIMIZE_CLICKS') {
    const ceiling = google.search?.maxCpcCents;
    return {
      targetSpend: ceiling ? { cpcBidCeilingMicros: microsFromCents(ceiling) } : {},
    };
  }
  return { maximizeConversions: {} };
}

function statusUpdate(
  operation: 'campaignOperation' | 'adGroupOperation' | 'adGroupAdOperation',
  resourceName: string,
  status: 'ENABLED' | 'PAUSED',
): Record<string, unknown> {
  return { [operation]: { update: { resourceName, status }, updateMask: 'status' } };
}

/**
 * The ad group, its keywords, the campaign's negatives and the responsive
 * search ad. Every keyword carries the match the draft wrote (exact or
 * phrase; never broad); negatives are phrase, on the campaign, so they hold
 * for any ad group added later by hand. Ad group and ad are born PAUSED like
 * the campaign: switching on is `resume_campaign`, which enables the three.
 */
export function googleSearchOperations(
  campaignName: string,
  adGroupName: string,
  search: GoogleSearchSpec,
): { operations: Record<string, unknown>[]; labels: PlanLabel[] } {
  const operations: Record<string, unknown>[] = [];
  const labels: PlanLabel[] = [];

  for (const text of search.negativeKeywords) {
    operations.push({
      campaignCriterionOperation: {
        create: { campaign: campaignName, negative: true, keyword: { text, matchType: 'PHRASE' } },
      },
    });
    labels.push({ kind: 'negative_keyword', label: `Negativa "${text}"` });
  }

  operations.push({
    adGroupOperation: {
      create: {
        resourceName: adGroupName,
        name: search.adGroupName,
        campaign: campaignName,
        status: 'PAUSED',
        type: 'SEARCH_STANDARD',
      },
    },
  });
  labels.push({ kind: 'ad_group', label: `Grupo ${search.adGroupName}` });

  for (const keyword of search.keywords) {
    operations.push({
      adGroupCriterionOperation: {
        create: {
          adGroup: adGroupName,
          status: 'ENABLED',
          keyword: { text: keyword.text, matchType: keyword.match },
        },
      },
    });
    labels.push({
      kind: 'keyword',
      label: keyword.match === 'EXACT' ? `[${keyword.text}]` : `"${keyword.text}"`,
    });
  }

  operations.push({
    adGroupAdOperation: {
      create: {
        adGroup: adGroupName,
        status: 'PAUSED',
        ad: {
          finalUrls: [search.finalUrl],
          responsiveSearchAd: {
            headlines: search.headlines.map((text) => ({ text })),
            descriptions: search.descriptions.map((text) => ({ text })),
          },
        },
      },
    },
  });
  labels.push({ kind: 'ad', label: 'Anúncio responsivo de pesquisa' });

  return { operations, labels };
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

interface MutateOperationResponse {
  campaignBudgetResult?: { resourceName?: string };
  campaignResult?: { resourceName?: string };
  campaignCriterionResult?: { resourceName?: string };
  adGroupResult?: { resourceName?: string };
  adGroupCriterionResult?: { resourceName?: string };
  adGroupAdResult?: { resourceName?: string };
}

function mutateResults(body: string): MutateOperationResponse[] {
  try {
    const parsed = JSON.parse(body) as { mutateOperationResponses?: MutateOperationResponse[] };
    return parsed.mutateOperationResponses ?? [];
  } catch {
    return [];
  }
}

function createdCampaignId(results: MutateOperationResponse[]): string | null {
  for (const entry of results) {
    const match = /\/campaigns\/(\d+)$/.exec(entry.campaignResult?.resourceName ?? '');
    if (match?.[1]) return match[1];
  }
  return null;
}

/** The last path segment of a resource name: `123`, or `123~456` for an ad. */
function idOf(resourceName: string | undefined): string | null {
  const match = /\/([^/]+)$/.exec(resourceName ?? '');
  return match?.[1] ?? null;
}

/**
 * Pairs each operation's label with what Google made of it, in order. Only
 * the objects worth a step (ad group, keywords, negatives, ad) are listed:
 * the campaign has its own step and criteria are evidence in `detail`.
 */
function createdObjects(
  labels: PlanLabel[],
  results: MutateOperationResponse[],
): CreatedObject[] {
  const created: CreatedObject[] = [];
  labels.forEach((label, index) => {
    const result = results[index];
    const externalId =
      label.kind === 'ad_group'
        ? idOf(result?.adGroupResult?.resourceName)
        : label.kind === 'keyword'
          ? idOf(result?.adGroupCriterionResult?.resourceName)
          : label.kind === 'negative_keyword'
            ? idOf(result?.campaignCriterionResult?.resourceName)
            : label.kind === 'ad'
              ? idOf(result?.adGroupAdResult?.resourceName)
              : null;
    if (
      label.kind === 'ad_group' ||
      label.kind === 'keyword' ||
      label.kind === 'negative_keyword' ||
      label.kind === 'ad'
    ) {
      created.push({ kind: label.kind, label: label.label, externalId: externalId ?? '' });
    }
  });
  return created;
}

/**
 * Google's error, in one line a person can act on: the code of the first
 * error, and up to three messages each prefixed by the field it points at
 * (`operations[7].create.keyword.text`), which is what tells a headline that
 * is too long from a keyword Google refuses.
 */
export function googleFailure(body: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
        details?: {
          errors?: {
            message?: string;
            errorCode?: Record<string, string>;
            location?: { fieldPathElements?: { fieldName?: string; index?: number }[] };
          }[];
        }[];
      };
    };
    const errors = parsed.error?.details?.flatMap((detail) => detail.errors ?? []) ?? [];
    const first = errors[0];
    const code = first?.errorCode ? Object.values(first.errorCode)[0] : undefined;
    const lines = errors.slice(0, 3).map((error) => {
      const path = (error.location?.fieldPathElements ?? [])
        .map((element) =>
          element.index === undefined ? element.fieldName : `${element.fieldName}[${element.index}]`,
        )
        .join('.');
      return path ? `${path}: ${error.message ?? ''}` : (error.message ?? '');
    });
    const message = lines.filter(Boolean).join(' · ') || parsed.error?.message;
    return { code, message };
  } catch {
    return {};
  }
}
