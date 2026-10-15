// Kept apart from instagram-check.ts so `leads.ts` can read it at load time without a module cycle.

/** The list filter of Negociações. */
export const INSTAGRAM_LIST_FILTERS = ['suspeito', 'falso', 'suspeito_ou_falso'] as const;
export type InstagramListFilter = (typeof INSTAGRAM_LIST_FILTERS)[number];

export const INSTAGRAM_LIST_FILTER_LABELS: Record<InstagramListFilter, string> = {
  suspeito: 'Instagram suspeito',
  falso: 'Instagram falso',
  suspeito_ou_falso: 'Instagram suspeito ou falso',
};
