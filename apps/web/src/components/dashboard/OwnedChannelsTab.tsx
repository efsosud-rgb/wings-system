import type { DashboardWindow } from '@wings/shared';
import { useOwnedChannels } from '../../api/dashboard.js';
import { downloadCsv, toCsv } from '../../lib/csv.js';
import { LoadFailure } from '../LoadFailure.js';
import { Button } from '../ui.js';
import { formatDateFull, since } from './format.js';
import { YoutubeChannelSection } from './YoutubeChannelSection.js';

/**
 * Canais próprios: what Wings published on its own channels in the period,
 * read from the mirror the ingest job keeps. Opening the tab calls no site.
 * The blog is the first channel and YouTube the second (its own section,
 * from the daily YouTube reading); social publishing arrives in the same
 * shape, so its place is already here.
 */

export function OwnedChannelsTab({ days }: { days: DashboardWindow }) {
  const query = useOwnedChannels(days);

  if (query.isError && !query.data) {
    return (
      <LoadFailure
        what="os canais próprios"
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (!query.data) return <p className="muted">Carregando…</p>;
  const { blog } = query.data;

  const exportCsv = () => {
    const header = ['Título', 'Data', 'Categorias', 'Link'];
    downloadCsv(
      `blog-${query.data.since}-a-${query.data.until}.csv`,
      toCsv(
        header,
        blog.posts.map((post) => [
          post.title,
          formatDateFull(post.publishedAt),
          post.categories.join(', '),
          post.link,
        ]),
      ),
    );
  };

  return (
    <>
      {query.isError && (
        <LoadFailure
          what="os canais próprios"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      <section className="dash-section" aria-labelledby="blog-title">
        <div className="dash-toolbar">
          <div>
            <h2 id="blog-title">Blog</h2>
            <p className="muted">
              {!blog.configured
                ? 'A integração com o WordPress não está configurada neste ambiente: sem credenciais, nada é espelhado.'
                : blog.syncedAt
                  ? `Espelho do site atualizado ${since(blog.syncedAt)} pela ingestão.`
                  : 'O site ainda não foi espelhado: os posts aparecem depois da próxima ingestão.'}
            </p>
          </div>
          {blog.posts.length > 0 && (
            <Button variant="ghost" onClick={exportCsv}>
              Exportar CSV
            </Button>
          )}
        </div>

        {blog.posts.length === 0 ? (
          <p className="muted">
            {blog.mirrored > 0
              ? `Nenhum post publicado nos últimos ${days} dias. O espelho tem ${blog.mirrored} ${blog.mirrored === 1 ? 'post' : 'posts'} em outros períodos.`
              : blog.configured
                ? 'Nenhum post no espelho ainda.'
                : ''}
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Título</th>
                  <th scope="col">Data</th>
                  <th scope="col">Categorias</th>
                </tr>
              </thead>
              <tbody>
                {blog.posts.map((post) => (
                  <tr key={post.id}>
                    <td>
                      <a href={post.link} target="_blank" rel="noopener noreferrer">
                        {post.title}
                      </a>
                    </td>
                    <td className="mono">{formatDateFull(post.publishedAt)}</td>
                    <td>
                      {post.categories.length > 0 ? (
                        post.categories.join(', ')
                      ) : (
                        <span className="muted">sem categoria</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <YoutubeChannelSection />

      <section className="dash-section owned-placeholder" aria-labelledby="social-title">
        <h2 id="social-title">Publicação social</h2>
        <p className="muted">
          Chega na próxima onda; os posts sociais aparecem aqui no mesmo formato.
        </p>
      </section>
    </>
  );
}
