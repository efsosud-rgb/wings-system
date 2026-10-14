import {
  WEB_RESEARCH_FIELD_LABELS,
  isLegacyWebResearch,
  type Lead,
  type WebResearchField,
  type WebResearchSource,
} from '@wings/shared';
import { useResearchLead } from '../../api/leads.js';
import { failureReason } from '../../lib/failure.js';
import { formatDateTime } from './format.js';

/** Only a public web page gets a link; anything else is shown as text. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The page's own title can say anything (a lead may choose the site), so the host goes with it. */
function sourceLabel(source: WebResearchSource): string {
  const host = hostOf(source.url);
  if (source.title) return host ? `${source.title} — ${host}` : source.title;
  return host || source.url;
}

const NO_FIELD_SOURCE = 'Sem a página que sustenta este dado';

/**
 * The page a value came from, when it is one of the pages the search returned; null otherwise.
 * A value without it (research stored before each value named its page) is not shown.
 */
function backingSource(
  field: WebResearchField,
  sources: WebResearchSource[],
): WebResearchSource | null {
  if (!field.value || !field.sourceUrl || !isWebUrl(field.sourceUrl)) return null;
  return sources.find((source) => source.url === field.sourceUrl) ?? null;
}

/**
 * "Pesquisa da empresa" (docs/leads/pesquisa-da-empresa.md): what the web
 * search found about the lead's COMPANY when the lead arrived, each value with
 * the page it came from, and the date. A value without its page, and what the
 * search did not bring, is "—" with the reason; nothing is filled in. It says
 * plainly that it is an automatic summary, so a person checks the sources
 * before relying on it.
 */
export function CompanyResearchPanel({
  research,
  leadId,
  canWrite = false,
}: {
  research: Lead['research'];
  /** With `canWrite`, lets the person ask for the research again when it is in the old format. */
  leadId?: string;
  canWrite?: boolean;
}) {
  const web = research.facts?.webResearch ?? null;
  if (!web) return null;
  const done = web.status === 'done';
  const legacy = isLegacyWebResearch(web);
  return (
    <section className="crm-panel" aria-label="Pesquisa da empresa">
      <h2>Pesquisa da empresa</h2>
      {done ? (
        <>
          <dl className="crm-kv crm-checks">
            {web.fields.map((field) => {
              const source = backingSource(field, web.sources);
              const reason = field.value ? NO_FIELD_SOURCE : field.reason;
              return (
                <div key={field.key} style={{ display: 'contents' }}>
                  <dt>{WEB_RESEARCH_FIELD_LABELS[field.key]}</dt>
                  <dd>
                    {source ? (
                      <>
                        <span className="crm-field-value">{field.value}</span>{' '}
                        <a
                          className="crm-sub"
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                        >
                          Fonte: {hostOf(source.url) || source.url}
                        </a>
                      </>
                    ) : (
                      <>
                        <span role="img" aria-label="sem dado">
                          —
                        </span>
                        {reason ? <span className="crm-sub crm-check-reason">{reason}</span> : null}
                      </>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          {web.sources.length > 0 ? (
            <>
              <h3 className="crm-sub">Páginas que a busca trouxe</h3>
              <ul className="crm-sources">
                {web.sources.map((source) => (
                  <li key={source.url}>
                    {isWebUrl(source.url) ? (
                      <a href={source.url} target="_blank" rel="noopener noreferrer nofollow">
                        {sourceLabel(source)}
                      </a>
                    ) : (
                      sourceLabel(source)
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="crm-sub">
            Pesquisado em {formatDateTime(web.at)}.{' '}
            {web.sources.length > 0
              ? 'Resumo automático por IA, só do que as páginas dizem; cada dado mostra a página de onde veio. Confira antes de usar.'
              : 'A busca não trouxe páginas para confirmar; nada foi guardado.'}
          </p>
          {legacy ? (
            <RedoResearch
              leadId={canWrite ? leadId : undefined}
              waiting={research.state === 'pending' || research.state === 'running'}
            />
          ) : null}
        </>
      ) : (
        <p className="crm-sub">
          — {web.reason ?? 'A pesquisa não rodou.'} ({formatDateTime(web.at)})
        </p>
      )}
    </section>
  );
}

/**
 * A research stored before each value named its page shows "—" for every value, and the pages it
 * kept do not say which one backs which. Asking again is the only way to get the pages; it is a
 * new paid search (about US$ 0,01) that replaces this one, so it is a click, not automatic.
 */
function RedoResearch({ leadId, waiting }: { leadId: string | undefined; waiting: boolean }) {
  const redo = useResearchLead();
  return (
    <div className="crm-sub" role="group" aria-label="Refazer a pesquisa">
      <p>
        Esta pesquisa é anterior à fonte por dado: as páginas foram guardadas, mas não se sabe qual
        delas sustenta cada valor. Por isso eles aparecem como “—”.
      </p>
      {leadId ? (
        <>
          <button
            type="button"
            className="crm-btn"
            disabled={waiting || redo.isPending || redo.isSuccess}
            onClick={() => redo.mutate(leadId)}
          >
            {waiting || redo.isSuccess
              ? 'Pesquisa na fila…'
              : 'Pesquisar de novo (cerca de US$ 0,01)'}
          </button>{' '}
          <span>Faz uma nova pesquisa paga e troca esta pelo resultado com as fontes.</span>
          {redo.isError ? (
            <p role="alert">Não foi possível pedir a pesquisa: {failureReason(redo.error)}.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
