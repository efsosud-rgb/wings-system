import { z } from 'zod';
import { ALT_TEXT_MAX, FOCUS_KEYWORD_MAX } from './seo-checklist.js';
import { MAX_POST_IMAGES, MIN_GALLERY_IMAGES, parseVideoLink } from './site-content.js';

/**
 * Contract for publishing to Wings' own site from the studio.
 *
 * The studio only ever creates a **draft** blog post. Going live is a person
 * pressing "Publicar" inside WordPress, so nothing written here can appear on
 * the public site by itself, and nothing that already exists there is edited.
 *
 * The body is plain text with optional simple Markdown; `site-content.ts` turns
 * it into HTML, escaping everything typed. The operator cannot send markup.
 *
 * Images are uploaded to OUR database first (`SiteImageUpload`), so they can
 * be validated and previewed; they only go to WordPress when the draft is
 * sent, and a post is only created once every one of them has arrived.
 */

export const SITE_POST_TITLE_MAX = 120;
export const SITE_POST_EXCERPT_MAX = 300;
export const SITE_POST_CONTENT_MIN = 50;
export const SITE_POST_CONTENT_MAX = 20_000;

export const SITE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const SITE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** What a featured image needs to look right when the post is shared. */
export const FEATURED_MIN_WIDTH = 1200;
export const FEATURED_MIN_HEIGHT = 630;
export const IMAGE_CAPTION_MAX = 200;

/** What the server says about an image it accepted. Read from the bytes. */
export interface SiteImageUpload {
  id: string;
  mimeType: (typeof SITE_IMAGE_TYPES)[number];
  width: number;
  height: number;
  byteSize: number;
}

export function isBigEnoughToFeature(image: { width: number; height: number }): boolean {
  return image.width >= FEATURED_MIN_WIDTH && image.height >= FEATURED_MIN_HEIGHT;
}

const termIds = z.array(z.number().int().positive()).max(50);

export const sitePostSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(5, 'Dê um título ao post')
      .max(SITE_POST_TITLE_MAX, `Máximo de ${SITE_POST_TITLE_MAX} caracteres`),
    excerpt: z
      .string()
      .trim()
      .max(SITE_POST_EXCERPT_MAX, `Máximo de ${SITE_POST_EXCERPT_MAX} caracteres`),
    content: z
      .string()
      .trim()
      .min(SITE_POST_CONTENT_MIN, `Escreva pelo menos ${SITE_POST_CONTENT_MIN} caracteres`)
      .max(SITE_POST_CONTENT_MAX, `Máximo de ${SITE_POST_CONTENT_MAX} caracteres`),
    /** Ids of categories that exist on the site. At least one. */
    categories: termIds.min(1, 'Escolha pelo menos uma categoria'),
    /** Ids of tags that exist on the site: an Author cannot create terms. */
    tags: termIds.default([]),
    featuredImageId: z.uuid().nullable().default(null),
    /** Sent to WordPress as the image's alt text; the post title when empty. */
    featuredImageAlt: z
      .string()
      .trim()
      .max(ALT_TEXT_MAX, `Máximo de ${ALT_TEXT_MAX} caracteres`)
      .default(''),
    /**
     * What the SEO checklist works from. The site does not accept these over
     * REST (Rank Math exposes no meta), so they are kept on our record for the
     * person who pastes them into WordPress. The limits here are loose on
     * purpose: the checklist advises on length and never blocks a draft.
     */
    seo: z
      .object({
        focusKeyword: z.string().trim().max(FOCUS_KEYWORD_MAX).default(''),
        seoTitle: z.string().trim().max(120).default(''),
        metaDescription: z.string().trim().max(320).default(''),
      })
      .default({ focusKeyword: '', seoTitle: '', metaDescription: '' }),
    /** In form order: `{{img:1}}` is the first. */
    images: z
      .array(
        z.object({
          uploadId: z.uuid(),
          caption: z.string().trim().max(IMAGE_CAPTION_MAX, 'Legenda muito longa').default(''),
        }),
      )
      .max(MAX_POST_IMAGES, `No máximo ${MAX_POST_IMAGES} imagens por post`)
      .default([]),
    /** 1-based positions in `images` that form the gallery. */
    gallery: z.array(z.number().int().positive()).max(MAX_POST_IMAGES).default([]),
    videoUrl: z
      .string()
      .trim()
      .max(200)
      .refine((value) => value === '' || parseVideoLink(value) !== null, {
        message: 'Use um link do YouTube ou do Vimeo',
      })
      .default(''),
  })
  .superRefine((post, ctx) => {
    const positions = new Set(post.gallery);
    if (positions.size !== post.gallery.length) {
      ctx.addIssue({ code: 'custom', path: ['gallery'], message: 'Imagem repetida na galeria' });
    }
    if (post.gallery.some((position) => position > post.images.length)) {
      ctx.addIssue({
        code: 'custom',
        path: ['gallery'],
        message: 'A galeria aponta para uma imagem que não existe',
      });
    }
    if (post.gallery.length > 0 && post.gallery.length < MIN_GALLERY_IMAGES) {
      ctx.addIssue({
        code: 'custom',
        path: ['gallery'],
        message: `A galeria precisa de pelo menos ${MIN_GALLERY_IMAGES} imagens`,
      });
    }
  });
export type SitePostFormInput = z.input<typeof sitePostSchema>;
export type SitePostInput = z.output<typeof sitePostSchema>;

export const SITE_POST_OUTCOMES = ['draft_created', 'failed', 'unknown'] as const;
export type SitePostOutcome = (typeof SITE_POST_OUTCOMES)[number];

export const SITE_POST_OUTCOME_LABEL: Record<SitePostOutcome, string> = {
  draft_created: 'Rascunho criado no WordPress',
  failed: 'Não foi criado',
  unknown: 'O site não confirmou. Confira no WordPress',
};

/** A category or tag as the site has it. Names arrive HTML-decoded. */
export interface SiteTerm {
  id: number;
  name: string;
  /** How many published posts use it. */
  count: number;
}

export interface SiteTerms {
  categories: SiteTerm[];
  tags: SiteTerm[];
  /** When this list was read from the site; it is cached for an hour. */
  fetchedAt: string;
}

export interface SitePostRecord {
  id: string;
  title: string;
  /** Names of the categories it was sent with. */
  categoryNames: string[];
  hasFeaturedImage: boolean;
  /** Images placed in the body, gallery included. */
  imageCount: number;
  /** Typed for the checklist; to be pasted into Rank Math by whoever publishes. */
  seo: { focusKeyword: string; seoTitle: string; metaDescription: string } | null;
  outcome: SitePostOutcome;
  /** Where a person reviews and publishes it; null unless the draft exists. */
  editUrl: string | null;
  createdAt: string;
  createdByName: string | null;
}

export interface SiteStatus {
  /** False when the server has no WordPress credentials: sending returns 503. */
  configured: boolean;
  /** Host only — never the credentials. */
  siteHost: string | null;
}
