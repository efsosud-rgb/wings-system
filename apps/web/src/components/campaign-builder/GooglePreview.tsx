import { parseYoutubeVideoRef, youtubeThumbnailUrl } from '@wings/shared';

/**
 * Approximate renderings of the two Google ads, drawn by us.
 *
 * NOT Google's preview. Nothing here asks Google for anything: the YouTube
 * still is a public image addressed by the video id, and the search ad is laid
 * out the way Google lays out a text ad. Like the Meta preview, it is here so
 * the operator and the approver see the same thing, and it says what it is.
 */

function addressOf(url: string): { host: string; path: string } {
  const match = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url.trim());
  if (!match) return { host: 'seusite.com.br', path: '' };
  return {
    host: (match[1] ?? '').replace(/^www\./, ''),
    path: (match[2] ?? '').replace(/\/$/, ''),
  };
}

function ApproximateNote() {
  return (
    <p className="field-hint">
      Prévia <strong>aproximada</strong>, desenhada pelo Wings System para conferir o que foi
      digitado. Não é a prévia oficial do Google.
    </p>
  );
}

export function YoutubePreview({
  videoUrl,
  headline,
  businessName,
  destinationUrl,
}: {
  /** A link or the bare id. */
  videoUrl: string;
  headline: string;
  businessName?: string;
  destinationUrl: string;
}) {
  const videoId = parseYoutubeVideoRef(videoUrl);

  if (!videoId) {
    return (
      <div className="ad-preview-gallery">
        <p className="google-preview-empty muted">Cole um link do YouTube para ver a prévia</p>
      </div>
    );
  }

  return (
    <div className="ad-preview-gallery">
      <figure className="ad-preview">
        <figcaption className="field-label">Vídeo no YouTube</figcaption>
        <div className="ad-preview-card">
          <div className="ad-preview-media youtube-preview-media">
            <img src={youtubeThumbnailUrl(videoId)} alt="Miniatura do vídeo no YouTube" />
            <span className="youtube-preview-play" aria-hidden="true">
              ▶
            </span>
          </div>
          <div className="ad-preview-footer">
            <span>
              <strong>{headline || 'Título do anúncio'}</strong>
              <small className="muted">
                Patrocinado · {businessName?.trim() || addressOf(destinationUrl).host}
              </small>
            </span>
          </div>
        </div>
      </figure>
      <ApproximateNote />
    </div>
  );
}

export function SearchAdPreview({
  headlines,
  descriptions,
  destinationUrl,
}: {
  headlines: string[];
  descriptions: string[];
  destinationUrl: string;
}) {
  const { host, path } = addressOf(destinationUrl);
  // Google shows the domain and the first couple of path segments as crumbs.
  const crumbs = path.split('/').filter(Boolean).slice(0, 2);
  // Google shows up to 3 headlines and 2 descriptions of a responsive search
  // ad at a time; the rest rotate. The preview shows the first of each.
  const title = headlines
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
  const body = descriptions
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 2);

  return (
    <div className="ad-preview-gallery">
      <figure className="ad-preview">
        <figcaption className="field-label">Anúncio na Pesquisa do Google</figcaption>
        <div className="ad-preview-card search-preview">
          <strong className="search-preview-sponsored">Patrocinado</strong>
          <div className="ad-preview-page search-preview-site">
            <span className="ad-preview-avatar" aria-hidden="true">
              W
            </span>
            <span>
              <span>Wings</span>
              <small className="muted">{[host, ...crumbs].join(' › ')}</small>
            </span>
          </div>
          <p className="search-preview-headline">
            {title.length > 0 ? title.join(' | ') : 'Título do anúncio'}
          </p>
          <p className="search-preview-description">
            {body.length > 0 ? body.join(' ') : 'Descrição do anúncio'}
          </p>
        </div>
      </figure>
      <ApproximateNote />
    </div>
  );
}
