import {
  CALLS_TO_ACTION,
  CALL_TO_ACTION_LABEL,
  CARD_DESCRIPTION_MAX,
  COMPLIANCE_RULE_ADVICE,
  COMPLIANCE_RULE_LABEL,
  CREATIVE_FORMATS,
  CREATIVE_TYPES,
  CREATIVE_TYPE_LABEL,
  HEADLINE_MAX,
  MAX_CAROUSEL_CARDS,
  MAX_VIDEO_BYTES,
  MIN_CAROUSEL_CARDS,
  PRIMARY_TEXT_RECOMMENDED,
  VIDEO_MIME_TYPES,
  matchesFormat,
  type CampaignDraftInput,
  type ComplianceFinding,
  type CreativeFormat,
  type CreativeType,
  type CreativeUpload,
  type MediaBridgeResponse,
  type VideoUpload,
} from '@wings/shared';
import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  useFieldArray,
  type Control,
  type FieldErrors,
  type UseFormRegister,
  type UseFormSetValue,
} from 'react-hook-form';
import { useUploadCreative, useUploadVideo } from '../../api/ads.js';
import { Button, Field, Input, Select } from '../ui.js';
import { creativeUrl, videoUrl } from './AdPreview.js';
import { LibraryPick } from './LibraryPick.js';

/**
 * Block 7 of the builder, "Criativo": every creative of the ad set, whole, in
 * one place. Each card is one ad: its type (image, video or carousel), the
 * file, the words and the button. Nothing about a creative lives in another
 * block.
 */

export type VariationInput = NonNullable<CampaignDraftInput['variations']>[number];
export type CardInput = NonNullable<VariationInput['cards']>[number];

const IMAGE_TYPES = ['image/png', 'image/jpeg'];
const VERTICAL_FORMAT = CREATIVE_FORMATS.meta.find((item) => item.key === 'stories_reels');

export function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1024
    ? `${(megabytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} GB`
    : `${megabytes.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

/** Shown on screen, not just refused: the operator must see why copy is blocked. */
export function ComplianceWarning({ findings }: { findings: ComplianceFinding[] }) {
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

type Accept = 'image' | 'video' | 'any';

/**
 * The file of one creative or card: dropped, chosen from the computer or
 * picked from the Drive. Sending starts on the choice and the bar follows it,
 * so the form only ever holds the id of something the server accepted.
 */
export function MediaDropzone({
  label,
  accept,
  creativeId,
  videoId,
  format,
  vertical = false,
  error,
  canPickMedia = false,
  onImage,
  onVideo,
  onClear,
}: {
  label: string;
  accept: Accept;
  creativeId: string;
  videoId: string;
  format: CreativeFormat | undefined;
  /** The manual placements include Stories or Reels, which are 9:16. */
  vertical?: boolean;
  error: string | undefined;
  /** `marketing.media.read`: shows "Escolher do Drive". */
  canPickMedia?: boolean;
  onImage: (creative: CreativeUpload, mediaAssetId?: string) => void;
  onVideo: (video: VideoUpload, mediaAssetId?: string) => void;
  onClear: () => void;
}) {
  const imageUpload = useUploadCreative();
  const videoUpload = useUploadVideo();
  const [problem, setProblem] = useState<string | null>(null);
  const [image, setImage] = useState<CreativeUpload | null>(null);
  const [video, setVideo] = useState<VideoUpload | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const currentImage = image && image.id === creativeId ? image : null;
  const currentVideo = video && video.id === videoId ? video : null;
  const pending = imageUpload.isPending || videoUpload.isPending;
  const progress = imageUpload.isPending ? imageUpload.progress : videoUpload.progress;
  const hasFile = Boolean(creativeId || videoId);

  const acceptTypes =
    accept === 'image'
      ? IMAGE_TYPES
      : accept === 'video'
        ? [...VIDEO_MIME_TYPES]
        : [...IMAGE_TYPES, ...VIDEO_MIME_TYPES];
  const wording =
    accept === 'image'
      ? 'PNG ou JPEG, até 8 MB'
      : accept === 'video'
        ? 'MP4 ou MOV, até 4 GB'
        : 'PNG, JPEG (até 8 MB), MP4 ou MOV (até 4 GB)';
  const inputLabel = `${accept === 'image' ? 'Imagem' : accept === 'video' ? 'Vídeo' : 'Arquivo'} — ${label}`;

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    const isImage = IMAGE_TYPES.includes(file.type);
    const isVideo = (VIDEO_MIME_TYPES as readonly string[]).includes(file.type);
    if (isImage && accept !== 'video') {
      imageUpload.mutate(file, {
        onSuccess: ({ creative }) => {
          setImage(creative);
          onImage(creative);
        },
        onError: (failure) => setProblem(failure.message),
      });
      return;
    }
    if (isVideo && accept !== 'image') {
      // Refused here: nobody should wait on 4 GB going up to be told no.
      if (file.size > MAX_VIDEO_BYTES) {
        setProblem('O vídeo passa de 4 GB.');
        return;
      }
      videoUpload.mutate(file, {
        onSuccess: ({ video: sent }) => {
          setVideo(sent);
          onVideo(sent);
        },
        onError: (failure) => setProblem(failure.message),
      });
      return;
    }
    setProblem(
      accept === 'image'
        ? 'Use uma imagem PNG ou JPEG.'
        : accept === 'video'
          ? 'Use um vídeo MP4 ou MOV.'
          : 'Use uma imagem PNG ou JPEG, ou um vídeo MP4 ou MOV.',
    );
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    if (pending) return;
    handleFile(event.dataTransfer.files?.[0]);
  };

  const cancel = () => {
    imageUpload.cancel();
    videoUpload.cancel();
  };

  const preview = creativeId ? (
    <img src={creativeUrl(creativeId)} alt={`Criativo — ${label}`} />
  ) : videoId ? (
    <video muted preload="metadata" src={videoUrl(videoId)} aria-label={`Vídeo — ${label}`} />
  ) : (
    <span className="muted">{pending ? 'Enviando…' : 'Arraste o arquivo aqui'}</span>
  );

  return (
    <div
      className={`builder-dropzone ${over ? 'is-over' : ''} ${hasFile ? 'has-file' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!pending) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="builder-dropzone-preview">{preview}</div>
      <div className="builder-dropzone-body">
        <span className="field-label">{inputLabel}</span>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="builder-dropzone-input"
          aria-label={inputLabel}
          accept={acceptTypes.join(',')}
          disabled={pending}
          onChange={(event) => {
            handleFile(event.target.files?.[0]);
            // The same file chosen twice must fire again.
            event.target.value = '';
          }}
        />
        <div className="builder-dropzone-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
          >
            Escolher arquivo
          </Button>
          {canPickMedia && accept !== 'video' && (
            <LibraryPick
              kind="image"
              label={label}
              onPicked={(picked: MediaBridgeResponse) => {
                if (!picked.creative) return;
                setImage(picked.creative);
                onImage(picked.creative, picked.mediaAssetId);
              }}
            />
          )}
          {canPickMedia && accept === 'video' && (
            <LibraryPick
              kind="video"
              label={label}
              onPicked={(picked: MediaBridgeResponse) => {
                if (!picked.video) return;
                // The bridge only hands back videos the ads accept.
                const sent = picked.video as VideoUpload;
                setVideo(sent);
                onVideo(sent, picked.mediaAssetId);
              }}
            />
          )}
        </div>
        <p className="field-hint">Arraste e solte, ou escolha. {wording}.</p>
        {pending && (
          <p className="field-hint builder-dropzone-progress" role="status">
            <progress aria-label={`Enviando — ${label}`} value={progress} max={1} />{' '}
            <span>{Math.round(progress * 100)}%</span>{' '}
            <button type="button" className="link-button" onClick={cancel}>
              Cancelar
            </button>
          </p>
        )}
        {(problem ?? error) && (
          <p className="field-error" role="alert">
            {problem ?? error}
          </p>
        )}
        {currentImage && (
          <p className="field-hint">
            {currentImage.width} × {currentImage.height} px
            {format &&
              (matchesFormat(currentImage, format)
                ? ` · ✓ proporção ${format.ratio}`
                : ` · ⚠️ proporção diferente de ${format.ratio}: a plataforma vai cortar a imagem`)}
          </p>
        )}
        {currentImage &&
          vertical &&
          VERTICAL_FORMAT &&
          !matchesFormat(currentImage, VERTICAL_FORMAT) && (
            <p className="field-hint builder-crop-warning">
              ⚠️ Esta imagem não é 9:16: será cortada em Stories e Reels.
            </p>
          )}
        {currentVideo && <p className="field-hint">{formatBytes(currentVideo.byteSize)}</p>}
        {hasFile && !pending && (
          <p className="field-hint">
            <button type="button" className="link-button" onClick={onClear}>
              Remover arquivo
            </button>
          </p>
        )}
      </div>
    </div>
  );
}

/** A carousel's cards: each with its own image or video, a title and a link. */
export function CarouselCards({
  index,
  control,
  register,
  setValue,
  cards,
  errors,
  format,
  vertical,
  revalidate,
  canPickMedia,
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
  canPickMedia: boolean;
}) {
  const list = useFieldArray({ control, name: `variations.${index}.cards` });
  const cardErrors = errors.variations?.[index]?.cards;
  const options = { shouldDirty: true, shouldValidate: revalidate };

  return (
    <div className="builder-cards">
      <p className="field-hint">
        De {MIN_CAROUSEL_CARDS} a {MAX_CAROUSEL_CARDS} cartões, cada um com a sua imagem ou vídeo,
        título e link. {list.fields.length}/{MAX_CAROUSEL_CARDS}
      </p>
      {list.fields.map((field, cardIndex) => {
        const card = cards[cardIndex];
        const label = `Criativo ${index + 1}, cartão ${cardIndex + 1}`;
        const path = `variations.${index}.cards.${cardIndex}` as const;
        const mediaType = card?.mediaType ?? 'image';
        const mediaError =
          cardErrors?.[cardIndex]?.creativeId?.message ?? cardErrors?.[cardIndex]?.videoId?.message;
        return (
          <div className="builder-card" key={field.id}>
            <div className="builder-variation-head">
              <strong>Cartão {cardIndex + 1}</strong>
              {list.fields.length > MIN_CAROUSEL_CARDS && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => list.remove(cardIndex)}
                >
                  Remover cartão
                </button>
              )}
            </div>
            <MediaDropzone
              label={label}
              accept="any"
              creativeId={mediaType === 'image' ? (card?.creativeId ?? '') : ''}
              videoId={mediaType === 'video' ? (card?.videoId ?? '') : ''}
              format={format}
              vertical={vertical}
              error={mediaError}
              canPickMedia={canPickMedia}
              onImage={(creative) => {
                setValue(`${path}.mediaType`, 'image', options);
                setValue(`${path}.creativeId`, creative.id, options);
                setValue(`${path}.videoId`, undefined, options);
              }}
              onVideo={(video) => {
                setValue(`${path}.mediaType`, 'video', options);
                setValue(`${path}.videoId`, video.id, options);
                setValue(`${path}.creativeId`, undefined, options);
              }}
              onClear={() => {
                setValue(`${path}.creativeId`, undefined, options);
                setValue(`${path}.videoId`, undefined, options);
              }}
            />
            <Field
              label="Título do cartão"
              error={cardErrors?.[cardIndex]?.headline?.message}
              hint={`${(card?.headline ?? '').length}/${HEADLINE_MAX}`}
            >
              <Input maxLength={HEADLINE_MAX} {...register(`${path}.headline`)} />
            </Field>
            <Field
              label="Texto do cartão (opcional)"
              error={cardErrors?.[cardIndex]?.description?.message}
              hint={`${(card?.description ?? '').length}/${CARD_DESCRIPTION_MAX}`}
            >
              <Input maxLength={CARD_DESCRIPTION_MAX} {...register(`${path}.description`)} />
            </Field>
            <Field label="Link do cartão" error={cardErrors?.[cardIndex]?.link?.message}>
              <Input
                type="url"
                placeholder="https://wingscompany.com.br/contato/"
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

/** The cards a carousel opens with: the fewest it may have. */
export function emptyCards(): CardInput[] {
  return Array.from({ length: MIN_CAROUSEL_CARDS }, () => ({
    mediaType: 'image' as const,
    headline: '',
    description: '',
    link: '',
  }));
}

/**
 * One creative, whole: type, file, words and button. With "the same text in
 * all", only the first card shows the words; the others say they follow it.
 */
export function CreativeCard({
  index,
  count,
  variation,
  control,
  register,
  setValue,
  errors,
  format,
  vertical,
  revalidate,
  canPickMedia,
  sameCopy,
  findings,
  onRemove,
  children,
}: {
  index: number;
  count: number;
  variation: VariationInput | undefined;
  control: Control<CampaignDraftInput>;
  register: UseFormRegister<CampaignDraftInput>;
  setValue: UseFormSetValue<CampaignDraftInput>;
  errors: FieldErrors<CampaignDraftInput>;
  format: CreativeFormat | undefined;
  vertical: boolean;
  revalidate: boolean;
  canPickMedia: boolean;
  sameCopy: boolean;
  findings: ComplianceFinding[];
  onRemove: () => void;
  /** Anything the builder wants under the card (a briefing, a note). */
  children?: ReactNode;
}) {
  const creativeType: CreativeType = variation?.creativeType ?? 'image';
  const label = `Criativo ${index + 1}`;
  const options = { shouldDirty: true, shouldValidate: revalidate };
  const showCopy = !sameCopy || index === 0;
  const errorsOf = errors.variations?.[index];

  return (
    <div className="builder-variation builder-creative-card" data-creative={index + 1}>
      <div className="builder-variation-head">
        <strong>{label}</strong>
        {count > 1 && (
          <button type="button" className="link-button" onClick={onRemove}>
            Remover
          </button>
        )}
      </div>

      <div className="builder-segmented" role="group" aria-label={`Tipo de criativo — ${label}`}>
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
                setValue(`variations.${index}.cards`, emptyCards(), options);
              }
            }}
          >
            {CREATIVE_TYPE_LABEL[type]}
          </button>
        ))}
      </div>

      {creativeType === 'image' && (
        <MediaDropzone
          label={label}
          accept="image"
          creativeId={variation?.creativeId ?? ''}
          videoId=""
          format={format}
          vertical={vertical}
          error={errorsOf?.creativeId?.message}
          canPickMedia={canPickMedia}
          onImage={(creative, mediaAssetId) => {
            setValue(`variations.${index}.creativeId`, creative.id, options);
            // A file from the computer is not a library asset.
            setValue(`variations.${index}.mediaAssetId`, mediaAssetId, options);
          }}
          onVideo={() => undefined}
          onClear={() => {
            setValue(`variations.${index}.creativeId`, '', options);
            setValue(`variations.${index}.mediaAssetId`, undefined, options);
          }}
        />
      )}
      {creativeType === 'video' && (
        <MediaDropzone
          label={label}
          accept="video"
          creativeId=""
          videoId={variation?.videoId ?? ''}
          format={format}
          vertical={vertical}
          error={errorsOf?.videoId?.message}
          canPickMedia={canPickMedia}
          onImage={() => undefined}
          onVideo={(video, mediaAssetId) => {
            setValue(`variations.${index}.videoId`, video.id, options);
            setValue(`variations.${index}.mediaAssetId`, mediaAssetId, options);
          }}
          onClear={() => {
            setValue(`variations.${index}.videoId`, undefined, options);
            setValue(`variations.${index}.mediaAssetId`, undefined, options);
          }}
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
          revalidate={revalidate}
          canPickMedia={canPickMedia}
        />
      )}

      {showCopy ? (
        <div className="builder-creative-copy">
          {sameCopy && count > 1 && (
            <p className="field-hint">
              <strong>Texto de todos os criativos</strong> — o que está aqui vale para os {count}{' '}
              criativos.
            </p>
          )}
          <Field
            label="Título"
            error={errorsOf?.headline?.message}
            hint={`${(variation?.headline ?? '').length}/${HEADLINE_MAX}`}
          >
            <Input maxLength={HEADLINE_MAX} {...register(`variations.${index}.headline`)} />
          </Field>
          <Field
            label="Texto"
            error={errorsOf?.primaryText?.message}
            hint={`${(variation?.primaryText ?? '').length} caracteres — a Meta corta perto de ${PRIMARY_TEXT_RECOMMENDED}`}
          >
            <textarea
              className="control"
              rows={3}
              {...register(`variations.${index}.primaryText`)}
            />
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
          <ComplianceWarning findings={findings} />
        </div>
      ) : (
        <p className="field-hint">Título, texto e botão iguais aos do Criativo 1.</p>
      )}
      {children}
    </div>
  );
}
