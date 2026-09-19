/**
 * Turns what the operator typed into the HTML of a post.
 *
 * One renderer, two targets, so the preview in the studio and the draft that
 * reaches WordPress cannot drift apart:
 *
 *  - `preview`   — plain HTML for the studio, pointing at our own copies of the
 *                  images, with a standard iframe for the video;
 *  - `wordpress` — the same structure in WordPress block markup, pointing at
 *                  the media ids and URLs the site returned.
 *
 * Safe by construction: every character the operator typed is escaped before
 * any tag is added, links are limited to http(s) and mailto, and the only tags
 * that exist in the output are the ones written in this file. The operator
 * cannot send markup, in either target.
 *
 * Plain text keeps working: with no Markdown in it, the text comes out as
 * paragraphs, exactly as before.
 */

export const MAX_POST_IMAGES = 10;
export const MIN_GALLERY_IMAGES = 2;

/** `{{img:3}}`, `{{galeria}}`, `{{video}}` — where media goes in the text. */
const MARKER = /\{\{\s*(img\s*:\s*(\d{1,2})|galeria|video)\s*\}\}/gi;

export function imageMarker(position: number): string {
  return `{{img:${position}}}`;
}
export const GALLERY_MARKER = '{{galeria}}';
export const VIDEO_MARKER = '{{video}}';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Video links
// ---------------------------------------------------------------------------

export interface VideoLink {
  provider: 'youtube' | 'vimeo';
  id: string;
  /** What goes in the post: WordPress turns this line into an embed (oEmbed). */
  canonicalUrl: string;
  /** What the studio preview puts in an iframe. */
  embedUrl: string;
}

/** A YouTube or Vimeo link, or null. Nothing else is embeddable here. */
export function parseVideoLink(url: string): VideoLink | null {
  const trimmed = url.trim();
  const youtube =
    /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/)([A-Za-z0-9_-]{11})(?:[&?#/][^\s]*)?$/i.exec(
      trimmed,
    ) ?? /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[?#][^\s]*)?$/i.exec(trimmed);
  if (youtube?.[1]) {
    return {
      provider: 'youtube',
      id: youtube[1],
      canonicalUrl: `https://www.youtube.com/watch?v=${youtube[1]}`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${youtube[1]}`,
    };
  }
  const vimeo =
    /^https?:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d{6,12})(?:[?#/][^\s]*)?$/i.exec(
      trimmed,
    );
  if (vimeo?.[1]) {
    return {
      provider: 'vimeo',
      id: vimeo[1],
      canonicalUrl: `https://vimeo.com/${vimeo[1]}`,
      embedUrl: `https://player.vimeo.com/video/${vimeo[1]}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline Markdown
// ---------------------------------------------------------------------------

function safeHref(raw: string): string | null {
  const href = raw.trim();
  return /^(https?:\/\/|mailto:)[^\s"'<>]+$/i.test(href) ? href : null;
}

/** Stands in for a finished link while emphasis is applied around it. */
const LINK_SLOT = '\uE000';

/** Bold, italic and links, over text that is escaped here first. */
function inline(text: string): string {
  let html = escapeHtml(text.split(LINK_SLOT).join(''));

  // Links first, so emphasis markers inside a URL are left alone.
  const links: string[] = [];
  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, target: string) => {
    // The target was escaped above. A quote or an angle bracket has no place
    // in a link; an ampersand does, so only that is restored.
    if (/&(quot|lt|gt|#39);/.test(target)) return whole;
    const href = safeHref(target.replace(/&amp;/g, '&'));
    if (!href) return whole;
    links.push(`<a href="${escapeHtml(href)}">${label}</a>`);
    return `${LINK_SLOT}${links.length - 1}${LINK_SLOT}`;
  });

  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>');

  return html.replace(
    new RegExp(`${LINK_SLOT}(\\d+)${LINK_SLOT}`, 'g'),
    (_, index: string) => links[Number(index)] ?? '',
  );
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { kind: 'heading'; level: 2 | 3; html: string }
  | { kind: 'paragraph'; html: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'image'; position: number }
  | { kind: 'gallery' }
  | { kind: 'video' };

/** Splits the text into blocks. Markers always become blocks of their own. */
export function parseContent(text: string): ContentBlock[] {
  const source = text
    .replace(/\r\n?/g, '\n')
    // A marker typed mid-sentence splits the paragraph around it.
    .replace(MARKER, (whole) => `\n\n${whole}\n\n`);

  const blocks: ContentBlock[] = [];
  for (const chunk of source.split(/\n{2,}/)) {
    const lines = chunk
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;

    const only = lines.length === 1 ? (lines[0] ?? '').trim() : '';
    const marker = new RegExp(`^${MARKER.source}$`, 'i').exec(only);
    if (marker) {
      if (marker[2]) blocks.push({ kind: 'image', position: Number(marker[2]) });
      else if (/^galeria$/i.test(marker[1] ?? '')) blocks.push({ kind: 'gallery' });
      else blocks.push({ kind: 'video' });
      continue;
    }

    // A chunk may mix a heading with the paragraph under it; walk its lines.
    let paragraph: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    const flushParagraph = () => {
      if (paragraph.length > 0) {
        blocks.push({ kind: 'paragraph', html: paragraph.map(inline).join('<br />') });
        paragraph = [];
      }
    };
    const flushList = () => {
      if (list) blocks.push({ kind: 'list', ...list });
      list = null;
    };

    for (const line of lines) {
      const heading = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line.trim());
      const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
      const numbered = /^\s*\d{1,3}[.)]\s+(.+)$/.exec(line);

      if (heading?.[2]) {
        flushParagraph();
        flushList();
        // The post title is the page's h1, so "#" and "##" both mean h2.
        blocks.push({
          kind: 'heading',
          level: (heading[1] ?? '').length === 3 ? 3 : 2,
          html: inline(heading[2]),
        });
      } else if (bullet?.[1] || numbered?.[1]) {
        flushParagraph();
        const ordered = !bullet;
        if (list && list.ordered !== ordered) flushList();
        list ??= { ordered, items: [] };
        list.items.push(inline((bullet?.[1] ?? numbered?.[1]) as string));
      } else {
        flushList();
        paragraph.push(line.trim());
      }
    }
    flushParagraph();
    flushList();
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderImage {
  /** Where the browser (preview) or the site (wordpress) loads it from. */
  src: string;
  caption: string;
  /** The alt text; falls back to the caption, then to the post title. */
  alt: string;
  /** WordPress media id. Absent in the preview. */
  mediaId?: number;
}

export interface RenderInput {
  content: string;
  /** In the order of the form: `{{img:1}}` is `images[0]`. */
  images: RenderImage[];
  /** 1-based positions of the images that form the gallery; empty = none. */
  gallery: number[];
  video: VideoLink | null;
}

export interface RenderResult {
  html: string;
  /** Markers that point at nothing, for the form to warn about. */
  problems: string[];
}

function figure(image: RenderImage, target: 'preview' | 'wordpress'): string {
  const caption = image.caption.trim();
  const alt = escapeHtml(image.alt);
  const src = escapeHtml(image.src);
  if (target === 'preview') {
    return `<figure><img src="${src}" alt="${alt}" />${
      caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''
    }</figure>`;
  }
  const id = image.mediaId ?? 0;
  return (
    `<!-- wp:image {"id":${id},"sizeSlug":"large","linkDestination":"none"} -->\n` +
    `<figure class="wp-block-image size-large"><img src="${src}" alt="${alt}" class="wp-image-${id}"/>${
      caption ? `<figcaption class="wp-element-caption">${escapeHtml(caption)}</figcaption>` : ''
    }</figure>\n<!-- /wp:image -->`
  );
}

function galleryHtml(images: RenderImage[], target: 'preview' | 'wordpress'): string {
  if (target === 'preview') {
    return `<div class="post-gallery">${images.map((image) => figure(image, target)).join('')}</div>`;
  }
  return (
    `<!-- wp:gallery {"linkTo":"none"} -->\n` +
    `<figure class="wp-block-gallery has-nested-images columns-default is-cropped">\n` +
    images.map((image) => figure(image, target)).join('\n') +
    `\n</figure>\n<!-- /wp:gallery -->`
  );
}

function videoHtml(video: VideoLink, target: 'preview' | 'wordpress'): string {
  if (target === 'preview') {
    return (
      `<div class="post-video"><iframe src="${escapeHtml(video.embedUrl)}" title="Vídeo" ` +
      `loading="lazy" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`
    );
  }
  // A URL alone on its line: WordPress turns it into the embed (oEmbed).
  return video.canonicalUrl;
}

/**
 * Renders the post. Media with a marker goes where the marker is; media
 * without one goes to the end, in order: loose images, then the gallery, then
 * the video. An image that is only in the gallery is not repeated on its own.
 */
export function renderSitePost(input: RenderInput, target: 'preview' | 'wordpress'): RenderResult {
  const problems: string[] = [];
  const parts: string[] = [];
  const placed = new Set<number>();
  let galleryPlaced = false;
  let videoPlaced = false;

  const galleryImages = input.gallery
    .map((position) => input.images[position - 1])
    .filter((image): image is RenderImage => image !== undefined);
  const hasGallery = galleryImages.length >= MIN_GALLERY_IMAGES;

  for (const block of parseContent(input.content)) {
    switch (block.kind) {
      case 'heading':
        parts.push(`<h${block.level}>${block.html}</h${block.level}>`);
        break;
      case 'paragraph':
        parts.push(`<p>${block.html}</p>`);
        break;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        parts.push(`<${tag}>${block.items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`);
        break;
      }
      case 'image': {
        const image = input.images[block.position - 1];
        if (!image)
          problems.push(`${imageMarker(block.position)} não corresponde a nenhuma imagem.`);
        else if (placed.has(block.position)) {
          problems.push(
            `${imageMarker(block.position)} aparece mais de uma vez; só a primeira vale.`,
          );
        } else {
          placed.add(block.position);
          parts.push(figure(image, target));
        }
        break;
      }
      case 'gallery':
        if (!hasGallery) {
          problems.push(
            `${GALLERY_MARKER} está no texto, mas a galeria precisa de pelo menos ${MIN_GALLERY_IMAGES} imagens.`,
          );
        } else if (!galleryPlaced) {
          galleryPlaced = true;
          parts.push(galleryHtml(galleryImages, target));
        }
        break;
      case 'video':
        if (!input.video) problems.push(`${VIDEO_MARKER} está no texto, mas não há link de vídeo.`);
        else if (!videoPlaced) {
          videoPlaced = true;
          parts.push(videoHtml(input.video, target));
        }
        break;
    }
  }

  const inGallery = new Set(hasGallery ? input.gallery : []);
  input.images.forEach((image, index) => {
    const position = index + 1;
    if (!placed.has(position) && !inGallery.has(position)) parts.push(figure(image, target));
  });
  if (hasGallery && !galleryPlaced) parts.push(galleryHtml(galleryImages, target));
  if (input.video && !videoPlaced) parts.push(videoHtml(input.video, target));

  return { html: parts.join('\n\n'), problems };
}
