import {
  DEMAND_GEN_AGE_MAXES,
  DEMAND_GEN_AGE_MINS,
  DEMAND_GEN_BUSINESS_NAME_MAX,
  DEMAND_GEN_CHANNEL_LABEL,
  DEMAND_GEN_CHANNELS,
  DEMAND_GEN_DESCRIPTION_MAX,
  DEMAND_GEN_HEADLINE_MAX,
  DEMAND_GEN_LOGO_MAX_BYTES,
  DEMAND_GEN_LOGO_MIN_PX,
  DEMAND_GEN_LONG_HEADLINE_MAX,
  DEMAND_GEN_MAX_TEXTS,
  DEMAND_GEN_MAX_VIDEOS,
  DEMAND_GEN_SEGMENT_KIND_LABEL,
  YOUTUBE_VIDEO_STATUS_LABEL,
  checkCopyCompliance,
  demandGenAgeLabel,
  parseYoutubeVideoRef,
  type CampaignDraftInput,
  type DemandGenChannel,
  type DemandGenOptions,
  type MediaAsset,
  type YoutubeVideoCheck,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import type { FieldErrors, UseFormRegister, UseFormSetValue } from 'react-hook-form';
import { ApiError } from '../../api/client.js';
import { useCheckYoutubeVideos } from '../../api/ads.js';
import { mediaFileUrl } from '../../api/media.js';
import { MediaPicker } from '../media-studio/MediaLibrary.js';
import { Alert, Button, Field, Input, Select } from '../ui.js';
import { ComplianceWarning } from './CreativeBlock.js';
import { parseBrlToCents } from './format.js';

/**
 * The YouTube (Demand Gen) parts of the builder: the video ad (videos, texts,
 * business name, logo from the Drive) and how it bids and whom it reaches
 * (the account's conversion, target CPA, ages, YouTube channels, signals).
 * Everything here is in the draft, so in the approved hash and in the one
 * write Google receives.
 */

type YoutubeInput = NonNullable<CampaignDraftInput['youtube']>;

interface FormBits {
  register: UseFormRegister<CampaignDraftInput>;
  setValue: UseFormSetValue<CampaignDraftInput>;
  youtube: Partial<YoutubeInput> | undefined;
  errors: FieldErrors<CampaignDraftInput>;
  listError: (error: unknown) => string | undefined;
}

const filled = { shouldDirty: true, shouldValidate: false } as const;

/** The target CPA as the box shows it: 9000 -> "90,00"; none -> "". */
const cpaTextOf = (cents: number | undefined) =>
  cents === undefined || Number.isNaN(cents) ? '' : (cents / 100).toFixed(2).replace('.', ',');

/** Every piece of copy the ad carries, for the compliance warning and the lock on Lançar. */
export function youtubeCopy(youtube: Partial<YoutubeInput> | undefined): string[] {
  return [
    ...(youtube?.headlines ?? []),
    ...(youtube?.longHeadlines ?? []),
    ...(youtube?.descriptions ?? []),
    youtube?.businessName ?? '',
  ];
}

/** Why a library image cannot be the ad's logo, or null when Google takes it. */
export function logoRefusal(
  asset: Pick<MediaAsset, 'mimeType' | 'width' | 'height' | 'byteSize' | 'driveFileId'>,
): string | null {
  if (!asset.driveFileId) return 'Ainda não está no Drive';
  if (asset.mimeType !== 'image/png' && asset.mimeType !== 'image/jpeg') return 'Use PNG ou JPEG';
  if (asset.byteSize > DEMAND_GEN_LOGO_MAX_BYTES) return 'Maior que 5 MB';
  const { width, height } = asset;
  if (!width || !height) return null;
  if (Math.abs(width - height) > Math.max(width, height) * 0.01) return 'Não é quadrada';
  if (width < DEMAND_GEN_LOGO_MIN_PX) return `Menor que ${DEMAND_GEN_LOGO_MIN_PX} px`;
  return null;
}

export function YoutubeAdFields({
  register,
  setValue,
  youtube,
  errors,
  listError,
  destinationError,
  canPickMedia,
}: FormBits & { destinationError?: string; canPickMedia: boolean }) {
  const check = useCheckYoutubeVideos();
  const [checks, setChecks] = useState<Map<string, YoutubeVideoCheck>>(new Map());
  const [picking, setPicking] = useState(false);
  const [logo, setLogo] = useState<MediaAsset | null>(null);
  const videos = youtube?.videos ?? [];
  const headlines = youtube?.headlines ?? [];
  const longHeadlines = youtube?.longHeadlines ?? [];
  const descriptions = youtube?.descriptions ?? [];
  const findings = youtubeCopy(youtube).flatMap((text) => checkCopyCompliance(text ?? ''));
  const errorOf = (field: keyof YoutubeInput) =>
    (errors.youtube as Record<string, { message?: string }> | undefined)?.[field]?.message;

  const runCheck = () => {
    const refs = videos.filter((video) => (video ?? '').trim() !== '');
    if (refs.length === 0) return;
    check.mutate(refs, {
      onSuccess: (answer) => setChecks(new Map(answer.videos.map((item) => [item.videoId, item]))),
    });
  };

  return (
    <>
      <Field
        label="Página de destino"
        error={destinationError}
        hint="Para onde o anúncio leva, sem UTM: a campanha leva as suas (veja UTMs)."
      >
        <Input
          type="url"
          placeholder="https://wingssystem.online/lp/formatacao"
          {...register('destinationUrl')}
        />
      </Field>

      <fieldset className="builder-fieldset">
        <legend className="field-label">Vídeos do YouTube (1 a {DEMAND_GEN_MAX_VIDEOS})</legend>
        <p className="field-hint">
          Link ou id do vídeo. Ele precisa estar publicado no canal, como público ou não listado: o
          Google não usa vídeo privado.
        </p>
        {videos.map((_, index) => {
          const id = parseYoutubeVideoRef(videos[index] ?? '');
          const status = id ? checks.get(id) : undefined;
          return (
            <Field
              key={`video-${index}`}
              label={`Vídeo ${index + 1}${index === 0 ? '' : ' (opcional)'}`}
              error={index === 0 ? listError(errors.youtube?.videos) : undefined}
              hint={status ? YOUTUBE_VIDEO_STATUS_LABEL[status.status] : undefined}
            >
              <Input
                placeholder="https://www.youtube.com/watch?v=…"
                {...register(`youtube.videos.${index}`)}
              />
            </Field>
          );
        })}
        <Button type="button" variant="ghost" disabled={check.isPending} onClick={runCheck}>
          {check.isPending ? 'Conferindo no YouTube…' : 'Conferir vídeos no YouTube'}
        </Button>
        {check.error && (
          <p className="field-error" role="alert">
            {check.error instanceof ApiError
              ? check.error.message
              : 'Não deu para conferir os vídeos agora.'}
          </p>
        )}
      </fieldset>

      <p className="field-hint">
        Anúncio de vídeo do Demand Gen: o Google combina títulos, títulos longos e descrições. Ao
        menos 1 de cada, até {DEMAND_GEN_MAX_TEXTS}.
      </p>
      {headlines.map((_, index) => (
        <Field
          key={`dg-headline-${index}`}
          label={`Título ${index + 1}${index === 0 ? '' : ' (opcional)'}`}
          error={index === 0 ? listError(errors.youtube?.headlines) : undefined}
          hint={`${(headlines[index] ?? '').length}/${DEMAND_GEN_HEADLINE_MAX}`}
        >
          <Input maxLength={DEMAND_GEN_HEADLINE_MAX} {...register(`youtube.headlines.${index}`)} />
        </Field>
      ))}
      {longHeadlines.map((_, index) => (
        <Field
          key={`dg-long-${index}`}
          label={`Título longo ${index + 1}${index === 0 ? '' : ' (opcional)'}`}
          error={index === 0 ? listError(errors.youtube?.longHeadlines) : undefined}
          hint={`${(longHeadlines[index] ?? '').length}/${DEMAND_GEN_LONG_HEADLINE_MAX}`}
        >
          <Input
            maxLength={DEMAND_GEN_LONG_HEADLINE_MAX}
            {...register(`youtube.longHeadlines.${index}`)}
          />
        </Field>
      ))}
      {descriptions.map((_, index) => (
        <Field
          key={`dg-description-${index}`}
          label={`Descrição ${index + 1}${index === 0 ? '' : ' (opcional)'}`}
          error={index === 0 ? listError(errors.youtube?.descriptions) : undefined}
          hint={`${(descriptions[index] ?? '').length}/${DEMAND_GEN_DESCRIPTION_MAX}`}
        >
          <textarea
            className="control"
            rows={2}
            maxLength={DEMAND_GEN_DESCRIPTION_MAX}
            {...register(`youtube.descriptions.${index}`)}
          />
        </Field>
      ))}
      <Field
        label="Nome da empresa"
        error={errorOf('businessName')}
        hint={`${(youtube?.businessName ?? '').length}/${DEMAND_GEN_BUSINESS_NAME_MAX}`}
      >
        <Input maxLength={DEMAND_GEN_BUSINESS_NAME_MAX} {...register('youtube.businessName')} />
      </Field>

      <fieldset className="builder-fieldset">
        <legend className="field-label">Logo</legend>
        <p className="field-hint">
          Do Drive: PNG ou JPEG quadrado, de pelo menos {DEMAND_GEN_LOGO_MIN_PX} ×{' '}
          {DEMAND_GEN_LOGO_MIN_PX} px e até 5 MB. O Google mostra ao lado do nome da empresa.
        </p>
        {/* The picture shown is the one the draft names: a template or a saved
            draft that brings another logo replaces it here too. */}
        {logo && logo.driveFileId === youtube?.logoFileId ? (
          <img
            className="builder-logo-preview"
            src={mediaFileUrl(logo)}
            alt="Logo escolhida para o anúncio"
          />
        ) : youtube?.logoFileId ? (
          <p className="field-hint">Logo escolhida no Drive.</p>
        ) : null}
        {canPickMedia ? (
          <Button type="button" variant="ghost" onClick={() => setPicking(true)}>
            {youtube?.logoFileId ? 'Trocar a logo' : 'Escolher a logo no Drive'}
          </Button>
        ) : (
          <Alert kind="info">Escolher a logo pede acesso à biblioteca de mídia do Marketing.</Alert>
        )}
        {errorOf('logoFileId') && (
          <p className="field-error" role="alert">
            {errorOf('logoFileId')}
          </p>
        )}
        {picking && (
          <MediaPicker
            title="Escolher a logo do anúncio"
            kind="image"
            refusal={logoRefusal}
            onClose={() => setPicking(false)}
            onPick={(asset) => {
              setPicking(false);
              if (logoRefusal(asset) || !asset.driveFileId) return;
              setLogo(asset);
              setValue('youtube.logoFileId', asset.driveFileId, filled);
            }}
          />
        )}
      </fieldset>
      <ComplianceWarning findings={findings} />
    </>
  );
}

export function YoutubeBiddingFields({
  register,
  setValue,
  youtube,
  errors,
  options,
}: Omit<FormBits, 'listError'> & {
  options: { data?: DemandGenOptions; isLoading: boolean; error: unknown };
}) {
  const [cpaText, setCpaText] = useState(cpaTextOf(youtube?.targetCpaCents));
  // A template or a saved draft sets the target from outside the box: the box
  // follows, so what is on screen is what goes in the request.
  const targetCpa = youtube?.targetCpaCents;
  useEffect(() => {
    setCpaText((typed) => {
      const read = typed.trim() === '' ? undefined : parseBrlToCents(typed);
      const same = read === targetCpa || (Number.isNaN(read) && Number.isNaN(targetCpa));
      return same ? typed : cpaTextOf(targetCpa);
    });
  }, [targetCpa]);
  const channels = (youtube?.channels ?? []) as DemandGenChannel[];
  const segments = youtube?.audienceSegments ?? [];
  const actions = options.data?.conversionActions ?? [];
  const chosen = youtube?.conversionAction;
  const errorOf = (field: keyof YoutubeInput) =>
    (errors.youtube as Record<string, { message?: string }> | undefined)?.[field]?.message;
  const conversionError =
    errorOf('conversionAction') ??
    (errors.youtube?.conversionAction as { id?: { message?: string } } | undefined)?.id?.message;

  return (
    <>
      <Field
        label="Ação de conversão (lance: Maximizar conversões)"
        error={conversionError}
        hint="Lida da conta do Google Ads. A campanha aprende só com esta conversão."
      >
        <Select
          value={chosen?.id ?? ''}
          disabled={options.isLoading || actions.length === 0}
          onChange={(event) => {
            const action = actions.find((item) => item.id === event.target.value);
            setValue(
              'youtube.conversionAction',
              action ? { id: action.id, name: action.name } : { id: '', name: '' },
              filled,
            );
          }}
        >
          <option value="">
            {options.isLoading
              ? 'Lendo as conversões da conta…'
              : chosen?.name && !chosen.id
                ? `"${chosen.name}" não foi encontrada na conta`
                : 'Escolha a conversão'}
          </option>
          {actions.map((action) => (
            <option key={action.id} value={action.id}>
              {action.name}
              {action.primary ? ' (principal)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      {Boolean(options.error) && (
        <Alert kind="error">
          {options.error instanceof ApiError
            ? options.error.message
            : 'Não deu para ler as conversões da conta do Google Ads.'}
        </Alert>
      )}
      <Field
        label="CPA alvo (opcional)"
        error={errorOf('targetCpaCents')}
        hint="Em branco: o Google busca o máximo de conversões com a verba. Com valor, mira esse custo por conversão (a verba diária ideal é 15 vezes ele)."
      >
        <Input
          inputMode="decimal"
          placeholder="ex.: 90,00"
          value={cpaText}
          onChange={(event) => {
            const text = event.target.value;
            setCpaText(text);
            // Blank is "no target"; anything unreadable stays unreadable, so the
            // schema says so instead of the draft silently losing the target.
            setValue(
              'youtube.targetCpaCents',
              text.trim() === '' ? undefined : parseBrlToCents(text),
              filled,
            );
          }}
        />
      </Field>

      <div className="builder-row">
        <Field label="Idade mínima" error={errorOf('ageMin')}>
          <Select {...register('youtube.ageMin', { valueAsNumber: true })}>
            {DEMAND_GEN_AGE_MINS.map((age) => (
              <option key={age} value={age}>
                {demandGenAgeLabel(age, false)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Idade máxima" error={errorOf('ageMax')}>
          <Select {...register('youtube.ageMax', { valueAsNumber: true })}>
            {DEMAND_GEN_AGE_MAXES.map((age) => (
              <option key={age} value={age}>
                {demandGenAgeLabel(age, true)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="builder-option">
        <input type="checkbox" {...register('youtube.includeUnknownAge')} />
        <span>Incluir quem o Google não sabe a idade</span>
      </label>

      <fieldset className="builder-fieldset">
        <legend className="field-label">Onde aparece</legend>
        {DEMAND_GEN_CHANNELS.map((channel) => (
          <label key={channel} className="builder-option">
            <input
              type="checkbox"
              checked={channels.includes(channel)}
              onChange={(event) =>
                setValue(
                  'youtube.channels',
                  event.target.checked
                    ? DEMAND_GEN_CHANNELS.filter(
                        (item) => item === channel || channels.includes(item),
                      )
                    : channels.filter((item) => item !== channel),
                  filled,
                )
              }
            />
            <span>{DEMAND_GEN_CHANNEL_LABEL[channel]}</span>
          </label>
        ))}
        <p className="field-hint">Discover, Gmail e Display ficam sempre desligados.</p>
        {errorOf('channels') && (
          <p className="field-error" role="alert">
            {errorOf('channels')}
          </p>
        )}
      </fieldset>

      <fieldset className="builder-fieldset">
        <legend className="field-label">Sinais de público (opcional)</legend>
        <p className="field-hint">
          Listas e segmentos personalizados da conta. Com sinais, o Google pode procurar pessoas
          parecidas além deles, sempre dentro das idades acima.
        </p>
        {(options.data?.audienceSegments ?? []).length === 0 ? (
          <p className="field-hint">
            {options.isLoading
              ? 'Lendo os públicos da conta…'
              : 'A conta não tem listas nem segmentos.'}
          </p>
        ) : (
          options.data?.audienceSegments.map((segment) => {
            const on = segments.some(
              (item) => item?.kind === segment.kind && item.id === segment.id,
            );
            return (
              <label key={`${segment.kind}:${segment.id}`} className="builder-option">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(event) =>
                    setValue(
                      'youtube.audienceSegments',
                      event.target.checked
                        ? [...segments, segment]
                        : segments.filter(
                            (item) => !(item?.kind === segment.kind && item.id === segment.id),
                          ),
                      filled,
                    )
                  }
                />
                <span>
                  {segment.name}{' '}
                  <span className="cell-sub">{DEMAND_GEN_SEGMENT_KIND_LABEL[segment.kind]}</span>
                </span>
              </label>
            );
          })
        )}
      </fieldset>

      <Field label="Nome do grupo de anúncios (opcional)" hint="Em branco, usa o nome da campanha.">
        <Input {...register('youtube.adGroupName')} />
      </Field>
    </>
  );
}
