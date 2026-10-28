import type { PlaceResult } from '@wings/shared';
import { ApiError } from '../../api/client.js';
import { usePlaceDetails } from '../../api/prospecting.js';
import { failureReason } from '../../lib/failure.js';

/**
 * Google Maps data, read live (docs/crm/prospeccao.md). Google's terms let us
 * keep only the place_id, so the name, address, phone, site and rating are
 * shown from the answer and never stored, always with the attribution and the
 * link back to Maps.
 */

const BUSINESS_STATUS: Record<string, string> = {
  OPERATIONAL: 'Em funcionamento',
  CLOSED_TEMPORARILY: 'Fechado temporariamente',
  CLOSED_PERMANENTLY: 'Fechado definitivamente',
};

/** Why a call to Google gave nothing: the API's own words (no key, quota, Google down) when it has them. */
export const googleFailure = (error: unknown): string =>
  error instanceof ApiError && error.body.message ? error.body.message : failureReason(error);

/** Only a web address becomes a link; the rest of Google's text is shown as text. */
export const webUrl = (url: string | null): string | null =>
  url && /^https?:\/\//i.test(url) ? url : null;

export const ratingText = (rating: number | null): string =>
  rating === null
    ? '—'
    : rating.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function MapsLink({ uri }: { uri: string | null }) {
  const href = webUrl(uri);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      Abrir no Google Maps
    </a>
  ) : null;
}

export function PlaceFacts({ place }: { place: PlaceResult }) {
  const site = webUrl(place.website);
  return (
    <>
      <dl className="crm-kv">
        <dt>Nome</dt>
        <dd>{place.name ?? '—'}</dd>
        <dt>Endereço</dt>
        <dd>{place.address ?? '—'}</dd>
        <dt>Telefone</dt>
        <dd>{place.phone ?? '—'}</dd>
        <dt>Site</dt>
        <dd>
          {site ? (
            <a href={site} target="_blank" rel="noopener noreferrer nofollow">
              {site}
            </a>
          ) : (
            '—'
          )}
        </dd>
        <dt>Nota</dt>
        <dd>{ratingText(place.rating)}</dd>
        <dt>Avaliações</dt>
        <dd>{place.reviews ?? '—'}</dd>
        <dt>Situação</dt>
        <dd>
          {place.businessStatus
            ? (BUSINESS_STATUS[place.businessStatus] ?? place.businessStatus)
            : '—'}
        </dd>
      </dl>
      <p className="crm-sub">
        <MapsLink uri={place.mapsUri} /> · Dados: Google Maps
      </p>
    </>
  );
}

/** On the lead card of a prospecting lead: the company on Google, loaded only on a click. */
export function GooglePlacePanel({ leadId }: { leadId: string }) {
  const load = usePlaceDetails('leads');
  const answer = load.data;
  return (
    <section className="crm-panel" aria-label="Dados do Google (ao vivo)">
      <h2>Dados do Google (ao vivo)</h2>
      {answer?.found ? <PlaceFacts place={answer.place} /> : null}
      {answer && !answer.found ? <p className="crm-sub">— {answer.message}</p> : null}
      {load.isError ? (
        <p className="crm-sub" role="alert">
          — {googleFailure(load.error)}
        </p>
      ) : null}
      <div>
        <button
          type="button"
          className="crm-btn is-small"
          disabled={load.isPending}
          title="Cada carga gasta 1 ficha da cota do mês"
          onClick={() => load.mutate(leadId)}
        >
          {load.isPending ? 'Carregando…' : answer ? 'Carregar de novo' : 'Carregar do Google'}
        </button>
      </div>
      <p className="crm-sub">
        Nada daqui é guardado: cada carga consulta o Google na hora e gasta 1 ficha da cota do mês.
      </p>
    </section>
  );
}
