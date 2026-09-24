import { zodResolver } from '@hookform/resolvers/zod';
import {
  AGENT_DRAFT_FIELD_LABEL,
  BRAZIL_STATES,
  CALLS_TO_ACTION,
  CALL_TO_ACTION_LABEL,
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_OBJECTIVE_HINT,
  CAMPAIGN_OBJECTIVE_LABEL,
  CARD_DESCRIPTION_MAX,
  COMPLIANCE_RULE_ADVICE,
  COMPLIANCE_RULE_LABEL,
  CREATIVE_FORMATS,
  CREATIVE_TYPES,
  CREATIVE_TYPE_LABEL,
  DEFAULT_AGE_MAX,
  DEFAULT_AGE_MIN,
  HEADLINE_MAX,
  ICP_MAX,
  MAX_AGE,
  MAX_CAROUSEL_CARDS,
  MAX_KEYWORDS,
  MAX_NEGATIVE_KEYWORDS,
  MAX_SEARCH_DESCRIPTIONS,
  MAX_SEARCH_HEADLINES,
  MAX_VARIATIONS,
  MAX_VIDEO_BYTES,
  MIN_AGE,
  MIN_CAROUSEL_CARDS,
  MIN_DAILY_BUDGET_CENTS,
  MIN_VARIATIONS,
  PAID_PLATFORMS,
  PLACEMENT_POSITION_LABEL,
  PLACEMENT_PUBLISHERS,
  PLACEMENT_PUBLISHER_LABEL,
  PLACEMENT_PUBLISHER_POSITIONS,
  PLATFORM_STATUS_LABEL,
  PRIMARY_TEXT_RECOMMENDED,
  SEARCH_DESCRIPTION_MAX,
  SEARCH_HEADLINE_MAX,
  UTM_KEYS,
  VIDEO_MIME_TYPES,
  applyUtms,
  audienceProfileSchema,
  buildUtms,
  campaignDays,
  campaignDaysInMonth,
  campaignDraftSchema,
  checkCopyCompliance,
  dailyOverdeliveryFactor,
  describeReach,
  estimateCostCents,
  isGooglePlatform,
  isPlatformEnabled,
  keywordWithMatch,
  matchesFormat,
  periodOverdeliveryFactor,
  platformAcceptsRadius,
  usesVerticalPlacements,
  type CampaignDraft,
  type CampaignDraftInput,
  type MediaBridgeResponse,
  type BrazilState,
  type ComplianceFinding,
  type AgentCampaignProposal,
  type CreativeFormat,
  type CreativeType,
  type CreativeUpload,
  type PacingSummary,
  type Placements,
  type VideoUpload,
} from '@wings/shared';
import { useEffect, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  useFieldArray,
  useForm,
  type Control,
  type FieldErrors,
  type Resolver,
  type UseFormRegister,
  type UseFormSetValue,
} from 'react-hook-form';
import { Link } from 'react-router-dom';
import {
  useAudienceProfile,
  useCockpit,
  useMetaIdentities,
  useRequestCampaign,
  useSaveAudienceProfile,
  useSaveMetaIdentityDefault,
  useUploadCreative,
  useUploadVideo,
} from '../../api/ads.js';
import { ApiError } from '../../api/client.js';
import { Alert, Button, Field, Input, Select } from '../ui.js';
import { BUILDER_DRAFT_KEY, PICKED_MEDIA_KEY } from '../../api/media.js';
import { AdPreviewGallery, creativeUrl, videoUrl } from './AdPreview.js';
import { formatBrl, formatDate, parseBrlToCents, todayInSaoPaulo } from './format.js';
import { SearchAdPreview, YoutubePreview } from './GooglePreview.js';
import { LibraryPick } from './LibraryPick.js';
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
 * What is validated and sent: only the parts that belong to the chosen
 * platform. The form keeps every platform's fields in its state, so switching
 * back and forth loses nothing; the schema refuses foreign parts, so they are
 * dropped here — once, for the check and for the request alike.
 */
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
    ...common
  } = values;
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
  'copy',
  'variations',
  'duration',
  'budget',
  'utms',
  'preview',
  'summary',
] as const;
const YOUTUBE_SECTIONS = [
  'platform',
  'objective',
  'icp',
  'reach',
  'video',
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

/** Shown on screen, not just refused: the operator must see why copy is blocked. */
function ComplianceWarning({ findings }: { findings: ComplianceFinding[] }) {
  if (findings.length === 0) return null;
  // The same excerpt may be typed in two boxes; say it once.
  const unique = [...new Map(findings.map((f) => [`${f.rule}:${f.excerpt}`, f])).values()];
  return (
    <div className="alert alert-warning" role="alert">
      <strong>Este texto não pode ir ao ar.</strong> A conta já teve anúncios reprovados por
      "práticas de negócios inaceitáveis".
      <ul>
        {unique.map((finding) => (
          <li key={`${finding.rule}:${finding.excerpt}`}>
            <strong>{COMPLIANCE_RULE_LABEL[finding.rule]}</strong> — “{finding.excerpt}”.{' '}
            {COMPLIANCE_RULE_ADVICE[finding.rule]}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "atualizado há 3 min" from an ISO instant; "nunca sincronizado" when null. */
function syncedAgoLabel(iso: string | null): string {
  if (!iso) return 'nunca sincronizado';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'atualizado agora mesmo';
  if (minutes < 60) return `atualizado há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `atualizado há ${hours}h`;
}

type WingsTotal = { capCents: number; usableCents: number; committedCents: number; spentCents: number };

/** Once regardless of platform: the cross-account figure, not any one account's. */
function WingsTotalLine({ wingsTotal }: { wingsTotal: WingsTotal | null }) {
  if (!wingsTotal) return null;
  const availableCents = Math.max(0, wingsTotal.usableCents - wingsTotal.committedCents);
  return (
    <p className="field-hint builder-ceiling-wings-total">
      Total Wings (todas as contas): <strong className="mono">{formatBrl(availableCents)}</strong>{' '}
      ainda planejável de {formatBrl(wingsTotal.usableCents)} utilizáveis.
    </p>
  );
}

function AccountCeiling({
  pacing,
  wingsTotal,
  platform,
}: {
  pacing: PacingSummary | null | undefined;
  wingsTotal: WingsTotal | null;
  platform: CampaignDraftInput['platform'];
}) {
  if (pacing === undefined) return <p className="muted">Lendo o teto da conta…</p>;

  // Search and YouTube spend from the same Google account: worth saying out
  // loud, since the ceiling below is not this campaign's alone.
  const sharedCaption = platform !== 'meta' && (
    <p className="field-hint">
      Pesquisa e YouTube compartilham a mesma conta e o mesmo teto do Google.
    </p>
  );

  if (pacing === null) {
    return (
      <div className="builder-ceiling">
        <Alert kind="error">
          Não há período de orçamento aberto para esta conta neste mês. Sem teto, nenhum pedido é
          aceito.
        </Alert>
        <p className="field-hint">sem teto próprio</p>
        {sharedCaption}
        <WingsTotalLine wingsTotal={wingsTotal} />
      </div>
    );
  }
  return (
    <div className="builder-ceiling">
      <span className="field-label">Teto real da conta neste mês</span>
      <p className="mono builder-ceiling-figure">{formatBrl(pacing.availableCents)}</p>
      <p className="field-hint">ainda pode ser planejado</p>
      {sharedCaption}
      <dl>
        <dt>Teto do mês</dt>
        <dd className="mono">{formatBrl(pacing.capCents)}</dd>
        <dt>Utilizável (70%)</dt>
        <dd className="mono">{formatBrl(pacing.usableCents)}</dd>
        <dt>Já comprometido</dt>
        <dd className="mono">{formatBrl(pacing.committedCents)}</dd>
        <dt>Já gasto</dt>
        <dd className="mono">{formatBrl(pacing.spentCents)}</dd>
      </dl>
      <div className="builder-ceiling-platform">
        <span className="field-label">Saldo/crédito informado pela plataforma</span>
        {pacing.platformRemainingCents !== null ? (
          <p className="mono">{formatBrl(pacing.platformRemainingCents)}</p>
        ) : (
          <p className="field-hint">
            {pacing.platformLimitNote ?? 'a plataforma não informa este número'}
          </p>
        )}
        <p className="field-hint">{syncedAgoLabel(pacing.platformLimitSyncedAtIso)}</p>
      </div>
      <WingsTotalLine wingsTotal={wingsTotal} />
      {pacing.killSwitchEngaged && (
        <Alert kind="error">Trava de emergência acionada: a conta não aceita pedidos agora.</Alert>
      )}
    </div>
  );
}

const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];

/**
 * One variation's image. Uploading happens on choosing the file, so the form
 * only ever holds the id of something the server has already accepted.
 */
function CreativeSlot({
  label,
  creativeId,
  format,
  error,
  vertical = false,
  onUploaded,
  library,
}: {
  label: string;
  creativeId: string;
  format: CreativeFormat | undefined;
  error: string | undefined;
  /** The manual placements include Stories or Reels, which are 9:16. */
  vertical?: boolean;
  onUploaded: (creative: CreativeUpload) => void;
  /** "Escolher do Drive", when the person may read the media library. */
  library?: ReactNode;
}) {
  const upload = useUploadCreative();
  const [problem, setProblem] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<CreativeUpload | null>(null);
  const current = uploaded && uploaded.id === creativeId ? uploaded : null;

  return (
    <div className="builder-creative">
      <div className="builder-creative-thumb">
        {creativeId ? (
          <img src={creativeUrl(creativeId)} alt={`Criativo — ${label}`} />
        ) : (
          <span className="muted">Sem imagem</span>
        )}
      </div>
      <div>
        <Field label={`Imagem — ${label}`} error={problem ?? error} hint="PNG ou JPEG, até 8 MB.">
          <input
            type="file"
            className="control"
            accept={ACCEPTED_TYPES.join(',')}
            disabled={upload.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setProblem(null);
              if (!ACCEPTED_TYPES.includes(file.type)) {
                setProblem('Use uma imagem PNG ou JPEG.');
                return;
              }
              upload.mutate(file, {
                onSuccess: ({ creative }) => {
                  setUploaded(creative);
                  onUploaded(creative);
                },
                onError: (failure) => setProblem(failure.message),
              });
            }}
          />
        </Field>
        {library}
        {upload.isPending && <p className="field-hint">Enviando…</p>}
        {current && (
          <p className="field-hint">
            {current.width} × {current.height} px
            {format &&
              (matchesFormat(current, format)
                ? ` · ✓ proporção ${format.ratio}`
                : ` · ⚠️ proporção diferente de ${format.ratio}: a plataforma vai cortar a imagem`)}
          </p>
        )}
        {current && vertical && VERTICAL_FORMAT && !matchesFormat(current, VERTICAL_FORMAT) && (
          <p className="field-hint builder-crop-warning">
            ⚠️ Esta imagem não é 9:16: será cortada em Stories e Reels.
          </p>
        )}
      </div>
    </div>
  );
}

const VERTICAL_FORMAT = CREATIVE_FORMATS.meta.find((item) => item.key === 'stories_reels');

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1024
    ? `${(megabytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} GB`
    : `${megabytes.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

/**
 * One video. Like an image, it is uploaded on choosing the file, so the form
 * only holds the id of something the server accepted. It goes to our own
 * storage — reaching Meta is part of executing an approved request.
 */
function VideoSlot({
  label,
  videoId,
  error,
  onChange,
  library,
}: {
  label: string;
  videoId: string;
  error: string | undefined;
  onChange: (video: VideoUpload | null) => void;
  library?: ReactNode;
}) {
  const upload = useUploadVideo();
  const [problem, setProblem] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<VideoUpload | null>(null);
  const current = uploaded && uploaded.id === videoId ? uploaded : null;

  return (
    <div className="builder-creative">
      <div className="builder-creative-thumb">
        {videoId ? (
          <video muted preload="metadata" src={videoUrl(videoId)} aria-label={`Vídeo — ${label}`} />
        ) : (
          <span className="muted">Sem vídeo</span>
        )}
      </div>
      <div>
        <Field label={`Vídeo — ${label}`} error={problem ?? error} hint="MP4 ou MOV, até 4 GB.">
          <input
            type="file"
            className="control"
            accept={VIDEO_MIME_TYPES.join(',')}
            disabled={upload.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setProblem(null);
              if (!(VIDEO_MIME_TYPES as readonly string[]).includes(file.type)) {
                setProblem('Use um vídeo MP4 ou MOV.');
                return;
              }
              // Refused here: nobody should wait on 4 GB going up to be told no.
              if (file.size > MAX_VIDEO_BYTES) {
                setProblem('O vídeo passa de 4 GB.');
                return;
              }
              upload.mutate(file, {
                onSuccess: ({ video }) => {
                  setUploaded(video);
                  onChange(video);
                },
                onError: (failure) => setProblem(failure.message),
              });
            }}
          />
        </Field>
        {library}
        {upload.isPending && (
          <p className="field-hint" role="status">
            <progress aria-label="Enviando vídeo" /> Enviando o vídeo… arquivos grandes levam alguns
            minutos.
          </p>
        )}
        {videoId && !upload.isPending && (
          <p className="field-hint">
            {current ? `${formatBytes(current.byteSize)} · ` : ''}
            <button type="button" className="link-button" onClick={() => onChange(null)}>
              Remover vídeo
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

/** A carousel's cards: each with its own media, title, text and link. */
function CarouselCards({
  index,
  control,
  register,
  setValue,
  cards,
  errors,
  format,
  vertical,
  revalidate,
}: {
  index: number;
  control: Control<CampaignDraftInput>;
  register: UseFormRegister<CampaignDraftInput>;
  setValue: UseFormSetValue<CampaignDraftInput>;
  cards: CardInput[];
  errors: FieldErrors<CampaignDraftInput>;
  format: CreativeFormat | undefined;
  vertical: boolean;
  revalidate: boolean;
}) {
  const list = useFieldArray({ control, name: `variations.${index}.cards` });
  const cardErrors = errors.variations?.[index]?.cards;
  const options = { shouldDirty: true, shouldValidate: revalidate };

  return (
    <div className="builder-cards">
      <p className="field-hint">
        De {MIN_CAROUSEL_CARDS} a {MAX_CAROUSEL_CARDS} cartões. {list.fields.length}/
        {MAX_CAROUSEL_CARDS}
      </p>
      {list.fields.map((field, cardIndex) => {
        const card = cards[cardIndex];
        const label = `Variação ${index + 1}, cartão ${cardIndex + 1}`;
        const path = `variations.${index}.cards.${cardIndex}` as const;
        const mediaType = card?.mediaType ?? 'image';
        return (
          <div className="builder-card" key={field.id}>
            <div className="builder-variation-head">
              <strong>Cartão {cardIndex + 1}</strong>
              <button type="button" className="link-button" onClick={() => list.remove(cardIndex)}>
                Remover cartão
              </button>
            </div>
            <div className="builder-segmented" role="group" aria-label={`Mídia — ${label}`}>
              {(['image', 'video'] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={mediaType === type}
                  className={`builder-segmented-option ${mediaType === type ? 'is-active' : ''}`}
                  onClick={() => setValue(`${path}.mediaType`, type, options)}
                >
                  {type === 'image' ? 'Imagem' : 'Vídeo'}
                </button>
              ))}
            </div>
            {mediaType === 'video' ? (
              <VideoSlot
                label={label}
                videoId={card?.videoId ?? ''}
                error={cardErrors?.[cardIndex]?.videoId?.message}
                onChange={(video) => setValue(`${path}.videoId`, video?.id, options)}
              />
            ) : (
              <CreativeSlot
                label={label}
                creativeId={card?.creativeId ?? ''}
                format={format}
                vertical={vertical}
                error={cardErrors?.[cardIndex]?.creativeId?.message}
                onUploaded={(creative) => setValue(`${path}.creativeId`, creative.id, options)}
              />
            )}
            <Field
              label="Título do cartão"
              error={cardErrors?.[cardIndex]?.headline?.message}
              hint={`${(card?.headline ?? '').length}/${HEADLINE_MAX}`}
            >
              <Input maxLength={HEADLINE_MAX} {...register(`${path}.headline`)} />
            </Field>
            <Field
              label="Texto do cartão"
              error={cardErrors?.[cardIndex]?.description?.message}
              hint={`${(card?.description ?? '').length}/${CARD_DESCRIPTION_MAX}`}
            >
              <Input maxLength={CARD_DESCRIPTION_MAX} {...register(`${path}.description`)} />
            </Field>
            <Field label="Link do cartão" error={cardErrors?.[cardIndex]?.link?.message}>
              <Input
                type="url"
                placeholder="https://wingscompany.com.br/…"
                {...register(`${path}.link`)}
              />
            </Field>
          </div>
        );
      })}
      {list.fields.length < MAX_CAROUSEL_CARDS && (
        <Button
          type="button"
          variant="ghost"
          onClick={() =>
            list.append({ mediaType: 'image', headline: '', description: '', link: '' })
          }
        >
          + Adicionar cartão
        </Button>
      )}
      {(cardErrors?.message ?? cardErrors?.root?.message) && (
        <p className="field-error" role="alert">
          {cardErrors?.message ?? cardErrors?.root?.message}
        </p>
      )}
    </div>
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
  applyRef,
}: {
  canRequest: boolean;
  /** `marketing.media.read`: shows "Escolher do Drive" beside the uploads. */
  canPickMedia?: boolean;
  /** Filled while the builder is on screen, null otherwise. */
  applyRef?: MutableRefObject<BuilderBridge | null>;
}) {
  const today = todayInSaoPaulo();
  const launch = useRequestCampaign();

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
      destinationUrl: '',
      variations: Array.from({ length: MIN_VARIATIONS }, () => ({
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
  const cockpit = useCockpit({ days: 7, platform });
  const pacing = cockpit.isLoading ? undefined : (cockpit.data?.cockpit.pacing ?? null);
  const wingsTotal = cockpit.data?.cockpit.wingsTotal ?? null;
  const google = isGooglePlatform(platform);
  const sections: readonly SectionKey[] =
    platform === 'youtube'
      ? YOUTUBE_SECTIONS
      : platform === 'google_search'
        ? SEARCH_SECTIONS
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
        : dailyBudgetCents < MIN_DAILY_BUDGET_CENTS
          ? 'A verba por dia precisa ser de pelo menos R$ 1,00.'
          : !values.startDate || !values.endDate
            ? 'Falta escolher o início e o fim da campanha.'
            : days === null
              ? 'O fim da campanha está antes do início.'
              : null;
  const budgetField = register('dailyBudgetCents', { setValueAs: parseBrlToCents });
  const daysThisMonth = campaignDaysInMonth(values.startDate, values.endDate, today);
  const costThisMonthCents = estimateCostCents(dailyBudgetCents, daysThisMonth, platform);
  const overCeiling =
    pacing != null && dailyBudgetCents > 0 && costThisMonthCents > pacing.availableCents;

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
      // Google's own notation for the match type: [exact], "phrase", broad.
      const keywords = proposal.search.keywords.map(keywordWithMatch);
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

  // The bridge always points at this render's functions, and at nothing once
  // the builder leaves the screen.
  const bridge = {
    getDraft: () => shapeDraft(getValues()) as Record<string, unknown>,
    applyProposal,
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
          label: `Variação ${index + 1}`,
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

  const copyFields = (index: number) => (
    <div className="builder-variation" key={variations.fields[index]?.id ?? index}>
      <div className="builder-variation-head">
        <strong>Variação {index + 1}</strong>
        {index >= MIN_VARIATIONS && (
          <button type="button" className="link-button" onClick={() => variations.remove(index)}>
            Remover
          </button>
        )}
      </div>
      <Field
        label="Título"
        error={errors.variations?.[index]?.headline?.message}
        hint={`${(formVariations[index]?.headline ?? '').length}/${HEADLINE_MAX}`}
      >
        <Input maxLength={HEADLINE_MAX} {...register(`variations.${index}.headline`)} />
      </Field>
      <Field
        label="Texto"
        error={errors.variations?.[index]?.primaryText?.message}
        hint={`${(formVariations[index]?.primaryText ?? '').length} caracteres — a Meta corta perto de ${PRIMARY_TEXT_RECOMMENDED}`}
      >
        <textarea className="control" rows={3} {...register(`variations.${index}.primaryText`)} />
      </Field>
      <Field label="Botão (CTA)">
        <Select {...register(`variations.${index}.callToAction`)}>
          {CALLS_TO_ACTION.map((cta) => (
            <option key={cta} value={cta}>
              {CALL_TO_ACTION_LABEL[cta]}
            </option>
          ))}
        </Select>
      </Field>
      <ComplianceWarning findings={findingsByVariation[index] ?? []} />
    </div>
  );

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
        const launching = submitter instanceof HTMLButtonElement && submitter.value === 'launch';
        setChecked(null);
        launch.reset();
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
          else setChecked(draft);
        })(event);
      }}
    >
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
        <Field label="Nome da campanha" error={errors.name?.message}>
          <Input placeholder="Ex.: Expansão SP — outubro" {...register('name')} />
        </Field>
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
            why="A imagem é o que faz a pessoa parar de rolar o feed. Uma por variação, para a Meta descobrir qual segura mais gente."
          >
            <p className="field-hint">
              Um criativo por variação: imagem única, vídeo ou carrossel. Fica guardado no Wings
              System — só vai para a Meta quando um pedido aprovado for executado.
            </p>
            {variations.fields.map((field, index) => {
              const variation = formVariations[index];
              const creativeType: CreativeType = variation?.creativeType ?? 'image';
              const label = `Variação ${index + 1}`;
              const options = { shouldDirty: true, shouldValidate: submitCount > 0 };
              return (
                <div className="builder-variation" key={field.id}>
                  <div
                    className="builder-segmented"
                    role="group"
                    aria-label={`Tipo de criativo — ${label}`}
                  >
                    {CREATIVE_TYPES.map((type) => (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={creativeType === type}
                        className={`builder-segmented-option ${creativeType === type ? 'is-active' : ''}`}
                        onClick={() => {
                          setValue(`variations.${index}.creativeType`, type, options);
                          // A carousel opens with the fewest cards it may have.
                          if (type === 'carousel' && (variation?.cards ?? []).length === 0) {
                            setValue(
                              `variations.${index}.cards`,
                              Array.from({ length: MIN_CAROUSEL_CARDS }, () => ({
                                mediaType: 'image' as const,
                                headline: '',
                                description: '',
                                link: '',
                              })),
                              options,
                            );
                          }
                        }}
                      >
                        {CREATIVE_TYPE_LABEL[type]}
                      </button>
                    ))}
                  </div>
                  {creativeType === 'image' && (
                    <CreativeSlot
                      label={label}
                      creativeId={variation?.creativeId ?? ''}
                      format={format}
                      vertical={vertical}
                      error={errors.variations?.[index]?.creativeId?.message}
                      onUploaded={(creative) => {
                        setValue(`variations.${index}.creativeId`, creative.id, options);
                        // A file from the computer is not a library asset.
                        setValue(`variations.${index}.mediaAssetId`, undefined, options);
                      }}
                      library={
                        canPickMedia && (
                          <LibraryPick
                            kind="image"
                            label={label}
                            onPicked={(picked) => {
                              if (!picked.creative) return;
                              setValue(
                                `variations.${index}.creativeId`,
                                picked.creative.id,
                                options,
                              );
                              setValue(
                                `variations.${index}.mediaAssetId`,
                                picked.mediaAssetId,
                                options,
                              );
                            }}
                          />
                        )
                      }
                    />
                  )}
                  {creativeType === 'video' && (
                    <VideoSlot
                      label={label}
                      videoId={variation?.videoId ?? ''}
                      error={errors.variations?.[index]?.videoId?.message}
                      onChange={(video) => {
                        setValue(`variations.${index}.videoId`, video?.id, options);
                        setValue(`variations.${index}.mediaAssetId`, undefined, options);
                      }}
                      library={
                        canPickMedia && (
                          <LibraryPick
                            kind="video"
                            label={label}
                            onPicked={(picked) => {
                              if (!picked.video) return;
                              setValue(`variations.${index}.videoId`, picked.video.id, options);
                              setValue(
                                `variations.${index}.mediaAssetId`,
                                picked.mediaAssetId,
                                options,
                              );
                            }}
                          />
                        )
                      }
                    />
                  )}
                  {creativeType === 'carousel' && (
                    <CarouselCards
                      index={index}
                      control={control}
                      register={register}
                      setValue={setValue}
                      cards={variation?.cards ?? []}
                      errors={errors}
                      format={format}
                      vertical={vertical}
                      revalidate={submitCount > 0}
                    />
                  )}
                </div>
              );
            })}
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
            step={stepOf('copy')}
            title="Copy"
            why="É o que convence depois que a imagem chamou atenção. Promessa de ganho reprova o anúncio e pode restringir a conta — por isso o bloqueio."
          >
            <Field
              label="Página de destino"
              error={errors.destinationUrl?.message}
              hint="Para onde o botão do anúncio leva. Os UTMs são aplicados a este endereço."
            >
              <Input
                type="url"
                placeholder="https://wingscompany.com.br/…"
                {...register('destinationUrl')}
              />
            </Field>
            {copyFields(0)}
          </BuilderSection>

          <BuilderSection
            step={stepOf('variations')}
            title="Variações"
            why="A Meta testa as versões entre si e entrega mais a que dá mais resultado. Com uma só, não há o que comparar."
          >
            <p className="field-hint">
              De {MIN_VARIATIONS} a {MAX_VARIATIONS} por campanha, para a plataforma ter o que
              comparar.
            </p>
            {variations.fields.slice(1).map((_, offset) => copyFields(offset + 1))}
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
                + Adicionar variação
              </Button>
            )}
            {errors.variations?.root?.message && (
              <p className="field-error" role="alert">
                {errors.variations.root.message}
              </p>
            )}
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
              placeholder="https://wingscompany.com.br/…"
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
              label="Palavras-chave"
              error={listError(errors.search?.keywords)}
              hint={`${linesOf(keywordsText).length}/${MAX_KEYWORDS} · uma por linha`}
            >
              <textarea
                className="control builder-keywords"
                rows={6}
                placeholder={'franquia de alimentação\nabrir franquia'}
                value={keywordsText}
                onChange={(event) => {
                  setKeywordsText(event.target.value);
                  setValue('search.keywords', linesOf(event.target.value), {
                    shouldDirty: true,
                    shouldValidate: submitCount > 0,
                  });
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
              Ficam guardadas no pedido. O grupo de anúncios, onde elas passam a valer, entra na
              próxima etapa.
            </p>
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
                placeholder="https://wingscompany.com.br/…"
                {...register('destinationUrl')}
              />
            </Field>
            {searchHeadlines.map((_, index) => (
              <Field
                key={`headline-${index}`}
                label={`Título ${index + 1}${index === 0 ? '' : ' (opcional)'}`}
                error={index === 0 ? listError(errors.search?.headlines) : undefined}
                hint={`${(searchHeadlines[index] ?? '').length}/${SEARCH_HEADLINE_MAX}`}
              >
                <Input maxLength={SEARCH_HEADLINE_MAX} {...register(`search.headlines.${index}`)} />
              </Field>
            ))}
            {searchDescriptions.map((_, index) => (
              <Field
                key={`description-${index}`}
                label={`Descrição ${index + 1}${index === 0 ? '' : ' (opcional)'}`}
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
                  void budgetField.onChange(event);
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
          <AccountCeiling pacing={pacing} wingsTotal={wingsTotal} platform={platform} />
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
        <p className="field-hint">Gerados a partir do nome e do objetivo. Edite se precisar.</p>
        <div className="builder-utms">
          {UTM_KEYS.map((key) => (
            <Field key={key} label={key} error={errors.utms?.[key]?.message}>
              <Input className="mono" {...register(`utms.${key}`)} />
            </Field>
          ))}
        </div>
        <p className="field-hint builder-url mono">
          {applyUtms(values.destinationUrl ?? '', values.utms, 0) ??
            'Informe a página de destino para ver o endereço final.'}
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
              <dt>Variações</dt>
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
          <dt>Destino com UTMs</dt>
          <dd className="mono builder-url">
            {applyUtms(values.destinationUrl ?? '', values.utms, 0) ?? '—'}
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

        <div className="form-actions">
          <Button type="submit" variant="ghost" value="check">
            Conferir campanha
          </Button>
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
    </form>
  );
}
