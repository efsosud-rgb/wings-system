/**
 * Company sectors. Formatação is a parent sector with six sub-sectors;
 * everything else is flat. Slugs are stable identifiers used in the database
 * and in permission rules, so they must not be renamed casually.
 */
export const SECTORS = {
  diretoria: { name: 'Diretoria', parent: null },
  marketing: { name: 'Marketing', parent: null },
  comercial: { name: 'Comercial', parent: null },
  formatacao: { name: 'Formatação', parent: null },
  'formatacao-juridico': { name: 'Jurídico', parent: 'formatacao' },
  'formatacao-financeiro': { name: 'Financeiro', parent: 'formatacao' },
  'formatacao-processos-projetos': { name: 'Processos e Projetos', parent: 'formatacao' },
  'formatacao-contabil-tributario': { name: 'Contábil/Tributário', parent: 'formatacao' },
  'formatacao-logistica': { name: 'Logística', parent: 'formatacao' },
  'formatacao-ti': { name: 'TI', parent: 'formatacao' },
} as const satisfies Record<string, { name: string; parent: string | null }>;

export type SectorSlug = keyof typeof SECTORS;

export const SECTOR_SLUGS = Object.keys(SECTORS) as SectorSlug[];

/** The TI sector, which Diretoria is fully blocked from (see policy.ts). */
export const TI_SECTOR: SectorSlug = 'formatacao-ti';

export function isSectorSlug(value: string): value is SectorSlug {
  return value in SECTORS;
}

/** All ancestors of a sector, closest first. */
export function sectorAncestors(slug: SectorSlug): SectorSlug[] {
  const chain: SectorSlug[] = [];
  let current = SECTORS[slug].parent as SectorSlug | null;
  while (current) {
    chain.push(current);
    current = SECTORS[current].parent as SectorSlug | null;
  }
  return chain;
}

/**
 * True when `slug` is `ancestor` itself or sits below it in the sector tree.
 * A manager of Formatação therefore covers all six sub-sectors.
 */
export function isWithinSector(slug: SectorSlug, ancestor: SectorSlug): boolean {
  return slug === ancestor || sectorAncestors(slug).includes(ancestor);
}
