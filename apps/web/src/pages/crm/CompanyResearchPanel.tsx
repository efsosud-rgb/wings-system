import { WEB_RESEARCH_FIELD_LABELS, type Lead, type WebResearchSource } from '@wings/shared';
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

/**
 * "Pesquisa da empresa" (docs/leads/pesquisa-da-empresa.md): what the web
 * search found about the lead's COMPANY when the lead arrived, with the pages
 * it came from and the date. What the search did not bring is "—" with the
 * reason; nothing is filled in. It says plainly that it is an automatic
 * summary, so a person checks the sources before relying on it.
 */
export function CompanyResearchPanel({ research }: { research: Lead['research'] }) {
  const web = research.facts?.webResearch ?? null;
  if (!web) return null;
  const done = web.status === 'done';
  return (
    <section className="crm-panel" aria-label="Pesquisa da empresa">
      <h2>Pesquisa da empresa</h2>
      {done ? (
        <>
          <dl className="crm-kv crm-checks">
            {web.fields.map((field) => (
              <div key={field.key} style={{ display: 'contents' }}>
                <dt>{WEB_RESEARCH_FIELD_LABELS[field.key]}</dt>
                <dd>
                  {field.value ? (
                    <span className="crm-field-value">{field.value}</span>
                  ) : (
                    <>
                      <span role="img" aria-label="sem dado">
                        —
                      </span>
                      {field.reason ? (
                        <span className="crm-sub crm-check-reason">{field.reason}</span>
                      ) : null}
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {web.sources.length > 0 ? (
            <>
              <h3 className="crm-sub">Fontes</h3>
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
              ? 'Resumo automático por IA, só do que as páginas acima dizem; confira nas fontes antes de usar.'
              : 'A busca não trouxe páginas para confirmar; nada foi guardado.'}
          </p>
        </>
      ) : (
        <p className="crm-sub">
          — {web.reason ?? 'A pesquisa não rodou.'} ({formatDateTime(web.at)})
        </p>
      )}
    </section>
  );
}
