import { CALL_TO_ACTION_LABEL, type CallToAction, type CreativeFormat } from '@wings/shared';

/**
 * An approximate rendering of the ad, drawn by us.
 *
 * NOT Meta's preview: that API needs the Facebook page id and the image inside
 * Meta (a write), and has not been validated against the live account. This is
 * here so the operator and the approver see image, copy and button together,
 * cropped to the chosen format — and it says on screen what it is.
 */

export function creativeUrl(creativeId: string): string {
  return `/api/ads/creatives/${creativeId}`;
}

function hostOf(url: string): string {
  return /^https?:\/\/([^/?#]+)/i.exec(url)?.[1]?.replace(/^www\./, '') ?? 'seusite.com.br';
}

export interface AdPreviewProps {
  label: string;
  creativeId: string | null | undefined;
  headline: string;
  primaryText: string;
  callToAction: CallToAction;
  destinationUrl: string;
  format: CreativeFormat | undefined;
}

export function AdPreview({
  label,
  creativeId,
  headline,
  primaryText,
  callToAction,
  destinationUrl,
  format,
}: AdPreviewProps) {
  const story = format?.key === 'stories_reels';
  const ratio = format ? `${format.width} / ${format.height}` : '1 / 1';

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
        <div className="ad-preview-media" style={{ aspectRatio: ratio }}>
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

export function ApproximatePreviewNote() {
  return (
    <p className="field-hint">
      Prévia <strong>aproximada</strong>, desenhada pelo Wings System para conferir imagem, texto e
      corte. Não é a prévia oficial da Meta — essa integração ainda depende de validação na conta
      real.
    </p>
  );
}
