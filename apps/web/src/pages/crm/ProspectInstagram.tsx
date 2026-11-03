import {
  INSTAGRAM_DISCOVERY_MAX,
  instagramMetricsOf,
  withInstagram,
  type IcpScore,
  type IcpWeights,
  type InstagramDiscoveryItem,
  type InstagramDiscoveryResponse,
  type ProspectSearchItem,
} from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { failureReason } from '../../lib/failure.js';

/**
 * Prospecção → busca do Google, coluna Instagram (docs/prospeccao/instagram.md §1.3, §6): after the
 * search answers, the companies with a known Instagram are sent to Business Discovery, 20 at a
 * time, and the numbers enter the 0-100 score. What Meta did not give is "—" and the reason.
 */

export interface InstagramNumbers {
  byUsername: Map<string, InstagramDiscoveryItem>;
  /** Why the whole lookup failed (the route answered an error), once. */
  failure: string | null;
  holdUntil: string | null;
}

/**
 * Asks once per @ of the answer; a new search asks for the new ones and again for those that came
 * back without numbers (Meta's hold, the day's limit, an error): the server answers them from its
 * cache, or without calling Meta while the hold lasts.
 */
export function useInstagramNumbers(
  items: ProspectSearchItem[],
  enabled: boolean,
): InstagramNumbers {
  const [byUsername, setByUsername] = useState(() => new Map<string, InstagramDiscoveryItem>());
  const [failure, setFailure] = useState<string | null>(null);
  const [holdUntil, setHoldUntil] = useState<string | null>(null);
  const asked = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;
    const refs = items
      .map((item) => item.instagram)
      .filter((ref): ref is NonNullable<typeof ref> => ref !== null)
      .filter((ref) => !asked.current.has(ref.username));
    const fresh = [...new Map(refs.map((ref) => [ref.username, ref])).values()];
    if (fresh.length === 0) return;
    for (const ref of fresh) asked.current.add(ref.username);
    // The old reason is not shown as the answer to this search: "lendo…" until it comes.
    setByUsername((current) => {
      const next = new Map(current);
      for (const ref of fresh) next.delete(ref.username);
      return next;
    });
    void (async () => {
      for (let i = 0; i < fresh.length; i += INSTAGRAM_DISCOVERY_MAX) {
        const chunk = fresh.slice(i, i + INSTAGRAM_DISCOVERY_MAX);
        try {
          const answer = await api.post<InstagramDiscoveryResponse>(
            '/prospecting/instagram/discovery',
            { items: chunk.map(({ username, ticket }) => ({ username, ticket })) },
          );
          for (const entry of answer.items)
            if (!entry.snapshot) asked.current.delete(entry.username);
          setByUsername((current) => {
            const next = new Map(current);
            for (const entry of answer.items) next.set(entry.username, entry);
            return next;
          });
          setHoldUntil(answer.holdUntil);
        } catch (error) {
          // Not asked again by this answer: a new search tries the ones still without numbers.
          for (const ref of chunk) asked.current.delete(ref.username);
          setFailure(failureReason(error));
          return;
        }
      }
    })();
  }, [items, enabled]);

  return { byUsername, failure, holdUntil };
}

const number = (value: number) => value.toLocaleString('pt-BR');
const average = (milli: number) =>
  (milli / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const day = (iso: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(iso));
export const hourOf = (iso: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

/** The score with the Instagram part, when its numbers and the weights are here. */
export function scoreWithInstagram(
  item: ProspectSearchItem,
  numbers: InstagramNumbers,
  weights: IcpWeights | undefined,
): IcpScore {
  const entry = item.instagram ? numbers.byUsername.get(item.instagram.username) : undefined;
  return weights ? withInstagram(item.icp, weights, instagramMetricsOf(entry?.snapshot)) : item.icp;
}

/** The score's detail: each criterion that counted, those left out for lack of data, the date. */
export function scoreDetail(score: IcpScore, readAt: string | null): string {
  return [
    ...(score.reasons.length ? score.reasons : ['Nenhum critério contou']),
    ...score.noData.map((label) => `${label}: — sem dado (fora da conta)`),
    `${score.earned} de ${score.possible} pontos`,
    ...(readAt ? [`Instagram: Meta, lido em ${day(readAt)}`] : []),
  ].join('\n');
}

export function InstagramCell({
  item,
  numbers,
  enabled,
}: {
  item: ProspectSearchItem;
  numbers: InstagramNumbers;
  enabled: boolean | undefined;
}) {
  const ref = item.instagram;
  if (!ref) return <span className="crm-sub">— sem Instagram conhecido</span>;
  const entry = numbers.byUsername.get(ref.username);
  const snapshot = entry?.snapshot;
  const why = !enabled ? 'consulta ao Instagram desligada' : entry ? entry.reason : numbers.failure;
  return (
    <>
      <a
        href={`https://www.instagram.com/${ref.username}/`}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        @{ref.username}
      </a>
      <div className="crm-sub">{ref.source}</div>
      {snapshot?.status === 'encontrada' ? (
        <div className="crm-sub">
          {snapshot.followers === null ? '—' : number(snapshot.followers)} seguidores ·{' '}
          {snapshot.posts === null ? '—' : number(snapshot.posts)} posts
          <br />
          média dos {snapshot.recentMediaRead ?? '—'} recentes:{' '}
          {snapshot.avgLikesMilli === null
            ? '— curtidas (ocultas ou sem dado)'
            : `${average(snapshot.avgLikesMilli)} curtidas`}{' '}
          ·{' '}
          {snapshot.avgCommentsMilli === null
            ? '— comentários'
            : `${average(snapshot.avgCommentsMilli)} comentários`}
          <br />
          Meta, lido em {day(snapshot.fetchedAt)}
        </div>
      ) : why ? (
        <div className="crm-sub">— {why}</div>
      ) : (
        <div className="crm-sub">lendo…</div>
      )}
    </>
  );
}
