import { zodResolver } from '@hookform/resolvers/zod';
import {
  AGENT_DRAFT_FIELD_LABEL,
  BRAZIL_STATES,
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_OBJECTIVE_HINT,
  CAMPAIGN_OBJECTIVE_LABEL,
  CALL_TO_ACTION_LABEL,
  CREATIVE_TYPE_LABEL,
  HEADLINE_MAX,
  CREATIVE_FORMATS,
  DEFAULT_AGE_MAX,
  DEFAULT_AGE_MIN,
  ICP_MAX,
  MAX_AGE,
  MAX_KEYWORDS,
  MAX_NEGATIVE_KEYWORDS,
  MAX_SEARCH_DESCRIPTIONS,
  MAX_SEARCH_HEADLINES,
  MIN_SEARCH_DESCRIPTIONS,
  MIN_SEARCH_HEADLINES,
  MAX_VARIATIONS,
  adUtmContent,
  addAdsRequestSchema,
  MIN_AGE,
  minDailyBudgetCents,
  PAID_PLATFORMS,
  PLACEMENT_POSITION_LABEL,
  PLACEMENT_PUBLISHERS,
  PLACEMENT_PUBLISHER_LABEL,
  PLACEMENT_PUBLISHER_POSITIONS,
  PLATFORM_STATUS_LABEL,
  SEARCH_DESCRIPTION_MAX,
  SEARCH_HEADLINE_MAX,
  UTM_KEYS,
  adDestination,
  GOOGLE_ACCOUNT_URL_SUFFIX,
  META_URL_TAGS,
  utmsFromPlatform,
  audienceProfileSchema,
  buildUtms,
  campaignDays,
  campaignDaysInMonth,
  campaignDraftSchema,
  checkCopyCompliance,
  dailyOverdeliveryFactor,
  describeLeadCapture,
  describeReach,
  LEAD_FORM_THANK_YOU_DEFAULT,
  estimateCostCents,
  isGooglePlatform,
  isPlatformEnabled,
  formatSearchKeyword,
  keywordWithMatch,
  parseSearchKeyword,
  type SearchMatchType,
  periodOverdeliveryFactor,
  platformAcceptsRadius,
  usesVerticalPlacements,
  type CampaignDraft,
  type CampaignDraftInput,
  type MediaBridgeResponse,
  type BrazilState,
  type AgentCampaignProposal,
  type Placements,
  DEFAULT_MAX_CPC_CENTS,
  SEARCH_BIDDING_LABEL,
  SEARCH_BIDDING_STRATEGIES,
  SEARCH_LOCATION_MODES,
  SEARCH_LOCATION_MODE_LABEL,
  projectSpendCapPause,
} from '@wings/shared';
import { useEffect, useState, type MutableRefObject, type ReactNode } from 'react';
import { useFieldArray, useForm, type Resolver, useController } from 'react-hook-form';
import { Link } from 'react-router-dom';
import {
  useAudienceProfile,
  useCockpit,
  useMetaIdentities,
  usePlatformRefresh,
  useRequestAddAds,
  useRequestCampaign,
  useSaveAudienceProfile,
  useSaveMetaIdentityDefault,
  loadSavedDraft,
  useDeleteSavedDraft,
  useSaveDraft,
  useSavedDrafts,
} from '../../api/ads.js';
import { ApiError } from '../../api/client.js';
import { useDashboardCampaigns } from '../../api/dashboard.js';
import { Alert, Button, Field, Input, Select } from '../ui.js';
import { BUILDER_DRAFT_KEY, PICKED_MEDIA_KEY } from '../../api/media.js';
import { AccountCeiling } from './AccountCeiling.js';
import { AdPreviewGallery } from './AdPreview.js';
import { ComplianceWarning, CreativeCard } from './CreativeBlock.js';
import { formatBrl, formatDate, parseBrlToCents, todayInSaoPaulo } from './format.js';
import { SearchAdPreview, YoutubePreview } from './GooglePreview.js';
import { LeadFormPreviewGallery } from './LeadFormPreview.js';
import { LeadFormSection, siteFormOf } from './LeadFormSection.js';
import { RadiusMap } from './RadiusMap.js';

/**
 * The paid-media tab of the campaign builder.
 *
 * Sections follow the order the operator fills them in. Nothing here writes to
 * an ad platform: the form's only output is a draft that becomes a
 * `create_campaign` request in front of the approvals gate.
 */

/** An emptied age box is "not informed", never NaN. */
function ageFromInput(value: unknown): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined;
  const age = Number(value);
  return Number.isFinite(age) ? age : undefined;
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** A textarea as a list: one item per line, trimmed, empty lines dropped. */
function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Keywords the way Google writes them. A line already marked — `[exata]` or
 * `"frase"` — keeps its match; a bare line takes the match chosen for the
 * list. Broad match never leaves the form: it is what a bare term would mean.
 */
function markKeywords(lines: string[], defaultMatch: SearchMatchType): string[] {
  return lines.map((line) =>
    parseSearchKeyword(line)
      ? line
      : formatSearchKeyword({
          text: line.replace(/^[["]+|[\]"]+$/g, '').trim(),
          match: defaultMatch,
        }),
  );
}

/**
 * What is validated and sent: only the parts that belong to the chosen
 * platform. The form keeps every platform's fields in its state, so switching
 * back and forth loses nothing; the schema refuses foreign parts, so they are
 * dropped here — once, for the check and for the request alike.
 */
/**
 * The form travels only on a lead campaign, and only on Meta when the lead is
 * captured on the ad (`instant_form`). A site page's form is a proposal of its
 * own (section "Formulário"), so a draft never carries it. The thank-you button
 * leads to the destination page.
 */
function shapeLeadForm(
  values: CampaignDraftInput,
): Pick<CampaignDraftInput, 'leadCapture' | 'leadForm'> {
  if (values.objective !== 'lead') return {};
  const instant = values.platform === 'meta' && values.leadCapture === 'instant_form';
  if (!instant || !values.leadForm) return { leadCapture: 'page' };
  const form = values.leadForm;
  return {
    leadCapture: 'instant_form',
    leadForm: {
      ...form,
      qualifier: form.qualifier ?? null,
      thankYou: { ...form.thankYou, buttonUrl: form.thankYou.buttonUrl || values.destinationUrl },
    },
  };
}

function shapeDraft(values: CampaignDraftInput): CampaignDraftInput {
  const {
    youtube,
    search,
    formatKey,
    variations,
    ageMin,
    ageMax,
    placements,
    identity,
    leadCapture: _capture,
    leadForm: _form,
    ...rest
  } = values;
  void _capture;
  void _form;
  const common = { ...rest, ...shapeLeadForm(values) };
  if (!isGooglePlatform(values.platform)) {
    return {
      ...common,
      formatKey,
      variations: (variations ?? []).map(shapeVariation),
      ageMin,
      ageMax,
      // Automatic names no placement: whatever was ticked under "Manual" stays behind.
      placements:
        placements?.mode === 'manual'
          ? placements
          : { mode: 'automatic', facebook: [], instagram: [], threads: [] },
      identity: identity && {
        pageId: identity.pageId,
        instagramActorId: identity.instagramActorId || null,
      },
    };
  }

  const google = { ...common, startPaused: true };
  if (values.platform === 'youtube') return { ...google, youtube };
  return {
    ...google,
    search: search && {
      ...search,
      adGroupName: search.adGroupName?.trim() || undefined,
      // Boxes left empty are not headlines.
      headlines: search.headlines.filter((item) => item.trim() !== ''),
      descriptions: search.descriptions.filter((item) => item.trim() !== ''),
    },
  };
}

type VariationInput = NonNullable<CampaignDraftInput['variations']>[number];
type CardInput = NonNullable<VariationInput['cards']>[number];

/** A card sends its image or its video, never the leftovers of the other. */
function shapeCard(card: CardInput): CardInput {
  const { creativeId, videoId, ...copy } = card;
  return card.mediaType === 'video' ? { ...copy, videoId } : { ...copy, creativeId };
}

/** Likewise for a variation: only the media of the type that was chosen. */
function shapeVariation(variation: VariationInput): VariationInput {
  const { creativeId, videoId, cards, ...copy } = variation;
  const creativeType = variation.creativeType ?? 'image';
  if (creativeType === 'video') return { ...copy, creativeType, videoId };
  if (creativeType === 'carousel') {
    // A carousel's media sits in its cards: a library reference has no meaning here.
    const { mediaAssetId: _unused, ...words } = copy;
    void _unused;
    return { ...words, creativeType, cards: (cards ?? []).map(shapeCard) };
  }
  return { ...copy, creativeType, creativeId };
}

const schemaResolver = zodResolver(campaignDraftSchema) as Resolver<CampaignDraftInput>;
const draftResolver: Resolver<CampaignDraftInput> = (values, context, options) =>
  schemaResolver(shapeDraft(values), context, options);

/** The builder's sections, in the order they appear for each platform. */
const META_SECTIONS = [
  'platform',
  'objective',
  'icp',
  'reach',
  'placements',
  'identity',
  'creative',
  'format',
  'destination',
  'leadForm',
  'duration',
  'budget',
  'utms',
  'preview',
  'summary',
] as const;
/** Adding creatives to a Meta campaign that exists: only what the new ads need. */
const ADD_ADS_SECTIONS = [
  'platform',
  'identity',
  'creative',
  'destination',
  'utms',
  'preview',
] as const;
const YOUTUBE_SECTIONS = [
  'platform',
  'objective',
  'icp',
  'reach',
  'video',
  'leadForm',
  'duration',
  'budget',
  'utms',
  'preview',
  'summary',
] as const;
const SEARCH_SECTIONS = [
  'platform',
  'objective',
  'icp',
  'reach',
  'keywords',
  'searchSettings',
  'searchAd',
  'duration',
  'budget',
  'utms',
  'preview',
  'summary',
] as const;
type SectionKey =
  | (typeof META_SECTIONS)[number]
  | (typeof YOUTUBE_SECTIONS)[number]
  | (typeof SEARCH_SECTIONS)[number];

function BuilderSection({
  step,
  title,
  why,
  children,
}: {
  step: number;
  title: string;
  /**
   * What this choice changes in practice, in a media buyer's words. The hints
   * under the fields say how to fill them in; this says why it matters.
   */
  why: string;
  children: ReactNode;
}) {
  // A section outside the current mode's list has no step: it is not shown.
  if (step === 0) return null;
  return (
    <section className="builder-section" aria-labelledby={`builder-step-${step}`}>
      <h2 id={`builder-step-${step}`}>
        <span className="builder-step">{step}</span>
        {title}
      </h2>
      <p className="builder-why">{why}</p>
      {children}
    </section>
  );
}

/** "Facebook: Feed, Stories · Instagram: Reels", or what automatic means. */
function describePlacements(placements: Placements | CampaignDraftInput['placements']): string {
  if (!placements || placements.mode !== 'manual') return 'Automático (Advantage+)';
  const parts = PLACEMENT_PUBLISHERS.flatMap((publisher) => {
    const positions = placements[publisher] ?? [];
    return positions.length === 0
      ? []
      : [
          `${PLACEMENT_PUBLISHER_LABEL[publisher]}: ${positions
            .map((position) => PLACEMENT_POSITION_LABEL[position])
            .join(', ')}`,
        ];
  });
  return parts.join(' · ') || 'Manual — nenhum escolhido';
}

/**
 * How the conversation with the agent reaches this form. `getDraft` is what the
 * agent may read; `applyProposal` runs only from a click on a proposal card.
 * Neither submits anything: launching stays the person's own button.
 */
export interface BuilderBridge {
  getDraft: () => Record<string, unknown>;
  /** `pending` is the card's list of what only a person can choose. */
  applyProposal: (proposal: AgentCampaignProposal, pending?: string[]) => void;
  /** Fills the form with a saved draft, whole. Submits nothing. */
  applyDraft: (draft: CampaignDraft) => void;
}

/** Cents as the budget box shows them: 2000 -> "20,00". */
function centsToBudgetText(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    useGrouping: false,
  });
}

function padTo(list: string[], length: number): string[] {
  return Array.from({ length }, (_, index) => list[index] ?? '');
}

export function PaidMediaBuilder({
  canRequest,
  canPickMedia = false,
  canApprove = false,
  applyRef,
}: {
  canRequest: boolean;
  /** `ads.approve`: may approve a site page's pending form from the builder. */
  canApprove?: boolean;
  /** `marketing.media.read`: shows "Escolher do Drive" beside the uploads. */
  canPickMedia?: boolean;
  /** Filled while the builder is on screen, null otherwise. */
  applyRef?: MutableRefObject<BuilderBridge | null>;
}) {
  const today = todayInSaoPaulo();
  const launch = useRequestCampaign();
  const saveDraft = useSaveDraft();
  const savedDrafts = useSavedDrafts(canRequest);
  const deleteSavedDraft = useDeleteSavedDraft();
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [loadedDraftName, setLoadedDraftName] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    getValues,
    formState: { errors, dirtyFields, submitCount, isSubmitSuccessful },
  } = useForm<CampaignDraftInput>({
    resolver: draftResolver,
    defaultValues: {
      platform: 'meta',
      name: '',
      objective: 'lead',
      idealCustomerProfile: '',
      reach: { states: [], cities: [], customLocations: [] },
      formatKey: 'feed_square',
      // Wings' contact page: the RD form there feeds the Formatação funnel.
      destinationUrl: 'https://wingscompany.com.br/contato/',
      leadCapture: 'page',
      leadForm: {
        qualifier: null,
        privacyPolicyUrl: '',
        thankYou: { ...LEAD_FORM_THANK_YOU_DEFAULT, buttonUrl: '' },
        funnel: { pipeline: 'formatacao', brand: null, clientId: null },
      },
      // Opens with two, so the platform has something to compare; one is allowed.
      variations: Array.from({ length: 2 }, () => ({
        creativeType: 'image' as const,
        creativeId: '',
        cards: [],
        headline: '',
        primaryText: '',
        callToAction: 'LEARN_MORE' as const,
      })),
      ageMin: DEFAULT_AGE_MIN,
      ageMax: DEFAULT_AGE_MAX,
      placements: { mode: 'automatic', facebook: [], instagram: [], threads: [] },
      identity: { pageId: '', instagramActorId: null },
      youtube: { videoUrl: '', headline: '' },
      search: {
        adGroupName: '',
        network: 'google_search_only',
        locationMode: 'presence',
        bidding: 'maximize_clicks',
        maxCpcCents: DEFAULT_MAX_CPC_CENTS,
        keywords: [],
        negativeKeywords: [],
        headlines: Array.from({ length: MAX_SEARCH_HEADLINES }, () => ''),
        descriptions: Array.from({ length: MAX_SEARCH_DESCRIPTIONS }, () => ''),
      },
      startDate: today,
      endDate: addDays(today, 6),
      utms: buildUtms({ platform: 'meta', objective: 'lead', campaignName: '' }),
      startPaused: true,
    },
  });
  const variations = useFieldArray({ control, name: 'variations' });
  const cities = useFieldArray({ control, name: 'reach.cities' });
  const [checked, setChecked] = useState<CampaignDraft | null>(null);

  // The builder starts from what Wings saved as its standing audience. Once
  // loaded it is the operator's to edit: this campaign keeps its own copy.
  const audience = useAudienceProfile();
  const saveAudience = useSaveAudienceProfile();
  const savedAudience = audience.data?.profile;
  const [audienceLoaded, setAudienceLoaded] = useState(false);
  const [audienceProblem, setAudienceProblem] = useState<string | null>(null);
  const [newCity, setNewCity] = useState<{ name: string; state: BrazilState | '' }>({
    name: '',
    state: '',
  });
  const { replace: replaceCities } = cities;
  useEffect(() => {
    if (!savedAudience || audienceLoaded) return;
    setAudienceLoaded(true);
    if (dirtyFields.idealCustomerProfile || dirtyFields.reach) return;
    setValue('idealCustomerProfile', savedAudience.idealCustomerProfile);
    setValue('reach.states', savedAudience.reach.states);
    // A field array only follows its own methods, not setValue.
    replaceCities(savedAudience.reach.cities);
    setValue('reach.customLocations', savedAudience.reach.customLocations);
  }, [
    savedAudience,
    audienceLoaded,
    dirtyFields.idealCustomerProfile,
    dirtyFields.reach,
    setValue,
    replaceCities,
  ]);

  const values = watch();
  const { platform } = values;
  // Meta only: a new campaign, or new creatives in one that exists (`add_ads`).
  const [target, setTarget] = useState<'new' | 'existing'>('new');
  const [targetCampaign, setTargetCampaign] = useState('');
  const [addAdsProblem, setAddAdsProblem] = useState<string | null>(null);
  const addAds = useRequestAddAds();
  const existingCampaigns = useDashboardCampaigns(30);
  const cockpit = useCockpit({ days: 7, platform });
  const pacing = cockpit.isLoading ? undefined : (cockpit.data?.cockpit.pacing ?? null);
  const wingsTotal = cockpit.data?.cockpit.wingsTotal ?? null;
  // The platform's balance and limits, re-read on opening and every 5 minutes
  // while the builder stays open (the scheduled task reads every 15). The
  // server skips the call when the account was read in the last 2 minutes.
  const cockpitAccountId = cockpit.data?.cockpit.account.id;
  const { mutate: refreshPlatform } = usePlatformRefresh(cockpitAccountId);
  useEffect(() => {
    if (!cockpitAccountId) return;
    refreshPlatform();
    const timer = window.setInterval(() => refreshPlatform(), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [cockpitAccountId, refreshPlatform]);
  const google = isGooglePlatform(platform);
  const addingToExisting = platform === 'meta' && target === 'existing';
  const sections: readonly SectionKey[] =
    platform === 'youtube'
      ? YOUTUBE_SECTIONS
      : platform === 'google_search'
        ? SEARCH_SECTIONS
        : addingToExisting
          ? ADD_ADS_SECTIONS
          : META_SECTIONS;
  const stepOf = (key: SectionKey) => sections.indexOf(key) + 1;
  const platformLabel = PAID_PLATFORMS.find((item) => item.key === platform)?.label ?? '—';

  // A radius drawn for one platform must not travel to one that takes none.
  const acceptsRadius = platformAcceptsRadius(platform);
  useEffect(() => {
    if (acceptsRadius) return;
    setValue('reach.customLocations', []);
  }, [acceptsRadius, setValue]);

  // The Facebook Page and Instagram account the ads are published as: read from
  // Meta, never typed in. Only Meta campaigns ask.
  const identities = useMetaIdentities(!google);
  const saveIdentityDefault = useSaveMetaIdentityDefault();
  const pages = identities.data?.identities.pages ?? [];
  const identityDefault = identities.data?.identities.default ?? null;
  const identityFailure = identities.error instanceof ApiError ? identities.error : null;
  const metaNotConfigured = identityFailure?.code === 'meta_not_configured';
  const [keepIdentity, setKeepIdentity] = useState(false);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const chosenPage = pages.find((page) => page.id === values.identity?.pageId);
  const chosenInstagram = chosenPage?.instagramAccounts.find(
    (account) => account.id === values.identity?.instagramActorId,
  );
  useEffect(() => {
    if (identityLoaded || !identities.data) return;
    setIdentityLoaded(true);
    if (dirtyFields.identity) return;
    // Wings' saved choice; failing that, the only page there is.
    const onlyPage = pages.length === 1 ? pages[0] : undefined;
    const start =
      identityDefault && pages.some((page) => page.id === identityDefault.pageId)
        ? identityDefault
        : onlyPage && { pageId: onlyPage.id, instagramActorId: null };
    if (!start) return;
    setValue('identity.pageId', start.pageId);
    setValue('identity.instagramActorId', start.instagramActorId);
  }, [identities.data, identityLoaded, dirtyFields.identity, identityDefault, pages, setValue]);

  const identityOptions = { shouldDirty: true, shouldValidate: submitCount > 0 };

  const vertical = usesVerticalPlacements(values.placements as Placements | undefined);

  // Keywords are typed one per line; the form holds them as the list it sends.
  const [keywordsText, setKeywordsText] = useState('');
  const [negativeKeywordsText, setNegativeKeywordsText] = useState('');
  // The match a line gets when the operator does not mark it. Exact by
  // default: the tightest, for an account still learning which searches pay.
  const [defaultMatch, setDefaultMatch] = useState<SearchMatchType>('exact');
  // The CPC ceiling box keeps its own text, like the budget box.
  const [maxCpcText, setMaxCpcText] = useState(centsToBudgetText(DEFAULT_MAX_CPC_CENTS));
  const maxCpcController = useController({ control, name: 'search.maxCpcCents' });
  const maxCpcField = {
    name: maxCpcController.field.name,
    onBlur: maxCpcController.field.onBlur,
    onChange: (event: { target: { value: string } }) =>
      maxCpcController.field.onChange(parseBrlToCents(event.target.value)),
  };

  const days = campaignDays(values.startDate, values.endDate);
  // The estimate reads what is in the box, as typed. It must never wait on
  // the form library's copy of the value to show a number the operator is
  // about to commit money against.
  const [budgetText, setBudgetText] = useState('');
  const typedBudgetCents = parseBrlToCents(budgetText);
  const dailyBudgetCents = Number.isFinite(typedBudgetCents) ? typedBudgetCents : 0;
  const totalCostCents = days ? estimateCostCents(dailyBudgetCents, days, platform) : null;
  // On Google a short run is decided by one worst day (2×), not by the period.
  const costIsOneWorstDay =
    days !== null &&
    dailyBudgetCents * dailyOverdeliveryFactor(platform) >
      dailyBudgetCents * days * periodOverdeliveryFactor(platform);
  // Why there is no estimate yet, in the operator's terms — never a bare dash.
  const costMissing =
    budgetText.trim() === ''
      ? 'Falta a verba por dia.'
      : !Number.isFinite(typedBudgetCents)
        ? `Não entendi “${budgetText.trim()}”. Digite só o valor, como 20,00.`
        : dailyBudgetCents < minDailyBudgetCents(platform)
          ? `A verba por dia precisa ser de pelo menos ${formatBrl(minDailyBudgetCents(platform))}.`
          : !values.startDate || !values.endDate
            ? 'Falta escolher o início e o fim da campanha.'
            : days === null
              ? 'O fim da campanha está antes do início.'
              : null;
  // A controlled field, not a registered input: the box shows its own text
  // ("120,00") and hands the form the cents. A registered input would be
  // re-written with the raw cents ("12000") by the form library after a
  // value set from a saved draft or a proposal.
  const budgetController = useController({ control, name: 'dailyBudgetCents' });
  const budgetField = {
    name: budgetController.field.name,
    onBlur: budgetController.field.onBlur,
    onChange: (event: { target: { value: string } }) =>
      budgetController.field.onChange(parseBrlToCents(event.target.value)),
  };
  const daysThisMonth = campaignDaysInMonth(values.startDate, values.endDate, today);
  const costThisMonthCents = estimateCostCents(dailyBudgetCents, daysThisMonth, platform);
  const overCeiling =
    pacing != null &&
    pacing.platformReading.status === 'ok' &&
    dailyBudgetCents > 0 &&
    costThisMonthCents > pacing.availableCents;

  // When Meta itself would stop the whole account: the active campaigns plus
  // this one, day by day, against the account's spending limit (which starts
  // over on the 1st when the account's rule says so).
  const reading = pacing?.platformReading;
  const pauseIncludesThis =
    platform === 'meta' && !addingToExisting && costMissing === null && dailyBudgetCents > 0;
  const spendCapPause =
    platform === 'meta' &&
    reading?.status === 'ok' &&
    reading.spendCapCents !== null &&
    reading.spendCapRemainingCents !== null
      ? projectSpendCapPause({
          today,
          remainingCents: reading.spendCapRemainingCents,
          spendCapCents: reading.spendCapCents,
          reset: reading.spendCapReset,
          streams: [
            ...(cockpit.data?.cockpit.activeBudgets ?? []),
            ...(pauseIncludesThis
              ? [
                  {
                    dailyBudgetCents,
                    startDate: values.startDate || null,
                    endDate: values.endDate || null,
                  },
                ]
              : []),
          ],
        })
      : null;

  // A proposal from the agent, applied by a click on its card. It fills what the
  // agent can know and leaves the rest as the person had it: images, videos,
  // the Page and the Instagram account are never touched, and nothing is sent.
  const [appliedProposal, setAppliedProposal] = useState<AgentCampaignProposal | null>(null);
  const [appliedPending, setAppliedPending] = useState<string[]>([]);
  // Once a proposal brought its own UTMs they are the person's to edit: the
  // automatic ones stop following the name.
  const [utmsFromProposal, setUtmsFromProposal] = useState(false);
  const { append: appendVariation } = variations;
  const applyProposal = (proposal: AgentCampaignProposal, pending: string[] = []) => {
    const filled = { shouldDirty: true, shouldValidate: submitCount > 0 };
    // The saved audience must not overwrite what is applied here.
    setAudienceLoaded(true);
    setValue('platform', proposal.platform, filled);
    setValue('name', proposal.name, filled);
    setValue('objective', proposal.objective, filled);
    setValue('idealCustomerProfile', proposal.idealCustomerProfile, filled);
    setValue('reach.states', proposal.reach.states, filled);
    replaceCities(proposal.reach.cities);
    setValue('reach.customLocations', proposal.reach.customLocations, filled);
    setValue('destinationUrl', proposal.destinationUrl, filled);
    setUtmsFromProposal(true);
    for (const key of UTM_KEYS) setValue(`utms.${key}`, proposal.utms[key], filled);
    setValue('dailyBudgetCents', proposal.dailyBudgetCents, filled);
    setBudgetText(centsToBudgetText(proposal.dailyBudgetCents));
    setValue('startDate', proposal.startDate, filled);
    setValue('endDate', proposal.endDate, filled);

    if (proposal.platform === 'meta') {
      if (proposal.ageMin !== undefined) setValue('ageMin', proposal.ageMin, filled);
      if (proposal.ageMax !== undefined) setValue('ageMax', proposal.ageMax, filled);
      if (proposal.formatKey) setValue('formatKey', proposal.formatKey, filled);
      if (proposal.placements) {
        setValue('placements.mode', proposal.placements.mode, filled);
        setValue('placements.facebook', proposal.placements.facebook, filled);
        setValue('placements.instagram', proposal.placements.instagram, filled);
        setValue('placements.threads', proposal.placements.threads, filled);
      }
      const existing = getValues('variations') ?? [];
      proposal.copy.forEach((copy, index) => {
        if (index < existing.length) {
          setValue(`variations.${index}.headline`, copy.headline, filled);
          setValue(`variations.${index}.primaryText`, copy.primaryText, filled);
          setValue(`variations.${index}.callToAction`, copy.callToAction, filled);
        } else {
          appendVariation({
            creativeType: 'image',
            creativeId: '',
            cards: [],
            headline: copy.headline,
            primaryText: copy.primaryText,
            callToAction: copy.callToAction,
          });
        }
      });
    }
    if (proposal.platform === 'google_search' && proposal.search) {
      // Google's own notation for the match type: [exact], "phrase" — and a
      // broad proposal is tightened to the form's default, never sent broad.
      const keywords = markKeywords(proposal.search.keywords.map(keywordWithMatch), 'exact');
      setValue('search.keywords', keywords, filled);
      setValue('search.negativeKeywords', proposal.search.negativeKeywords, filled);
      setKeywordsText(keywords.join('\n'));
      setNegativeKeywordsText(proposal.search.negativeKeywords.join('\n'));
      setValue('search.headlines', padTo(proposal.search.headlines, MAX_SEARCH_HEADLINES), filled);
      setValue(
        'search.descriptions',
        padTo(proposal.search.descriptions, MAX_SEARCH_DESCRIPTIONS),
        filled,
      );
      setValue('search.adGroupName', proposal.search.adGroupName ?? '', filled);
      // Network, place and bid: the proposal's, or the builder's defaults.
      setValue('search.locationMode', proposal.search.locationMode ?? 'presence', filled);
      setValue('search.bidding', proposal.search.bidding ?? 'maximize_clicks', filled);
      const cpc = proposal.search.maxCpcCents ?? DEFAULT_MAX_CPC_CENTS;
      setValue('search.maxCpcCents', cpc, filled);
      setMaxCpcText(centsToBudgetText(cpc));
    }
    if (proposal.platform === 'youtube' && proposal.youtube) {
      setValue('youtube.headline', proposal.youtube.headline, filled);
      if (proposal.youtube.videoUrl)
        setValue('youtube.videoUrl', proposal.youtube.videoUrl, filled);
    }
    setChecked(null);
    setAppliedProposal(proposal);
    setAppliedPending(pending);
  };
  // "Usar no construtor", clicked in the media studio: the asset arrives here
  // once, into the first variation that has no media yet.
  useEffect(() => {
    let picked: MediaBridgeResponse | null;
    try {
      const stored = sessionStorage.getItem(PICKED_MEDIA_KEY);
      if (!stored) return;
      sessionStorage.removeItem(PICKED_MEDIA_KEY);
      picked = JSON.parse(stored) as MediaBridgeResponse;
    } catch {
      return;
    }
    if (!picked || (!picked.creative && !picked.video)) return;
    const current = getValues('variations') ?? [];
    const free = current.findIndex((item) => !item?.creativeId && !item?.videoId);
    const index = free === -1 ? 0 : free;
    const filled = { shouldDirty: true, shouldValidate: false };
    if (picked.video) {
      setValue(`variations.${index}.creativeType`, 'video', filled);
      setValue(`variations.${index}.videoId`, picked.video.id, filled);
    } else if (picked.creative) {
      setValue(`variations.${index}.creativeType`, 'image', filled);
      setValue(`variations.${index}.creativeId`, picked.creative.id, filled);
    }
    setValue(`variations.${index}.mediaAssetId`, picked.mediaAssetId, filled);
    // Once, when the builder opens.
  }, []);

  // What is on screen, for the editing agent in the other studio to read. Words
  // and choices only: `shapeDraft` carries no file, no token, nothing personal.
  const draftJson = JSON.stringify(shapeDraft(values));
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        sessionStorage.setItem(BUILDER_DRAFT_KEY, draftJson);
      } catch {
        // Private mode or a full store: the agent simply has no draft to read.
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [draftJson]);

  /**
   * A saved draft is the whole form as it was validated, so it goes in whole:
   * the form is reset to it over the current defaults, and the boxes that keep
   * their own text (keywords, budget) are told too. Nothing is submitted.
   */
  const applyDraft = (draft: CampaignDraft) => {
    // Field by field, like a proposal: the form library re-writes its inputs
    // after a whole-form reset, which would undo the budget box's own text.
    const filled = { shouldDirty: true, shouldValidate: false };
    setAudienceLoaded(true);
    setUtmsFromProposal(true);
    setAppliedProposal(null);
    setValue('platform', draft.platform, filled);
    setValue('name', draft.name, filled);
    setValue('objective', draft.objective, filled);
    setValue('idealCustomerProfile', draft.idealCustomerProfile, filled);
    setValue('reach.states', draft.reach.states, filled);
    replaceCities(draft.reach.cities);
    setValue('reach.customLocations', draft.reach.customLocations, filled);
    setValue('destinationUrl', draft.destinationUrl, filled);
    setValue('leadCapture', draft.leadCapture ?? 'page', filled);
    if (draft.leadForm) setValue('leadForm', draft.leadForm, filled);
    for (const key of UTM_KEYS) setValue(`utms.${key}`, draft.utms[key], filled);
    setValue('dailyBudgetCents', draft.dailyBudgetCents, filled);
    setBudgetText(centsToBudgetText(draft.dailyBudgetCents));
    setValue('startDate', draft.startDate, filled);
    setValue('endDate', draft.endDate, filled);
    setValue('startPaused', true, filled);

    if (draft.platform === 'meta') {
      if (draft.formatKey) setValue('formatKey', draft.formatKey, filled);
      if (draft.ageMin !== undefined) setValue('ageMin', draft.ageMin, filled);
      if (draft.ageMax !== undefined) setValue('ageMax', draft.ageMax, filled);
      if (draft.placements) setValue('placements', draft.placements, filled);
      if (draft.identity) {
        setValue('identity.pageId', draft.identity.pageId, filled);
        setValue('identity.instagramActorId', draft.identity.instagramActorId, filled);
      }
      if (draft.variations.length > 0) variations.replace(draft.variations);
    }
    if (draft.youtube) {
      setValue('youtube.videoUrl', draft.youtube.videoUrl, filled);
      setValue('youtube.headline', draft.youtube.headline, filled);
    }
    const search = draft.search;
    if (search) {
      setValue('search.adGroupName', search.adGroupName ?? '', filled);
      setValue('search.locationMode', search.locationMode, filled);
      setValue('search.bidding', search.bidding, filled);
      setValue('search.maxCpcCents', search.maxCpcCents, filled);
      setMaxCpcText(centsToBudgetText(search.maxCpcCents));
      setValue('search.keywords', search.keywords, filled);
      setValue('search.negativeKeywords', search.negativeKeywords, filled);
      setKeywordsText(search.keywords.join('\n'));
      setNegativeKeywordsText(search.negativeKeywords.join('\n'));
      setValue('search.headlines', padTo(search.headlines, MAX_SEARCH_HEADLINES), filled);
      setValue('search.descriptions', padTo(search.descriptions, MAX_SEARCH_DESCRIPTIONS), filled);
    }
    setChecked(null);
    launch.reset();
  };

  // The bridge always points at this render's functions, and at nothing once
  // the builder leaves the screen.
  const bridge = {
    getDraft: () => shapeDraft(getValues()) as Record<string, unknown>,
    applyProposal,
    applyDraft,
  };
  useEffect(() => {
    if (!applyRef) return;
    applyRef.current = bridge;
    return () => {
      applyRef.current = null;
    };
  });
  const stillToDo = !appliedProposal
    ? null
    : appliedProposal.platform === 'meta'
      ? 'Falta escolher as imagens e a Página.'
      : appliedProposal.platform === 'youtube' && !appliedProposal.youtube?.videoUrl
        ? 'Falta o link do vídeo.'
        : null;
  // What Design needs to produce: the agent cannot choose media, so it says
  // what each piece should show.
  const appliedBriefs = !appliedProposal
    ? []
    : appliedProposal.platform === 'youtube' && appliedProposal.youtube
      ? [{ label: 'Vídeo', brief: appliedProposal.youtube.mediaBrief }]
      : appliedProposal.copy.map((copy, index) => ({
          label: `Criativo ${index + 1}`,
          brief: copy.mediaBrief,
        }));

  // UTMs follow the form until the operator edits one; an edited value is theirs.
  const { name, objective } = values;
  useEffect(() => {
    if (utmsFromProposal) return;
    const generated = buildUtms({ platform, objective, campaignName: name });
    for (const key of UTM_KEYS) {
      if (!dirtyFields.utms?.[key]) setValue(`utms.${key}`, generated[key]);
    }
  }, [platform, name, objective, dirtyFields.utms, setValue, utmsFromProposal]);

  const format = CREATIVE_FORMATS.meta.find((item) => item.key === values.formatKey);
  const formVariations = values.variations ?? [];
  // "Usar o mesmo texto em todos": the first creative's copy is written into
  // every other one, so the draft (and the approval) still lists each ad's text.
  const [sameCopy, setSameCopy] = useState(false);
  const firstCopy = formVariations[0];
  useEffect(() => {
    if (!sameCopy || !firstCopy) return;
    const options = { shouldDirty: true, shouldValidate: submitCount > 0 };
    for (let index = 1; index < variations.fields.length; index += 1) {
      setValue(`variations.${index}.headline`, firstCopy.headline ?? '', options);
      setValue(`variations.${index}.primaryText`, firstCopy.primaryText ?? '', options);
      setValue(`variations.${index}.callToAction`, firstCopy.callToAction ?? 'LEARN_MORE', options);
    }
  }, [
    sameCopy,
    firstCopy?.headline,
    firstCopy?.primaryText,
    firstCopy?.callToAction,
    variations.fields.length,
    setValue,
    submitCount,
  ]);
  const findingsByVariation = formVariations.map((variation) => [
    ...checkCopyCompliance(variation.headline ?? ''),
    ...checkCopyCompliance(variation.primaryText ?? ''),
    // A carousel's cards are copy too, and only count while it is a carousel.
    ...(variation.creativeType === 'carousel' ? (variation.cards ?? []) : []).flatMap((card) => [
      ...checkCopyCompliance(card.headline ?? ''),
      ...checkCopyCompliance(card.description ?? ''),
    ]),
  ]);
  const searchHeadlines = values.search?.headlines ?? [];
  const searchDescriptions = values.search?.descriptions ?? [];
  const youtubeFindings = checkCopyCompliance(values.youtube?.headline ?? '');
  const searchFindings = [...searchHeadlines, ...searchDescriptions].flatMap((text) =>
    checkCopyCompliance(text ?? ''),
  );
  // Only the copy that will be sent counts: the other platforms' boxes are not.
  const hasComplianceProblem =
    platform === 'youtube'
      ? youtubeFindings.length > 0
      : platform === 'google_search'
        ? searchFindings.length > 0
        : findingsByVariation.some((findings) => findings.length > 0);
  /** The schema's bounds answer in English; the operator gets them in Portuguese. */
  const ageError = (field: 'ageMin' | 'ageMax'): string | undefined => {
    if (!errors[field]) return undefined;
    const value = values[field];
    if (
      typeof value === 'number' &&
      (value < MIN_AGE || value > MAX_AGE || !Number.isInteger(value))
    ) {
      return `A idade vai de ${MIN_AGE} a ${MAX_AGE} anos.`;
    }
    return errors[field]?.message;
  };

  /** Array fields report either on the list or on one of its items. */
  const listError = (
    error:
      | { message?: string; root?: { message?: string } }
      | ({ message?: string } | undefined)[]
      | undefined,
  ): string | undefined => {
    if (!error) return undefined;
    if (Array.isArray(error)) return error.find((item) => item?.message)?.message;
    return error.message ?? error.root?.message;
  };

  return (
    <form
      className="builder"
      noValidate
      // Browsers restore typed values after a reload or a "back" without
      // telling the page, which would show filled boxes over an empty form
      // state — a budget on screen and no estimate. Off means: do not restore.
      autoComplete="off"
      onSubmit={(event) => {
        // Which button was pressed: checking never sends anything.
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const action = submitter instanceof HTMLButtonElement ? submitter.value : 'check';
        const launching = action === 'launch';
        setChecked(null);
        launch.reset();
        saveDraft.reset();
        void handleSubmit((values) => {
          const draft = values as CampaignDraft;
          const identity = draft.identity;
          // Only on request, and only when it is actually a different choice.
          if (
            keepIdentity &&
            identity &&
            (identity.pageId !== identityDefault?.pageId ||
              identity.instagramActorId !== (identityDefault?.instagramActorId ?? null))
          ) {
            saveIdentityDefault.mutate(identity);
          }
          if (launching && canRequest) launch.mutate(draft);
          else if (action === 'save' && canRequest) saveDraft.mutate({ draft });
          else setChecked(draft);
        })(event);
      }}
    >
      {canRequest && (savedDrafts.data?.drafts.length ?? 0) > 0 && (
        <section className="builder-applied" aria-label="Rascunhos salvos">
          <div className="builder-applied-head">
            <strong>Rascunhos salvos</strong>
          </div>
          <p className="field-hint">
            Carregar preenche o formulário com o rascunho, inteiro. Nada é enviado: a campanha só
            vira pedido em Lançar campanha.
          </p>
          {loadProblem && <Alert kind="error">{loadProblem}</Alert>}
          {loadedDraftName && <Alert kind="success">Rascunho “{loadedDraftName}” carregado.</Alert>}
          <ul className="builder-saved-drafts">
            {savedDrafts.data?.drafts.map((item) => (
              <li key={item.id}>
                <span>
                  <strong>{item.name}</strong>
                  <span className="cell-sub">
                    {' '}
                    {PAID_PLATFORMS.find((p) => p.key === item.platform)?.label ?? item.platform}
                    {item.createdByName ? ` · ${item.createdByName}` : ''} ·{' '}
                    {new Date(item.updatedAt).toLocaleString('pt-BR', {
                      timeZone: 'America/Sao_Paulo',
                    })}
                  </span>
                </span>
                <span className="builder-saved-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setLoadProblem(null);
                      setLoadedDraftName(null);
                      loadSavedDraft(item.id)
                        .then((loaded) => {
                          applyDraft(loaded.draft);
                          setLoadedDraftName(loaded.name);
                        })
                        .catch((error: unknown) =>
                          setLoadProblem(
                            error instanceof Error ? error.message : 'Não foi possível carregar.',
                          ),
                        );
                    }}
                  >
                    Carregar
                  </Button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => deleteSavedDraft.mutate(item.id)}
                  >
                    Excluir
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {appliedProposal && (
        <section className="builder-applied" aria-label="Proposta do agente aplicada">
          <div className="builder-applied-head">
            <strong>Proposta do agente aplicada</strong>
            <button type="button" className="link-button" onClick={() => setAppliedProposal(null)}>
              Dispensar
            </button>
          </div>
          <p className="field-hint">
            Confira cada escolha abaixo. Nada foi enviado: a campanha só vira pedido quando você
            clicar em Lançar campanha.
          </p>
          <dl className="builder-applied-list">
            {appliedProposal.explanations.map((item) => (
              <div key={item.field}>
                <dt>{AGENT_DRAFT_FIELD_LABEL[item.field]}</dt>
                <dd>{item.reason}</dd>
              </div>
            ))}
          </dl>
          {appliedBriefs.length > 0 && (
            <dl className="builder-applied-list">
              {appliedBriefs.map((item) => (
                <div key={item.label}>
                  <dt>Briefing para o Design — {item.label}</dt>
                  <dd>{item.brief}</dd>
                </div>
              ))}
            </dl>
          )}
          <details className="agent-details">
            <summary>Premissas</summary>
            <ul className="builder-applied-plain">
              {appliedProposal.assumptions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </details>
          {appliedProposal.budgetNote && (
            <p className="builder-applied-warning">{appliedProposal.budgetNote}</p>
          )}
          {stillToDo && <p className="builder-applied-todo">{stillToDo}</p>}
          {appliedPending.length > 0 && (
            <div>
              <span className="field-label">Pendente</span>
              <ul className="builder-applied-plain">
                {appliedPending.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      <BuilderSection
        step={stepOf('platform')}
        title="Plataforma"
        why={`Onde o anúncio aparece. O nome é como você vai achar esta campanha no ${google ? 'Google Ads' : 'Gerenciador de Anúncios'} e nos relatórios — capriche nele.`}
      >
        <div className="builder-options" role="radiogroup" aria-label="Plataforma">
          {PAID_PLATFORMS.map((platform) => {
            const enabled = isPlatformEnabled(platform.status);
            return (
              <label
                key={platform.key}
                className={`builder-option ${enabled ? '' : 'builder-option-disabled'}`}
              >
                <input
                  type="radio"
                  value={platform.key}
                  disabled={!enabled}
                  {...register('platform')}
                />
                <span>
                  {platform.label}
                  {!enabled && (
                    <small className="muted">
                      {' '}
                      — {platform.reason ?? PLATFORM_STATUS_LABEL[platform.status]}
                    </small>
                  )}
                </span>
              </label>
            );
          })}
        </div>
        {platform === 'youtube' && (
          <p className="field-hint">
            Criada como campanha Demand Gen restrita ao YouTube — a API do Google não cria campanhas
            do tipo Vídeo. O grupo de anúncios e o anúncio em vídeo entram na próxima etapa.
          </p>
        )}
        {platform === 'meta' && (
          <div className="builder-options" role="radiogroup" aria-label="O que montar">
            <label className="builder-option">
              <input type="radio" checked={target === 'new'} onChange={() => setTarget('new')} />
              <span>Campanha nova</span>
            </label>
            <label className="builder-option">
              <input
                type="radio"
                checked={target === 'existing'}
                onChange={() => setTarget('existing')}
              />
              <span>
                Adicionar criativos a uma campanha existente
                <small className="muted"> — cada um vira um anúncio no mesmo conjunto</small>
              </span>
            </label>
          </div>
        )}
        {addingToExisting ? (
          <Field label="Campanha">
            <Select
              value={targetCampaign}
              onChange={(event) => {
                setTargetCampaign(event.target.value);
                // The new ads start from what the campaign was created with:
                // its UTMs (so leads keep attributing to it), destination and page.
                const chosen = (existingCampaigns.data?.campaigns.campaigns ?? []).find(
                  (campaign) => campaign.externalId === event.target.value,
                );
                const defaults = chosen?.launchDefaults;
                if (!defaults) return;
                const options = { shouldDirty: true, shouldValidate: submitCount > 0 };
                // utm_campaign is the campaign's; source and medium stay the
                // builder's current standard (facebook / cpc), which is what the
                // live ads were corrected to on 28/09 — the draft may say paid_social.
                setValue('utms.utm_campaign', defaults.utms.utm_campaign, options);
                setValue('destinationUrl', defaults.destinationUrl, options);
                if (defaults.identity) {
                  setValue('identity.pageId', defaults.identity.pageId, options);
                  setValue(
                    'identity.instagramActorId',
                    defaults.identity.instagramActorId,
                    options,
                  );
                }
              }}
            >
              <option value="">Escolha a campanha</option>
              {(existingCampaigns.data?.campaigns.campaigns ?? [])
                .filter((campaign) => campaign.platform === 'meta')
                .map((campaign) => (
                  <option key={campaign.externalId} value={campaign.externalId}>
                    {campaign.name} ({campaign.status === 'ACTIVE' ? 'ativa' : 'pausada'})
                  </option>
                ))}
            </Select>
          </Field>
        ) : (
          <Field label="Nome da campanha" error={errors.name?.message}>
            <Input placeholder="Ex.: Expansão SP — outubro" {...register('name')} />
          </Field>
        )}
      </BuilderSection>

      <BuilderSection
        step={stepOf('objective')}
        title="Objetivo"
        why={
          google
            ? 'Define como o Google cobra e para quem mostra: dentro do seu público, ele procura quem tem mais chance de fazer exatamente isto.'
            : 'Define como a Meta cobra e para quem mostra: dentro do seu público, ela procura quem tem mais chance de fazer exatamente isto.'
        }
      >
        <div className="builder-options" role="radiogroup" aria-label="Objetivo">
          {CAMPAIGN_OBJECTIVES.map((key) => (
            <label key={key} className="builder-option">
              <input type="radio" value={key} {...register('objective')} />
              <span>
                {CAMPAIGN_OBJECTIVE_LABEL[key]}
                <small className="muted"> — {CAMPAIGN_OBJECTIVE_HINT[key]}</small>
              </span>
            </label>
          ))}
        </div>
      </BuilderSection>

      <BuilderSection
        step={stepOf('icp')}
        title="Perfil do cliente ideal"
        why={`É o retrato de quem você quer atrair. Guia a copy e o criativo agora e vira a segmentação quando o ${google ? 'grupo' : 'conjunto'} de anúncios for criado.`}
      >
        <Field
          label="Quem é o cliente ideal desta campanha"
          error={errors.idealCustomerProfile?.message}
          hint={`${(values.idealCustomerProfile ?? '').length}/${ICP_MAX} · começa do perfil salvo para a Wings; o que você mudar aqui vale para esta campanha.`}
        >
          <textarea
            className="control"
            rows={5}
            maxLength={ICP_MAX}
            placeholder="Ex.: empreendedor de 30 a 50 anos, com experiência em gestão, que busca um negócio com suporte…"
            {...register('idealCustomerProfile')}
          />
        </Field>
        {!google && (
          <>
            <div className="input-row">
              <Field label="Idade mínima" error={ageError('ageMin')}>
                <Input
                  type="number"
                  min={MIN_AGE}
                  max={MAX_AGE}
                  {...register('ageMin', { setValueAs: ageFromInput })}
                />
              </Field>
              <Field label="Idade máxima" error={ageError('ageMax')}>
                <Input
                  type="number"
                  min={MIN_AGE}
                  max={MAX_AGE}
                  {...register('ageMax', { setValueAs: ageFromInput })}
                />
              </Field>
            </div>
            <p className="field-hint">
              Faixa etária do conjunto de anúncios, de {MIN_AGE} a {MAX_AGE} anos ({MAX_AGE} quer
              dizer “{MAX_AGE} ou mais”).
            </p>
          </>
        )}
      </BuilderSection>

      <BuilderSection
        step={stepOf('reach')}
        title="Área de alcance"
        why="Onde o anúncio pode aparecer. Área grande demais espalha a verba; pequena demais encarece o lead."
      >
        <fieldset className="builder-states">
          <legend className="field-label">Estados inteiros</legend>
          {BRAZIL_STATES.map((state) => (
            <label key={state} className="builder-state">
              <input type="checkbox" value={state} {...register('reach.states')} />
              <span>{state}</span>
            </label>
          ))}
        </fieldset>

        <div>
          <span className="field-label">Cidades</span>
          {cities.fields.length === 0 && <p className="field-hint">Nenhuma cidade adicionada.</p>}
          <ul className="builder-cities">
            {cities.fields.map((city, index) => (
              <li key={city.id}>
                {values.reach.cities[index]?.name}/{values.reach.cities[index]?.state}
                <button
                  type="button"
                  className="link-button"
                  aria-label={`Remover ${values.reach.cities[index]?.name ?? 'cidade'}`}
                  onClick={() => cities.remove(index)}
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
          <div className="builder-city-add">
            <Input
              aria-label="Cidade"
              placeholder="Cidade"
              value={newCity.name}
              onChange={(event) => setNewCity({ ...newCity, name: event.target.value })}
            />
            <Select
              aria-label="UF da cidade"
              value={newCity.state}
              onChange={(event) =>
                setNewCity({ ...newCity, state: event.target.value as BrazilState | '' })
              }
            >
              <option value="">UF</option>
              {BRAZIL_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="ghost"
              disabled={newCity.name.trim().length < 2 || newCity.state === ''}
              onClick={() => {
                if (newCity.state === '') return;
                cities.append({ name: newCity.name.trim(), state: newCity.state });
                setNewCity({ name: '', state: '' });
              }}
            >
              Adicionar cidade
            </Button>
          </div>
        </div>
        {/* The same block on every platform; where no radius is taken, the map says so. */}
        <RadiusMap
          disabled={!acceptsRadius}
          value={values.reach.customLocations ?? []}
          onChange={(next) =>
            setValue('reach.customLocations', next, {
              shouldDirty: true,
              shouldValidate: submitCount > 0,
            })
          }
        />
        {(errors.reach?.message ?? errors.reach?.root?.message) && (
          <p className="field-error" role="alert">
            {errors.reach?.message ?? errors.reach?.root?.message}
          </p>
        )}

        <div className="builder-audience-save">
          <Button
            type="button"
            variant="ghost"
            disabled={!canRequest || saveAudience.isPending}
            onClick={() => {
              setAudienceProblem(null);
              const parsed = audienceProfileSchema.safeParse({
                idealCustomerProfile: values.idealCustomerProfile,
                reach: values.reach,
              });
              if (!parsed.success) {
                setAudienceProblem(parsed.error.issues[0]?.message ?? 'Dados inválidos');
                return;
              }
              saveAudience.mutate(parsed.data);
            }}
          >
            Salvar perfil e alcance como padrão da Wings
          </Button>
          <p className="field-hint">
            {savedAudience
              ? `Padrão atual salvo por ${savedAudience.updatedByName ?? '—'} em ${new Date(
                  savedAudience.updatedAt,
                ).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`
              : 'Ainda não há um padrão salvo para a Wings.'}{' '}
            As próximas campanhas começam dele.
          </p>
          {audienceProblem && <Alert kind="error">{audienceProblem}</Alert>}
          {saveAudience.isError && <Alert kind="error">{saveAudience.error.message}</Alert>}
          {saveAudience.isSuccess && <Alert kind="success">Padrão da Wings atualizado.</Alert>}
        </div>
      </BuilderSection>

      {!google && (
        <>
          <BuilderSection
            step={stepOf('placements')}
            title="Posicionamentos"
            why="Em que telas o anúncio aparece. No automático a Meta distribui a verba onde o resultado sai mais barato; no manual você restringe — e costuma pagar mais por isso."
          >
            <div className="builder-options" role="radiogroup" aria-label="Posicionamentos">
              <label className="builder-option">
                <input type="radio" value="automatic" {...register('placements.mode')} />
                <span>
                  Automático (Advantage+)
                  <small className="muted"> — a Meta escolhe onde exibir</small>
                </span>
              </label>
              <label className="builder-option">
                <input type="radio" value="manual" {...register('placements.mode')} />
                <span>Manual</span>
              </label>
            </div>
            {values.placements?.mode === 'manual' && (
              <p className="builder-placement-presets">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    const options = { shouldDirty: true, shouldValidate: submitCount > 0 };
                    setValue('placements.facebook', [], options);
                    setValue('placements.threads', [], options);
                    setValue('placements.instagram', ['feed', 'stories', 'reels'], options);
                  }}
                >
                  Só Instagram (Feed, Stories e Reels)
                </button>
              </p>
            )}
            {values.placements?.mode === 'manual' && (
              <div className="builder-placements">
                {PLACEMENT_PUBLISHERS.map((publisher) => (
                  <fieldset key={publisher} className="builder-placement-group">
                    <legend className="field-label">{PLACEMENT_PUBLISHER_LABEL[publisher]}</legend>
                    {PLACEMENT_PUBLISHER_POSITIONS[publisher].map((position) => (
                      <label key={position} className="builder-state">
                        <input
                          type="checkbox"
                          value={position}
                          aria-label={`${PLACEMENT_PUBLISHER_LABEL[publisher]} ${PLACEMENT_POSITION_LABEL[position]}`}
                          {...register(`placements.${publisher}`)}
                        />
                        <span>{PLACEMENT_POSITION_LABEL[position]}</span>
                      </label>
                    ))}
                  </fieldset>
                ))}
              </div>
            )}
            {(errors.placements?.facebook?.message ??
              errors.placements?.threads?.message ??
              errors.placements?.mode?.message) && (
              <p className="field-error" role="alert">
                {errors.placements?.facebook?.message ??
                  errors.placements?.threads?.message ??
                  errors.placements?.mode?.message}
              </p>
            )}
            {vertical && (
              <div className="alert alert-warning" role="status">
                Stories e Reels são verticais (9:16). Criativos em outro formato serão cortados pela
                Meta.
              </div>
            )}
          </BuilderSection>

          <BuilderSection
            step={stepOf('identity')}
            title="Página e Instagram"
            why="É em nome de quem o anúncio aparece: a Página do Facebook e a conta do Instagram que assinam a publicação. A lista vem da própria Meta — só aparece o que o sistema pode usar."
          >
            {identities.isLoading && <p className="muted">Lendo as páginas na Meta…</p>}
            {metaNotConfigured && (
              <Alert kind="error">
                A Meta não está configurada neste ambiente — não é possível escolher a página.
              </Alert>
            )}
            {identities.isError && !metaNotConfigured && (
              <Alert kind="error">
                {identities.error.message}{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => void identities.refetch()}
                >
                  Tentar de novo
                </button>
              </Alert>
            )}
            {identities.data && pages.length === 0 && (
              <Alert kind="error">
                O usuário do sistema não tem acesso a nenhuma Página do Facebook.
              </Alert>
            )}
            {pages.length > 0 && (
              <>
                <div className="input-row">
                  <Field label="Página do Facebook" error={errors.identity?.pageId?.message}>
                    {/* Controlled: the Instagram options depend on the page, and an
                        uncontrolled select cannot take a value whose option is not
                        on screen yet. */}
                    <Select
                      value={values.identity?.pageId ?? ''}
                      onChange={(event) => {
                        setValue('identity.pageId', event.target.value, identityOptions);
                        // Another page, another set of Instagram accounts.
                        setValue('identity.instagramActorId', null, identityOptions);
                      }}
                    >
                      <option value="">Selecione…</option>
                      {pages.map((page) => (
                        <option key={page.id} value={page.id}>
                          {page.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label="Conta do Instagram"
                    error={errors.identity?.instagramActorId?.message}
                  >
                    <Select
                      value={values.identity?.instagramActorId ?? ''}
                      onChange={(event) =>
                        setValue(
                          'identity.instagramActorId',
                          event.target.value || null,
                          identityOptions,
                        )
                      }
                    >
                      <option value="">Sem conta do Instagram</option>
                      {(chosenPage?.instagramAccounts ?? []).map((account) => (
                        <option key={account.id} value={account.id}>
                          @{account.username}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={keepIdentity}
                    onChange={(event) => setKeepIdentity(event.target.checked)}
                  />
                  <span>
                    Guardar como padrão da Wings
                    <small className="muted">
                      {' '}
                      — as próximas campanhas já começam com esta página e esta conta.
                    </small>
                  </span>
                </label>
                {saveIdentityDefault.isError && (
                  <Alert kind="error">{saveIdentityDefault.error.message}</Alert>
                )}
                {saveIdentityDefault.isSuccess && (
                  <Alert kind="success">Página e Instagram guardados como padrão da Wings.</Alert>
                )}
              </>
            )}
          </BuilderSection>

          <BuilderSection
            step={stepOf('creative')}
            title="Criativo"
            why="A imagem é o que faz a pessoa parar de rolar o feed. Cada criativo vira um anúncio, para a Meta descobrir qual segura mais gente."
          >
            <p className="field-hint">
              Até {MAX_VARIATIONS} criativos, cada um do seu tipo: imagem, vídeo ou carrossel. Cada
              um vira um anúncio, e o lead diz de qual veio pelo utm_content, que a Meta preenche
              com o id do anúncio. Fica guardado no Wings System — só vai para a Meta quando um
              pedido aprovado for executado.
            </p>
            {variations.fields.length > 1 && (
              <label className="builder-state builder-same-copy">
                <input
                  type="checkbox"
                  checked={sameCopy}
                  onChange={(event) => setSameCopy(event.target.checked)}
                />
                <span>Usar o mesmo texto, título e botão em todos</span>
              </label>
            )}
            {variations.fields.map((field, index) => (
              <CreativeCard
                key={field.id}
                index={index}
                count={variations.fields.length}
                variation={formVariations[index]}
                control={control}
                register={register}
                setValue={setValue}
                errors={errors}
                format={format}
                vertical={vertical}
                revalidate={submitCount > 0}
                canPickMedia={canPickMedia}
                sameCopy={sameCopy}
                findings={findingsByVariation[index] ?? []}
                onRemove={() => variations.remove(index)}
              />
            ))}
            {variations.fields.length < MAX_VARIATIONS && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  variations.append({
                    creativeType: 'image',
                    creativeId: '',
                    cards: [],
                    headline: '',
                    primaryText: '',
                    callToAction: 'LEARN_MORE',
                  })
                }
              >
                + Adicionar criativo
              </Button>
            )}
            {errors.variations?.root?.message && (
              <p className="field-error" role="alert">
                {errors.variations.root.message}
              </p>
            )}
          </BuilderSection>

          <BuilderSection
            step={stepOf('format')}
            title="Formato e dimensão"
            why="Cada posicionamento tem um corte. Imagem fora da proporção é cortada pela Meta — e pode perder o rosto ou o texto."
          >
            <Field
              label="Formato"
              error={errors.formatKey?.message}
              hint={
                format
                  ? `${format.width} × ${format.height} px (${format.ratio}) · ${format.placement}`
                  : undefined
              }
            >
              <Select {...register('formatKey')}>
                {CREATIVE_FORMATS.meta.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label} — {item.ratio}
                  </option>
                ))}
              </Select>
            </Field>
          </BuilderSection>

          <BuilderSection
            step={stepOf('destination')}
            title="Destino"
            why="Para onde o botão leva. É nesta página que o lead vira lead: se ela não abre ou não tem formulário, o anúncio só gasta."
          >
            <Field
              label="Página de destino"
              error={errors.destinationUrl?.message}
              hint="Os UTMs são aplicados a este endereço."
            >
              <Input
                type="url"
                placeholder="https://wingscompany.com.br/contato/"
                {...register('destinationUrl')}
              />
            </Field>
          </BuilderSection>
        </>
      )}

      {platform === 'youtube' && (
        <BuilderSection
          step={stepOf('video')}
          title="Vídeo"
          why="O vídeo é o anúncio: os primeiros segundos decidem se a pessoa pula. Ele precisa estar publicado no YouTube — o link é o que o Google usa para achá-lo."
        >
          <Field
            label="Link do vídeo no YouTube"
            error={errors.youtube?.videoUrl?.message}
            hint="Ex.: https://www.youtube.com/watch?v=… ou https://youtu.be/…"
          >
            <Input
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              {...register('youtube.videoUrl')}
            />
          </Field>
          <Field
            label="Título"
            error={errors.youtube?.headline?.message}
            hint={`${(values.youtube?.headline ?? '').length}/${HEADLINE_MAX}`}
          >
            <Input maxLength={HEADLINE_MAX} {...register('youtube.headline')} />
          </Field>
          <Field
            label="Página de destino"
            error={errors.destinationUrl?.message}
            hint="Para onde o anúncio leva. Os UTMs são aplicados a este endereço."
          >
            <Input
              type="url"
              placeholder="https://wingscompany.com.br/contato/"
              {...register('destinationUrl')}
            />
          </Field>
          <ComplianceWarning findings={youtubeFindings} />
        </BuilderSection>
      )}

      {platform === 'google_search' && (
        <>
          <BuilderSection
            step={stepOf('keywords')}
            title="Palavras-chave"
            why="É o que a pessoa digita no Google para o anúncio aparecer. Poucas e específicas trazem quem já procura franquia; genéricas demais gastam a verba com curiosos."
          >
            <Field
              label="Nome do grupo de anúncios"
              error={errors.search?.adGroupName?.message}
              hint="Um grupo por campanha nesta versão. Em branco, usa o nome da campanha."
            >
              <Input
                maxLength={120}
                placeholder={values.name || 'Grupo 1'}
                {...register('search.adGroupName')}
              />
            </Field>
            <div className="field">
              <span className="field-label" id="builder-default-match">
                Correspondência para linhas sem marcação
              </span>
              <div
                className="builder-match"
                role="radiogroup"
                aria-labelledby="builder-default-match"
              >
                {(['exact', 'phrase'] as const).map((match) => (
                  <label key={match} className="check">
                    <input
                      type="radio"
                      name="defaultMatch"
                      value={match}
                      checked={defaultMatch === match}
                      onChange={() => {
                        setDefaultMatch(match);
                        setValue('search.keywords', markKeywords(linesOf(keywordsText), match), {
                          shouldDirty: true,
                          shouldValidate: submitCount > 0,
                        });
                      }}
                    />{' '}
                    {match === 'exact' ? 'Exata [termo]' : 'Frase “termo”'}
                  </label>
                ))}
              </div>
              <span className="field-hint">
                Exata = só essa busca ([termo]). Frase = buscas que contêm o termo nessa ordem
                (“termo”). Ampla não é aceita nesta fase.
              </span>
            </div>
            <Field
              label="Palavras-chave"
              error={listError(errors.search?.keywords)}
              hint={`${linesOf(keywordsText).length}/${MAX_KEYWORDS} · uma por linha · marque [exata] ou "frase"; sem marca, vale a correspondência acima`}
            >
              <textarea
                className="control builder-keywords"
                rows={6}
                placeholder={'[franquear minha empresa]\n"como franquear meu negócio"'}
                value={keywordsText}
                onChange={(event) => {
                  setKeywordsText(event.target.value);
                  setValue(
                    'search.keywords',
                    markKeywords(linesOf(event.target.value), defaultMatch),
                    {
                      shouldDirty: true,
                      shouldValidate: submitCount > 0,
                    },
                  );
                }}
              />
            </Field>
            <Field
              label="Palavras-chave negativas"
              error={listError(errors.search?.negativeKeywords)}
              hint={`${linesOf(negativeKeywordsText).length}/${MAX_NEGATIVE_KEYWORDS} · uma por linha · buscas em que o anúncio NÃO deve aparecer`}
            >
              <textarea
                className="control builder-keywords"
                rows={4}
                placeholder={'grátis\nemprego'}
                value={negativeKeywordsText}
                onChange={(event) => {
                  setNegativeKeywordsText(event.target.value);
                  setValue('search.negativeKeywords', linesOf(event.target.value), {
                    shouldDirty: true,
                    shouldValidate: submitCount > 0,
                  });
                }}
              />
            </Field>
            <p className="field-hint">
              Vão para o Google junto com a campanha: as negativas na campanha (correspondência de
              frase), as palavras-chave no grupo de anúncios. Tudo nasce pausado.
            </p>
          </BuilderSection>

          <BuilderSection
            step={stepOf('searchSettings')}
            title="Rede, local e lance"
            why="Onde o anúncio aparece, quem conta como “no local” e quanto cada clique pode custar. Os três vão no pedido aprovado e são validados no Google antes de escrever."
          >
            <div className="field">
              <span className="field-label">Rede</span>
              <p>Só a Pesquisa do Google. Parceiros de pesquisa e Display desligados.</p>
            </div>
            <div className="field">
              <span className="field-label" id="builder-location-mode">
                Local
              </span>
              <div
                className="builder-match"
                role="radiogroup"
                aria-labelledby="builder-location-mode"
              >
                {SEARCH_LOCATION_MODES.map((mode) => (
                  <label key={mode} className="check">
                    <input type="radio" value={mode} {...register('search.locationMode')} />{' '}
                    {SEARCH_LOCATION_MODE_LABEL[mode]}
                  </label>
                ))}
              </div>
              <span className="field-hint">
                Presença é o padrão: só quem está nos estados, cidades ou raios escolhidos.
              </span>
            </div>
            <div className="field">
              <span className="field-label" id="builder-bidding">
                Lance
              </span>
              <div className="builder-match" role="radiogroup" aria-labelledby="builder-bidding">
                {SEARCH_BIDDING_STRATEGIES.map((strategy) => (
                  <label key={strategy} className="check">
                    <input type="radio" value={strategy} {...register('search.bidding')} />{' '}
                    {SEARCH_BIDDING_LABEL[strategy]}
                  </label>
                ))}
              </div>
              <span className="field-hint">
                Maximizar cliques é o padrão enquanto a conversão da conta não for confiável: o
                Google só compra cliques até o CPC máximo.
              </span>
            </div>
            {values.search?.bidding !== 'maximize_conversions' && (
              <Field
                label="CPC máximo (R$)"
                error={errors.search?.maxCpcCents?.message}
                hint="O máximo por clique. Padrão R$ 6,00."
              >
                <Input
                  inputMode="decimal"
                  placeholder="6,00"
                  {...maxCpcField}
                  value={maxCpcText}
                  onChange={(event) => {
                    setMaxCpcText(event.target.value);
                    maxCpcField.onChange(event);
                  }}
                />
              </Field>
            )}
          </BuilderSection>

          <BuilderSection
            step={stepOf('searchAd')}
            title="Texto do anúncio"
            why="Na Pesquisa não há imagem: o título é o que faz a pessoa clicar. Promessa de ganho reprova o anúncio e pode restringir a conta — por isso o bloqueio."
          >
            <Field
              label="Página de destino"
              error={errors.destinationUrl?.message}
              hint="Para onde o anúncio leva. Os UTMs são aplicados a este endereço."
            >
              <Input
                type="url"
                placeholder="https://wingscompany.com.br/contato/"
                {...register('destinationUrl')}
              />
            </Field>
            <p className="field-hint">
              Anúncio responsivo de pesquisa: o Google combina os títulos e descrições. Mínimo de{' '}
              {MIN_SEARCH_HEADLINES} títulos e {MIN_SEARCH_DESCRIPTIONS} descrições; quanto mais
              variações, melhor ele aprende.
            </p>
            {searchHeadlines.map((_, index) => (
              <Field
                key={`headline-${index}`}
                label={`Título ${index + 1}${index < MIN_SEARCH_HEADLINES ? '' : ' (opcional)'}`}
                error={index === 0 ? listError(errors.search?.headlines) : undefined}
                hint={`${(searchHeadlines[index] ?? '').length}/${SEARCH_HEADLINE_MAX}`}
              >
                <Input maxLength={SEARCH_HEADLINE_MAX} {...register(`search.headlines.${index}`)} />
              </Field>
            ))}
            {searchDescriptions.map((_, index) => (
              <Field
                key={`description-${index}`}
                label={`Descrição ${index + 1}${index < MIN_SEARCH_DESCRIPTIONS ? '' : ' (opcional)'}`}
                error={index === 0 ? listError(errors.search?.descriptions) : undefined}
                hint={`${(searchDescriptions[index] ?? '').length}/${SEARCH_DESCRIPTION_MAX}`}
              >
                <textarea
                  className="control"
                  rows={2}
                  maxLength={SEARCH_DESCRIPTION_MAX}
                  {...register(`search.descriptions.${index}`)}
                />
              </Field>
            ))}
            <ComplianceWarning findings={searchFindings} />
          </BuilderSection>
        </>
      )}

      <BuilderSection
        step={stepOf('leadForm')}
        title="Formulário"
        why="Onde o lead responde e o que ele responde. As cinco perguntas caem direto na ficha; a regra de funil nasce junto, para ninguém cair em Formatação por engano."
      >
        {values.objective === 'lead' ? (
          <LeadFormSection
            platform={
              platform === 'google_search'
                ? 'google_search'
                : platform === 'youtube'
                  ? 'youtube'
                  : 'meta'
            }
            leadCapture={values.leadCapture}
            leadForm={values.leadForm}
            pageId={values.identity?.pageId}
            destinationUrl={values.destinationUrl ?? ''}
            register={register}
            setValue={setValue}
            errors={errors}
            canApprove={canApprove}
          />
        ) : (
          <p className="field-hint">Só para campanhas de geração de leads.</p>
        )}
      </BuilderSection>

      <BuilderSection
        step={stepOf('duration')}
        title="Duração"
        why={`Por quanto tempo o anúncio roda. Nos primeiros dias ${google ? 'o Google' : 'a Meta'} ainda está aprendendo quem responde; campanha muito curta termina antes disso.`}
      >
        <div className="input-row">
          <Field label="Início" error={errors.startDate?.message}>
            <Input type="date" min={today} {...register('startDate')} />
          </Field>
          <Field label="Fim" error={errors.endDate?.message}>
            <Input type="date" min={values.startDate || today} {...register('endDate')} />
          </Field>
        </div>
        <p className="field-hint">
          {days ? `${days} dia${days === 1 ? '' : 's'} de campanha` : 'Escolha início e fim'}
        </p>
      </BuilderSection>

      <BuilderSection
        step={stepOf('budget')}
        title="Verba diária"
        why={
          google
            ? 'É quanto você autoriza por dia. O Google pode gastar até o dobro da verba diária num dia, mas compensa nos outros: no período ele não cobra além da verba. O custo estimado abaixo precisa caber no teto da conta.'
            : 'É quanto você autoriza por dia. A Meta pode gastar até 25% a mais num dia, então o custo real é o estimado abaixo — e ele precisa caber no teto da conta.'
        }
      >
        <div className="builder-budget">
          <div>
            <Field
              label="Verba por dia (R$)"
              error={errors.dailyBudgetCents?.message}
              hint={
                google
                  ? 'O Google pode gastar até o dobro da verba diária num dia, mas no período não cobra além da verba.'
                  : 'A Meta pode gastar até 25% acima disto num dia.'
              }
            >
              <Input
                inputMode="decimal"
                placeholder="20,00"
                {...budgetField}
                // Controlled by the text, so a budget applied from a proposal
                // shows as "20,00" and not as the cents the form holds.
                value={budgetText}
                onChange={(event) => {
                  setBudgetText(event.target.value);
                  budgetField.onChange(event);
                }}
              />
            </Field>
            <div className="builder-cost">
              <span className="field-label">Custo total estimado</span>
              {costMissing === null && totalCostCents !== null ? (
                <p className="mono builder-ceiling-figure">{formatBrl(totalCostCents)}</p>
              ) : (
                <p className="builder-cost-missing" role="status">
                  {costMissing}
                </p>
              )}
              {costMissing === null && days !== null && (
                <p className="field-hint">
                  {costIsOneWorstDay
                    ? `${formatBrl(dailyBudgetCents)} × ${dailyOverdeliveryFactor(platform).toLocaleString('pt-BR')}: o pior caso de um único dia`
                    : `${formatBrl(dailyBudgetCents)} × ${days} dias × ${periodOverdeliveryFactor(platform).toLocaleString('pt-BR')} de margem da plataforma no período`}
                  {daysThisMonth !== days &&
                    ` · ${formatBrl(costThisMonthCents)} caem neste mês (${daysThisMonth} dias)`}
                </p>
              )}
            </div>
          </div>
          <AccountCeiling
            accountId={cockpit.data?.cockpit.account.id}
            pacing={pacing}
            wingsTotal={wingsTotal}
            platform={platform}
            pause={spendCapPause}
            pauseIncludesThis={pauseIncludesThis}
          />
        </div>
        {overCeiling && pacing && (
          <div className="alert alert-warning" role="alert">
            O custo neste mês ({formatBrl(costThisMonthCents)}) passa do que a conta ainda permite
            planejar ({formatBrl(pacing.availableCents)}). Ativa, esta campanha seria recusada pelo
            guardião de orçamento.
          </div>
        )}
        <label className="checkbox-field">
          {/* Locked on: everything this system creates is born paused. */}
          <input type="checkbox" checked readOnly disabled />
          <span>
            Criar a campanha <strong>pausada</strong>
            <small className="muted"> — nasce sem entregar e sem reservar verba.</small>
            <small className="field-hint">
              {google
                ? 'Campanhas do Google nascem sempre pausadas.'
                : 'Tudo nasce pausado: campanha, conjunto e anúncios. Ligar é um ato seu, no Gerenciador de Anúncios.'}
            </small>
          </span>
        </label>
      </BuilderSection>

      <BuilderSection
        step={stepOf('utms')}
        title="UTMs"
        why="É assim que o lead chega no CRM com a origem certa. Sem UTM ele aparece como “direto” e ninguém sabe qual campanha pagou por ele."
      >
        {utmsFromPlatform(values.platform ?? '') ? (
          <>
            <p className="field-hint">
              {google
                ? 'No Google, as UTMs vêm do Sufixo do URL final da conta, que toda campanha herda. A campanha não grava sufixo próprio, e o endereço vai sem UTM.'
                : 'Na Meta, todo anúncio novo leva os Parâmetros de URL padrão, e a Meta preenche a origem e os ids da campanha, do anúncio e do conjunto a cada clique. O endereço vai sem UTM.'}
            </p>
            <p className="field-hint builder-url mono">
              {google ? GOOGLE_ACCOUNT_URL_SUFFIX : META_URL_TAGS}
            </p>
          </>
        ) : (
          <>
            <p className="field-hint">Gerados a partir do nome e do objetivo. Edite se precisar.</p>
            <div className="builder-utms">
              {UTM_KEYS.map((key) => (
                <Field key={key} label={key} error={errors.utms?.[key]?.message}>
                  <Input className="mono" {...register(`utms.${key}`)} />
                </Field>
              ))}
            </div>
          </>
        )}
        <p className="field-hint builder-url mono">
          {adDestination(values.platform ?? '', values.destinationUrl ?? '', values.utms, {
            creativeType: values.variations?.[0]?.creativeType ?? 'image',
            position: 1,
          }) ?? 'Informe a página de destino para ver o endereço final.'}
        </p>
      </BuilderSection>

      <BuilderSection
        step={stepOf('preview')}
        title="Pré-visualização"
        why={
          google
            ? 'O anúncio como a pessoa vai ver. É a última chance de pegar um título cortado, um link errado ou um texto que não convence.'
            : 'O anúncio como a pessoa vai ver, com o corte do formato. É a última chance de pegar texto cortado ou imagem mal enquadrada.'
        }
      >
        {platform === 'youtube' && (
          <YoutubePreview
            videoUrl={values.youtube?.videoUrl ?? ''}
            headline={values.youtube?.headline ?? ''}
            destinationUrl={values.destinationUrl ?? ''}
          />
        )}
        {platform === 'google_search' && (
          <SearchAdPreview
            headlines={searchHeadlines.map((item) => item ?? '')}
            descriptions={searchDescriptions.map((item) => item ?? '')}
            destinationUrl={values.destinationUrl ?? ''}
          />
        )}
        {!google && values.objective === 'lead' && values.leadCapture === 'instant_form' && (
          <LeadFormPreviewGallery
            media={{
              mediaType: formVariations[0]?.creativeType === 'video' ? 'video' : 'image',
              creativeId: formVariations[0]?.creativeId,
              videoId: formVariations[0]?.videoId,
              headline: formVariations[0]?.headline ?? '',
              primaryText: formVariations[0]?.primaryText ?? '',
              callToAction: formVariations[0]?.callToAction ?? 'SIGN_UP',
            }}
            form={
              siteFormOf(values.leadForm, values.destinationUrl || undefined) ?? {
                qualifier: null,
                privacyPolicyUrl: 'https://wingscompany.com.br/',
                thankYou: {
                  ...LEAD_FORM_THANK_YOU_DEFAULT,
                  buttonUrl: 'https://wingscompany.com.br/',
                },
              }
            }
            brand={pages.find((page) => page.id === values.identity?.pageId)?.name ?? 'Wings'}
          />
        )}
        {!google && (
          <AdPreviewGallery
            variations={formVariations.map((variation) => ({
              creativeType: variation.creativeType ?? 'image',
              creativeId: variation.creativeId,
              videoId: variation.videoId,
              cards: (variation.cards ?? []).map((card) => ({
                mediaType: card.mediaType ?? 'image',
                creativeId: card.creativeId,
                videoId: card.videoId,
                headline: card.headline ?? '',
                description: card.description ?? '',
              })),
              headline: variation.headline ?? '',
              primaryText: variation.primaryText ?? '',
              callToAction: variation.callToAction,
            }))}
            destinationUrl={values.destinationUrl ?? ''}
            format={format}
          />
        )}
      </BuilderSection>

      <BuilderSection
        step={stepOf('summary')}
        title="Resumo — confira tudo"
        why="É exatamente o que o aprovador vai ler. Depois de lançado o pedido não pode ser editado — para mudar, faz-se outro."
      >
        <dl className="builder-summary">
          <dt>Plataforma</dt>
          <dd>{platformLabel}</dd>
          <dt>Campanha</dt>
          <dd>{values.name || '—'}</dd>
          <dt>Objetivo</dt>
          <dd>{CAMPAIGN_OBJECTIVE_LABEL[values.objective]}</dd>
          {values.objective === 'lead' && (
            <>
              <dt>Formulário</dt>
              <dd>{describeLeadCapture(shapeDraft(values) as CampaignDraft)}</dd>
            </>
          )}
          <dt>Cliente ideal</dt>
          <dd className="builder-summary-clamp">{values.idealCustomerProfile || '—'}</dd>
          <dt>Alcance</dt>
          <dd>{describeReach(values.reach)}</dd>
          {!google && (
            <>
              <dt>Faixa etária</dt>
              <dd>
                {values.ageMin ?? '—'} a {values.ageMax ?? '—'} anos
              </dd>
              <dt>Posicionamentos</dt>
              <dd>{describePlacements(values.placements)}</dd>
              <dt>Página e Instagram</dt>
              <dd>
                {chosenPage?.name ?? '—'} ·{' '}
                {chosenInstagram ? `@${chosenInstagram.username}` : 'sem conta do Instagram'}
              </dd>
              <dt>Formato</dt>
              <dd>{format ? `${format.label} (${format.ratio})` : '—'}</dd>
              <dt>Criativos</dt>
              <dd>
                {formVariations.map((variation, index) => {
                  const type = variation.creativeType ?? 'image';
                  return (
                    <span key={index} className="builder-summary-line">
                      {index + 1}. {variation.headline || '(sem título)'} ·{' '}
                      {CREATIVE_TYPE_LABEL[type]}
                      {type === 'carousel' && ` (${(variation.cards ?? []).length} cartões)`} ·{' '}
                      {CALL_TO_ACTION_LABEL[variation.callToAction]}
                    </span>
                  );
                })}
              </dd>
            </>
          )}
          {platform === 'youtube' && (
            <>
              <dt>Tipo no Google</dt>
              <dd>Demand Gen, restrita ao YouTube</dd>
              <dt>Vídeo</dt>
              <dd className="mono builder-url">{values.youtube?.videoUrl || '—'}</dd>
              <dt>Título</dt>
              <dd>{values.youtube?.headline || '—'}</dd>
            </>
          )}
          {platform === 'google_search' && (
            <>
              <dt>Palavras-chave</dt>
              <dd>{(values.search?.keywords ?? []).join(' · ') || '—'}</dd>
              <dt>Negativas</dt>
              <dd>{(values.search?.negativeKeywords ?? []).join(' · ') || '—'}</dd>
              <dt>Rede</dt>
              <dd>Só Pesquisa do Google (sem parceiros, sem Display)</dd>
              <dt>Local</dt>
              <dd>{SEARCH_LOCATION_MODE_LABEL[values.search?.locationMode ?? 'presence']}</dd>
              <dt>Lance</dt>
              <dd>
                {SEARCH_BIDDING_LABEL[values.search?.bidding ?? 'maximize_clicks']}
                {values.search?.bidding !== 'maximize_conversions' &&
                  ` · CPC máximo R$ ${maxCpcText || '—'}`}
              </dd>
              <dt>Títulos</dt>
              <dd>{searchHeadlines.filter(Boolean).join(' | ') || '—'}</dd>
              <dt>Descrições</dt>
              <dd>{searchDescriptions.filter(Boolean).join(' ') || '—'}</dd>
            </>
          )}
          <dt>Duração</dt>
          <dd>
            {formatDate(values.startDate)} a {formatDate(values.endDate)}
            {days ? ` · ${days} dias` : ''}
          </dd>
          <dt>Verba diária</dt>
          <dd className="mono">{dailyBudgetCents > 0 ? formatBrl(dailyBudgetCents) : '—'}</dd>
          <dt>Custo total estimado</dt>
          <dd className={costMissing === null ? 'mono' : 'muted'}>
            {costMissing === null && totalCostCents !== null
              ? formatBrl(totalCostCents)
              : costMissing}
          </dd>
          <dt>Nasce</dt>
          <dd>Pausada</dd>
          <dt>{utmsFromPlatform(values.platform ?? '') ? 'Destino' : 'Destino com UTMs'}</dt>
          <dd className="mono builder-url">
            {adDestination(values.platform ?? '', values.destinationUrl ?? '', values.utms, {
              creativeType: values.variations?.[0]?.creativeType ?? 'image',
              position: 1,
            }) ?? '—'}
          </dd>
        </dl>

        {hasComplianceProblem && (
          <Alert kind="error">
            Há texto bloqueado pelo compliance. Corrija {google ? 'os textos' : 'as variações'}{' '}
            acima.
          </Alert>
        )}
        {submitCount > 0 && !isSubmitSuccessful && !hasComplianceProblem && (
          <Alert kind="error">Há campos para corrigir acima.</Alert>
        )}
        {checked && (
          <Alert kind="success">
            Tudo conferido: a campanha “{checked.name}” está pronta para virar um pedido.
          </Alert>
        )}
        {launch.isError && <Alert kind="error">{launch.error.message}</Alert>}
        {launch.isSuccess && (
          <Alert kind="success">
            Pedido criado. Nada foi publicado: a campanha só existe{' '}
            {google ? 'no Google' : 'na Meta'} depois que alguém aprovar e executar.{' '}
            {launch.data.approvalId && (
              <Link to={`/marketing/trafego-pago-wings/aprovacoes/${launch.data.approvalId}`}>
                Abrir o pedido nas Aprovações
              </Link>
            )}
          </Alert>
        )}

        {saveDraft.isSuccess && <Alert kind="success">Rascunho salvo. Nada foi enviado.</Alert>}
        {saveDraft.isError && (
          <Alert kind="error">
            {saveDraft.error instanceof ApiError
              ? saveDraft.error.message
              : 'Não foi possível salvar o rascunho.'}
          </Alert>
        )}
        <div className="form-actions">
          <Button type="submit" variant="ghost" value="check">
            Conferir campanha
          </Button>
          {canRequest && (
            <Button type="submit" variant="ghost" value="save" disabled={saveDraft.isPending}>
              {saveDraft.isPending ? 'Salvando…' : 'Salvar rascunho'}
            </Button>
          )}
          <Button
            type="submit"
            value="launch"
            disabled={
              !canRequest || launch.isPending || launch.isSuccess || (!google && metaNotConfigured)
            }
            title={canRequest ? undefined : 'Seu perfil não pode pedir campanhas'}
          >
            {launch.isPending ? 'Enviando…' : 'Lançar campanha'}
          </Button>
        </div>
        <p className="field-hint">
          “Lançar campanha” não publica nada: cria um pedido que cai nas Aprovações, e só Admin
          Master ou Diretoria decidem.
          {!canRequest && ' Seu perfil pode montar a campanha, mas não enviar o pedido.'}
        </p>
      </BuilderSection>

      {addingToExisting && (
        <section className="builder-section" aria-label="Pedir aprovação dos anúncios">
          <Alert kind="info">
            Os anúncios entram no conjunto que a campanha já tem, <strong>pausados</strong>, depois
            que a Thais ou o Umberto aprovarem e alguém executar. A verba e o público da campanha
            não mudam. Para ligá-los, peça “Retomar campanha” ou ligue-os na Meta.
          </Alert>
          {hasComplianceProblem && (
            <Alert kind="error">
              Há texto bloqueado pelo compliance. Corrija os criativos acima.
            </Alert>
          )}
          {addAdsProblem && <Alert kind="error">{addAdsProblem}</Alert>}
          {addAds.isSuccess && (
            <Alert kind="success">
              Pedido criado: {values.variations?.length ?? 0} anúncio(s) a partir de{' '}
              {adUtmContent({
                creativeType: values.variations?.[0]?.creativeType ?? 'image',
                position: addAds.data.firstPosition,
              })}
              .{' '}
              {addAds.data.approvalId && (
                <a href={`/marketing/trafego-pago-wings/aprovacoes/${addAds.data.approvalId}`}>
                  Ver a aprovação
                </a>
              )}
            </Alert>
          )}
          <div className="form-actions">
            <Button
              type="button"
              disabled={!canRequest || addAds.isPending || addAds.isSuccess || hasComplianceProblem}
              onClick={() => {
                setAddAdsProblem(null);
                const parsed = addAdsRequestSchema.safeParse({
                  campaignExternalId: targetCampaign,
                  identity: values.identity,
                  destinationUrl: values.destinationUrl,
                  utms: values.utms,
                  variations: values.variations,
                });
                if (!parsed.success) {
                  setAddAdsProblem(parsed.error.issues[0]?.message ?? 'Confira os campos.');
                  return;
                }
                addAds.mutate(parsed.data, {
                  onError: (error) =>
                    setAddAdsProblem(
                      error instanceof ApiError
                        ? error.message
                        : 'Não foi possível enviar o pedido.',
                    ),
                });
              }}
            >
              {addAds.isPending ? 'Enviando…' : 'Pedir aprovação dos anúncios'}
            </Button>
          </div>
        </section>
      )}
    </form>
  );
}
