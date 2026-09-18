import { z } from 'zod';

/**
 * Contract for publishing to Wings' own site from the studio.
 *
 * The studio only ever creates a **draft** blog post. Going live is a person
 * pressing "Publicar" inside WordPress, so nothing written here can appear on
 * the public site by itself, and nothing that already exists there is edited.
 *
 * The body is plain text, one paragraph per blank-line-separated block. The
 * server turns it into escaped HTML; the operator cannot send markup.
 */

export const SITE_POST_TITLE_MAX = 120;
export const SITE_POST_EXCERPT_MAX = 300;
export const SITE_POST_CONTENT_MIN = 50;
export const SITE_POST_CONTENT_MAX = 20_000;

export const sitePostSchema = z.object({
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
});
export type SitePostInput = z.output<typeof sitePostSchema>;

export const SITE_POST_OUTCOMES = ['draft_created', 'failed', 'unknown'] as const;
export type SitePostOutcome = (typeof SITE_POST_OUTCOMES)[number];

export const SITE_POST_OUTCOME_LABEL: Record<SitePostOutcome, string> = {
  draft_created: 'Rascunho criado no WordPress',
  failed: 'O WordPress recusou',
  unknown: 'Sem confirmação — confira no WordPress',
};

export interface SitePostRecord {
  id: string;
  title: string;
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
