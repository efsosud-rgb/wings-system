import {
  YOUTUBE_GROWTH_WINDOWS,
  YOUTUBE_INGEST_ERROR_LABEL,
  type YoutubeChannelResponse,
  type YoutubeGrowth,
  type YoutubeVideoSummary,
} from '@wings/shared';
import { useYoutubeChannel } from '../../api/youtube.js';
import { LoadFailure } from '../LoadFailure.js';
import { Alert } from '../ui.js';
import { DASH, formatDateFull, formatDateTime, formatDayShort, formatInt } from './format.js';

/**
 * Canais próprios → YouTube: the channel's public videos by views, from the
 * tables the daily ingestion keeps (YouTube Data API). Nothing is estimated:
 * a growth figure is the newest reading minus the reading of exactly 7 or 30
 * days before, and when that reading does not exist the cell says "—" and why.
 */

const GAP_TEXT: Record<NonNullable<YoutubeChannelResponse['gap']>, string> = {
  no_key:
    'A chave da YouTube Data API não está configurada neste ambiente (YOUTUBE_API_KEY): nada é lido do YouTube.',
  no_channel:
    'O canal não está configurado: preencha o link do YouTube na ficha da Wings Company (Formatação → Clientes → redes sociais) ou a variável YOUTUBE_CHANNEL_ID.',
  bad_link:
    'O link do YouTube na ficha da Wings Company não aponta para um canal: use o endereço youtube.com/@nome ou youtube.com/channel/UC…',
  never_ran: 'A primeira leitura do canal ainda não rodou.',
};

/** 75 → "1:15"; 3723 → "1:02:03". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return DASH;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function GrowthCell({ growth }: { growth: YoutubeGrowth }) {
  if (growth.value !== null) {
    return (
      <td className="num mono">{`${growth.value > 0 ? '+' : ''}${formatInt(growth.value)}`}</td>
    );
  }
  const reason =
    growth.gap === 'history_short'
      ? `histórico começa depois de ${formatDayShort(growth.fromDay)}`
      : `sem leitura em ${formatDayShort(growth.fromDay)}`;
  return (
    <td className="num">
      <span aria-hidden="true">{DASH}</span>
      <small className="muted youtube-gap"> {reason}</small>
    </td>
  );
}

const shortLabel = (video: YoutubeVideoSummary) =>
  video.isShort === null ? DASH : video.isShort ? 'Short' : 'Vídeo';

export function YoutubeChannelSection() {
  const query = useYoutubeChannel();

  if (query.isError && !query.data) {
    return (
      <section className="dash-section" aria-labelledby="youtube-title">
        <h2 id="youtube-title">YouTube</h2>
        <LoadFailure
          what="o canal do YouTube"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      </section>
    );
  }
  if (!query.data) {
    return (
      <section className="dash-section" aria-labelledby="youtube-title">
        <h2 id="youtube-title">YouTube</h2>
        <p className="muted">Carregando…</p>
      </section>
    );
  }
  const data = query.data;
  const failed = data.lastRun?.status === 'failed' ? data.lastRun : null;

  return (
    <section className="dash-section" aria-labelledby="youtube-title">
      <div className="dash-toolbar">
        <div>
          <h2 id="youtube-title">YouTube</h2>
          <p className="muted">
            {data.channel
              ? `${data.channel.title ?? data.channel.id} · ${data.configured.source === 'env' ? 'canal pela variável YOUTUBE_CHANNEL_ID' : 'canal pela ficha da Wings Company'} · leitura diária dos dados públicos pela YouTube Data API`
              : 'Leitura diária dos dados públicos do canal pela YouTube Data API.'}
            {data.nextRunAt ? ` Próxima leitura ${formatDateTime(data.nextRunAt)}.` : ''}
          </p>
        </div>
      </div>

      {query.isError && (
        <LoadFailure
          what="o canal do YouTube"
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      )}
      {data.gap && (
        <p className="muted" role="status">
          {DASH} {GAP_TEXT[data.gap]}
        </p>
      )}
      {failed && (
        <Alert kind="warning">
          {`A leitura de ${formatDateTime(failed.startedAt)} falhou: ${
            YOUTUBE_INGEST_ERROR_LABEL[failed.error ?? ''] ?? failed.error ?? 'motivo desconhecido'
          }.`}
          {data.history
            ? ` Os números abaixo são da leitura de ${formatDayShort(data.history.lastDay)}.`
            : ''}
        </Alert>
      )}

      {data.history && (
        <p className="muted">
          {`Histórico de ${formatDayShort(data.history.firstDay)} a ${formatDayShort(data.history.lastDay)} (${data.history.days} ${data.history.days === 1 ? 'dia lido' : 'dias lidos'}). O crescimento compara a última leitura com a de exatamente 7 e 30 dias antes.`}
        </p>
      )}

      {data.videos.length === 0 ? (
        data.history && <p className="muted">Nenhum vídeo público no canal na última leitura.</p>
      ) : (
        <div className="table-wrap">
          <table className="table youtube-table">
            <thead>
              <tr>
                <th scope="col">Vídeo</th>
                <th scope="col">Publicado</th>
                <th scope="col">Duração</th>
                <th scope="col">Formato</th>
                <th scope="col" className="num">
                  Visualizações
                </th>
                {YOUTUBE_GROWTH_WINDOWS.map((days) => (
                  <th key={days} scope="col" className="num">
                    {`+${days} dias`}
                  </th>
                ))}
                <th scope="col" className="num">
                  Curtidas
                </th>
                <th scope="col" className="num">
                  Comentários
                </th>
              </tr>
            </thead>
            <tbody>
              {data.videos.map((video) => (
                <tr key={video.id}>
                  <td>
                    <span className="youtube-video">
                      {video.thumbnailUrl && (
                        <img
                          src={video.thumbnailUrl}
                          alt=""
                          width={96}
                          height={54}
                          loading="lazy"
                        />
                      )}
                      <a href={video.link} target="_blank" rel="noopener noreferrer">
                        {video.title}
                      </a>
                    </span>
                  </td>
                  <td className="mono">{formatDateFull(video.publishedAt)}</td>
                  <td className="mono">{formatDuration(video.durationSeconds)}</td>
                  <td>{shortLabel(video)}</td>
                  <td className="num mono">{formatInt(video.views)}</td>
                  {YOUTUBE_GROWTH_WINDOWS.map((days) => (
                    <GrowthCell key={days} growth={video.growth[days]} />
                  ))}
                  <td className="num mono">{formatInt(video.likes)}</td>
                  <td className="num mono">{formatInt(video.comments)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
