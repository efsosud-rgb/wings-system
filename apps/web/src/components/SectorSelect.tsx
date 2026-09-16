import { SECTORS, SECTOR_SLUGS, type SectorSlug } from '@wings/shared';
import type { SelectHTMLAttributes } from 'react';
import { forwardRef } from 'react';

const ROOTS = SECTOR_SLUGS.filter((slug) => SECTORS[slug].parent === null);
const CHILDREN = (parent: SectorSlug) =>
  SECTOR_SLUGS.filter((slug) => SECTORS[slug].parent === parent);

/**
 * Sector dropdown. Formatação's six sub-sectors are grouped under it so the
 * hierarchy is visible while the value stays a plain slug.
 */
export const SectorSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function SectorSelect({ children, ...props }, ref) {
    return (
      <select {...props} ref={ref} className={`control ${props.className ?? ''}`}>
        {children}
        {ROOTS.map((root) => {
          const subs = CHILDREN(root);
          if (subs.length === 0) {
            return (
              <option key={root} value={root}>
                {SECTORS[root].name}
              </option>
            );
          }
          return (
            <optgroup key={root} label={SECTORS[root].name}>
              <option value={root}>{SECTORS[root].name} (geral)</option>
              {subs.map((slug) => (
                <option key={slug} value={slug}>
                  {SECTORS[slug].name}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    );
  },
);
