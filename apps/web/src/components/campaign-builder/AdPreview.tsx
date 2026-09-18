import { CALL_TO_ACTION_LABEL, type CallToAction, type CreativeFormat } from '@wings/shared';
import { useState } from 'react';

/**
 * An approximate rendering of the ad, drawn by us.
 *
 * NOT Meta's preview: that API needs the Facebook page id and the image inside
 * Meta (a write), and has not been validated against the live account. This is
 * here so the operator and the approver see image, copy and button together,
 * cropped the way each placement crops — and it says on screen what it is.
 */

export function creativeUrl(creativeId: string): string {
  return `/api/ads/creatives/${creativeId}`;
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

export interface PreviewVariation {
  creativeId: string | null | undefined;
  headline: string;
  primaryText: string;
  callToAction: CallToAction;
}

interface AdPreviewProps extends PreviewVariation {
  label: string;
  destinationUrl: string;
  format: CreativeFormat | undefined;
  placement: PreviewPlacement;
}

function AdPreview({
  label,
  creativeId,
  headline,
  primaryText,
  callToAction,
  destinationUrl,
  format,
  placement,
}: AdPreviewProps) {
  const story = placement === 'story';
  const image = creativeId ? (
    <img src={creativeUrl(creativeId)} alt={`Criativo — ${label}`} />
  ) : (
    <span className="muted">Sem criativo</span>
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
        <div className="ad-preview-media" style={{ aspectRatio: mediaRatio(placement, format) }}>
          {image}
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
        e corte. Não é a prévia oficial da Meta — essa integração ainda depende de validação na
        conta real.
      </p>
    </div>
  );
}
