import {
  INSTAGRAM_FIND_MAX,
  type InstagramFindItem,
  type InstagramFindResponse,
  type ProspectSearchItem,
} from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { failureReason } from '../../lib/failure.js';

/**
 * Prospecção → busca do Google, t086: right after a search answers, the companies with no known
 * Instagram are sent to the API's finder (site, then Meta, then the web), five at a time. What it
 * finds goes into the row as if the search had brought it, so the Meta numbers step (ProspectInstagram)
 * picks the @ up; what it does not find shows "—" and why. The server keeps each answer per company.
 */
export interface InstagramFinds {
  byPlace: Map<string, InstagramFindItem>;
  /** Why the whole request failed (the route answered an error), once. */
  failure: string | null;
}

export function useInstagramFinder(items: ProspectSearchItem[]): InstagramFinds {
  const [byPlace, setByPlace] = useState(() => new Map<string, InstagramFindItem>());
  const [failure, setFailure] = useState<string | null>(null);
  const asked = useRef(new Set<string>());

  useEffect(() => {
    const fresh = items.filter((item) => item.instagramFind && !asked.current.has(item.placeId));
    if (fresh.length === 0) return;
    for (const item of fresh) asked.current.add(item.placeId);
    void (async () => {
      for (let i = 0; i < fresh.length; i += INSTAGRAM_FIND_MAX) {
        const chunk = fresh.slice(i, i + INSTAGRAM_FIND_MAX);
        try {
          const answer = await api.post<InstagramFindResponse>('/prospecting/instagram/find', {
            items: chunk.map((item) => ({ ticket: item.instagramFind })),
          });
          setByPlace((current) => {
            const next = new Map(current);
            for (const entry of answer.items) next.set(entry.placeId, entry);
            return next;
          });
        } catch (error) {
          // A new search tries the ones still without an answer.
          for (const item of chunk) asked.current.delete(item.placeId);
          setFailure(failureReason(error));
          return;
        }
      }
    })();
  }, [items]);

  return { byPlace, failure };
}

/** The search's items with what the finder found put in place of "no Instagram". */
export function withFinds(
  items: ProspectSearchItem[],
  finds: InstagramFinds,
): ProspectSearchItem[] {
  if (finds.byPlace.size === 0 && !finds.failure) return items;
  return items.map((item) => {
    const found = finds.byPlace.get(item.placeId);
    // A failed request is "—" and the reason, never an eternal "procurando…".
    if (!found && finds.failure && item.instagramFind)
      return {
        ...item,
        instagramFind: null,
        instagramMiss: { reasons: [`a busca do Instagram falhou: ${finds.failure}`], at: '' },
      };
    if (!found || item.instagram) return item;
    return { ...item, instagram: found.instagram, instagramMiss: found.miss, instagramFind: null };
  });
}
