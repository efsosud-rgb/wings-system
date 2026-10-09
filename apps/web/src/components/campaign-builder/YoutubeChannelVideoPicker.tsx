import type { YoutubeChannelResponse } from '@wings/shared';
import { useYoutubeChannel } from '../../api/youtube.js';
import { DASH, formatDateFull, formatInt } from '../dashboard/format.js';
import { formatDuration } from '../dashboard/YoutubeChannelSection.js';
import { Button } from '../ui.js';

/**
 * The channel's public videos to choose from, instead of pasting a link: the
 * same list the Canais próprios block reads (the daily YouTube reading), most
 * viewed first. Picking one hands its id to the form; the form stays the one
 * place that holds the campaign's videos, so the server's checks are the same
 * whether a video was picked here or pasted.
 *
 * Self-contained on purpose: the Demand Gen builder plugs it next to its
 * video boxes (`selected` = the ids in the boxes, `onPick` fills the first
 * empty one), and nothing here depends on that form.
 */

const GAP_TEXT: Record<NonNullable<YoutubeChannelResponse['gap']>, string> = {
  no_key:
    'A leitura do canal não está configurada neste ambiente (falta a chave da YouTube Data API).',
  no_channel:
    'O canal da Wings não está configurado (ficha da Wings Company ou YOUTUBE_CHANNEL_ID).',
  bad_link: 'O link do YouTube na ficha da Wings Company não aponta para um canal.',
  never_ran: 'O canal ainda não foi lido; a lista aparece depois da primeira leitura diária.',
};

export function YoutubeChannelVideoPicker({
  selected,
  max,
  onPick,
}: {
  /** Video ids already in the form. */
  selected: readonly string[];
  /** How many videos the form takes. */
  max: number;
  onPick: (videoId: string) => void;
}) {
  const query = useYoutubeChannel();
  const full = selected.length >= max;

  return (
    <div className="builder-fieldset" role="group" aria-labelledby="youtube-picker-title">
      <h4 id="youtube-picker-title">Vídeos do canal</h4>
      {query.isError ? (
        <p className="muted">Não foi possível carregar os vídeos do canal; cole o link do vídeo.</p>
      ) : !query.data ? (
        <p className="muted">Carregando…</p>
      ) : query.data.videos.length === 0 ? (
        <p className="muted">
          {query.data.gap
            ? `${DASH} ${GAP_TEXT[query.data.gap]} Cole o link do vídeo.`
            : 'Nenhum vídeo público no canal na última leitura. Cole o link do vídeo.'}
        </p>
      ) : (
        <>
          <p className="muted">
            Vídeos públicos do canal, da última leitura diária, do mais visto ao menos visto. Um
            vídeo não listado entra colando o link.
          </p>
          <ul className="youtube-picker">
            {query.data.videos.map((video) => {
              const chosen = selected.includes(video.id);
              return (
                <li key={video.id}>
                  <span className="youtube-video">
                    {video.thumbnailUrl && (
                      <img src={video.thumbnailUrl} alt="" width={96} height={54} loading="lazy" />
                    )}
                    <span>
                      <strong>{video.title}</strong>
                      <br />
                      <small className="muted">
                        {[
                          video.isShort === null ? null : video.isShort ? 'Short' : 'Vídeo',
                          formatDuration(video.durationSeconds),
                          `${formatInt(video.views)} visualizações`,
                          formatDateFull(video.publishedAt),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={chosen || full}
                    title={full && !chosen ? `Já há ${max} vídeos no anúncio` : undefined}
                    onClick={() => onPick(video.id)}
                    aria-label={chosen ? `${video.title}: já escolhido` : `Usar ${video.title}`}
                  >
                    {chosen ? 'Escolhido' : 'Usar este vídeo'}
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
