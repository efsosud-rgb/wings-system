import {
  CALL_TO_ACTION_LABEL,
  type CallToAction,
  type CreativeFormat,
  type CreativeType,
} from '@wings/shared';
import { useState } from 'react';

/**
 * An approximate rendering of the ad, drawn by us.
 *
 * NOT Meta's preview: that one needs the media inside Meta (a write), so it
 * only exists after the ads were created — the approval page asks for it then.
 * This is here so the operator and the approver see media, copy and button
 * together, cropped the way each placement crops — and it says what it is.
 */

export function creativeUrl(creativeId: string): string {
  return `/api/ads/creatives/${creativeId}`;
}

export function videoUrl(videoId: string): string {
  return `/api/ads/videos/${videoId}`;
}

function hostOf(url: string): string {
  return /^https?:\/\/([^/?#]+)/i.exec(url)?.[1]?.replace(/^www\./, '') ?? 'seusite.com.br';
}

export type PreviewPlacement = 'feed' | 'story';

const PLACEMENT_LABEL: Record<PreviewPlacement, string> = { feed: 'Feed', story: 'Stories' };

/** Stories and Reels are always full screen, whatever the image was made for. */
const STORY_RATIO = '9 / 16';
/** The tallest a feed shows; a stories image placed in the feed is cut to this. */
const FEED_TALLEST_RATIO = '4 / 5';

/** Which placement a format belongs to — where the preview opens. */
export function placementOf(format: CreativeFormat | undefined): PreviewPlacement {
  return format?.key === 'stories_reels' ? 'story' : 'feed';
}

function mediaRatio(placement: PreviewPlacement, format: CreativeFormat | undefined): string {
  if (placement === 'story') return STORY_RATIO;
  if (!format || placementOf(format) === 'story') return FEED_TALLEST_RATIO;
  return `${format.width} / ${format.height}`;
}

export interface PreviewCard {
  mediaType?: 'image' | 'video';
  creativeId?: string | null;
  videoId?: string | null;
  headline: string;
  description: string;
}

export interface PreviewVariation {
  /** Absent on drafts from before video and carousel: those are images. */
  creativeType?: CreativeType;
  creativeId?: string | null;
  videoId?: string | null;
  cards?: PreviewCard[];
  headline: string;
  primaryText: string;
  callToAction: CallToAction;
}

/** An uploaded image or video, or a placeholder saying which one is missing. */
function PreviewMedia({
  mediaType,
  creativeId,
  videoId,
  label,
}: {
  mediaType: 'image' | 'video';
  creativeId?: string | null;
  videoId?: string | null;
  label: string;
}) {
  if (mediaType === 'video') {
    return videoId ? (
      <video
        controls
        muted
        preload="metadata"
        src={videoUrl(videoId)}
        aria-label={`Vídeo — ${label}`}
      />
    ) : (
      <span className="muted">Sem vídeo</span>
    );
  }
  return creativeId ? (
    <img src={creativeUrl(creativeId)} alt={`Criativo — ${label}`} />
  ) : (
    <span className="muted">Sem criativo</span>
  );
}

interface AdPreviewProps extends PreviewVariation {
  label: string;
  destinationUrl: string;
  format: CreativeFormat | undefined;
  placement: PreviewPlacement;
}

function AdPreview({
  label,
  creativeType = 'image',
  creativeId,
  videoId,
  cards = [],
  headline,
  primaryText,
  callToAction,
  destinationUrl,
  format,
  placement,
}: AdPreviewProps) {
  const story = placement === 'story';
  const media =
    creativeType === 'carousel' ? (
      // Cards side by side, scrolled sideways like the real thing.
      <div className="ad-preview-carousel">
        {cards.length === 0 && <span className="muted">Sem cartões</span>}
        {cards.map((card, index) => (
          <div className="ad-preview-carousel-card" key={index}>
            <div className="ad-preview-carousel-media">
              <PreviewMedia
                mediaType={card.mediaType ?? 'image'}
                creativeId={card.creativeId}
                videoId={card.videoId}
                label={`${label}, cartão ${index + 1}`}
              />
            </div>
            <strong>{card.headline || `Título do cartão ${index + 1}`}</strong>
            <small className="muted">{card.description || 'Texto do cartão'}</small>
          </div>
        ))}
      </div>
    ) : (
      <PreviewMedia
        mediaType={creativeType === 'video' ? 'video' : 'image'}
        creativeId={creativeId}
        videoId={videoId}
        label={label}
      />
    );

  return (
    <figure className={`ad-preview ${story ? 'ad-preview-story' : ''}`}>
      <figcaption className="field-label">{label}</figcaption>
      <div className="ad-preview-card">
        <div className="ad-preview-page">
          <span className="ad-preview-avatar" aria-hidden="true">
            W
          </span>
          <span>
            <strong>Wings</strong>
            <small className="muted">Patrocinado</small>
          </span>
        </div>
        {!story && <p className="ad-preview-text">{primaryText || 'Texto do anúncio'}</p>}
        <div
          className="ad-preview-media"
          style={
            // A carousel sets its own height: its cards are squares in a row.
            creativeType === 'carousel' ? undefined : { aspectRatio: mediaRatio(placement, format) }
          }
        >
          {media}
          {story && <p className="ad-preview-text">{primaryText || 'Texto do anúncio'}</p>}
        </div>
        <div className="ad-preview-footer">
          <span>
            <small className="muted">{hostOf(destinationUrl)}</small>
            <strong>{headline || 'Título do anúncio'}</strong>
          </span>
          <span className="ad-preview-cta">{CALL_TO_ACTION_LABEL[callToAction]}</span>
        </div>
      </div>
    </figure>
  );
}

/**
 * Every variation, in one placement at a time.
 *
 * It opens on the placement of the format chosen in section 6 and follows that
 * choice until the operator picks a side; the switch is there to see the same
 * image cut the other way, since Meta may deliver an ad to both.
 */
export function AdPreviewGallery({
  variations,
  destinationUrl,
  format,
}: {
  variations: PreviewVariation[];
  destinationUrl: string;
  format: CreativeFormat | undefined;
}) {
  const chosen = placementOf(format);
  const [picked, setPicked] = useState<PreviewPlacement | null>(null);
  const placement = picked ?? chosen;

  return (
    <div className="ad-preview-gallery">
      <div className="ad-preview-switch" role="group" aria-label="Posicionamento da prévia">
        {(Object.keys(PLACEMENT_LABEL) as PreviewPlacement[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={placement === key}
            className={`ad-preview-switch-option ${placement === key ? 'is-active' : ''}`}
            onClick={() => setPicked(key === chosen ? null : key)}
          >
            {PLACEMENT_LABEL[key]}
          </button>
        ))}
      </div>
      <p className="field-hint">
        {placement === chosen
          ? `Corte do formato escolhido: ${format ? `${format.label} (${format.ratio})` : '—'}.`
          : `Você escolheu ${format?.label ?? '—'} (${format?.ratio ?? '—'}). É assim que a mesma imagem seria cortada em ${PLACEMENT_LABEL[placement]}.`}
      </p>
      <div className="ad-preview-row">
        {variations.map((variation, index) => (
          <AdPreview
            key={index}
            label={`Variação ${index + 1}`}
            {...variation}
            destinationUrl={destinationUrl}
            format={format}
            placement={placement}
          />
        ))}
      </div>
      <p className="field-hint">
        Prévia <strong>aproximada</strong>, desenhada pelo Wings System para conferir imagem, texto
        e corte. Não é a prévia oficial da Meta. A prévia oficial da Meta fica disponível na tela da
        aprovação depois que os anúncios forem criados.
      </p>
    </div>
  );
}
