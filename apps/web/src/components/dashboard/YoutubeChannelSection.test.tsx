import type { YoutubeChannelResponse, YoutubeVideoSummary } from '@wings/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state: { data: YoutubeChannelResponse | undefined; isError: boolean } = {
  data: undefined,
  isError: false,
};

vi.mock('../../api/youtube.js', () => ({
  useYoutubeChannel: () => ({ data: state.data, isError: state.isError }),
}));

const { YoutubeChannelSection, formatDuration } = await import('./YoutubeChannelSection.js');

const video = (overrides: Partial<YoutubeVideoSummary>): YoutubeVideoSummary => ({
  id: 'aaaaaaaaaaa',
  title: 'Institucional Wings',
  publishedAt: '2026-08-01T15:00:00.000Z',
  durationSeconds: 600,
  thumbnailUrl: 'https://i.ytimg.com/vi/aaaaaaaaaaa/mqdefault.jpg',
  isShort: false,
  views: 2000,
  likes: 10,
  comments: 2,
  growth: {
    7: { value: 490, fromDay: '2026-10-02' },
    30: { value: 1000, fromDay: '2026-09-09' },
  },
  link: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  ...overrides,
});

const response = (overrides: Partial<YoutubeChannelResponse> = {}): YoutubeChannelResponse => ({
  configured: { key: true, source: 'client_record' },
  gap: null,
  channel: { id: 'UCabcdefghijklmnopqrstuv', title: 'Wings Company' },
  lastRun: { startedAt: '2026-10-09T10:00:00.000Z', status: 'ok', error: null },
  nextRunAt: '2026-10-10T10:00:00.000Z',
  history: { firstDay: '2026-09-09', lastDay: '2026-10-09', days: 3 },
  videos: [
    video({}),
    video({
      id: 'bbbbbbbbbbb',
      title: 'Short da cafeteria',
      durationSeconds: 30,
      isShort: true,
      views: 300,
      likes: null,
      comments: null,
      growth: {
        7: { value: 300, fromDay: '2026-10-02' },
        30: { value: null, gap: 'history_short', fromDay: '2026-09-09' },
      },
      link: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
    }),
    video({
      id: 'eeeeeeeeeee',
      title: 'Antigo',
      isShort: null,
      views: 100,
      growth: {
        7: { value: null, gap: 'missing_day', fromDay: '2026-10-02' },
        30: { value: -5, fromDay: '2026-09-09' },
      },
      link: 'https://www.youtube.com/watch?v=eeeeeeeeeee',
    }),
  ],
  ...overrides,
});

afterEach(() => {
  cleanup();
  state.data = undefined;
  state.isError = false;
});

describe('Canais próprios → YouTube', () => {
  it('lists the videos in the order given, with the counters and the growth', () => {
    state.data = response();
    render(<YoutubeChannelSection />);
    expect(screen.getByRole('heading', { name: 'YouTube' })).toBeTruthy();
    expect(screen.getByText(/Wings Company · canal pela ficha da Wings Company/)).toBeTruthy();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getByRole('link').textContent)).toEqual([
      'Institucional Wings',
      'Short da cafeteria',
      'Antigo',
    ]);
    const first = within(rows[0]!);
    expect(first.getByRole('link').getAttribute('href')).toBe(
      'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    );
    expect(first.getByText('2.000')).toBeTruthy();
    expect(first.getByText('+490')).toBeTruthy();
    expect(first.getByText('+1.000')).toBeTruthy();
    expect(first.getByText('10:00')).toBeTruthy();
    expect(first.getByText('Vídeo')).toBeTruthy();
    expect(screen.getByText(/Histórico de 09\/09 a 09\/10 \(3 dias lidos\)/)).toBeTruthy();
  });

  it('shows "—" with the reason instead of a guessed growth, Short or count', () => {
    state.data = response();
    render(<YoutubeChannelSection />);
    const rows = screen.getAllByRole('row').slice(1);
    const short = within(rows[1]!);
    expect(short.getByText('Short')).toBeTruthy();
    expect(short.getByText(/histórico começa depois de 09\/09/)).toBeTruthy();
    // Hidden likes and comments are not zero.
    expect(short.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    const old = within(rows[2]!);
    expect(old.getByText(/sem leitura em 02\/10/)).toBeTruthy();
    expect(old.getByText('-5')).toBeTruthy();
    // Short not known.
    expect(old.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('says why there is nothing when the key or the channel is missing', () => {
    state.data = response({
      gap: 'no_key',
      configured: { key: false, source: null },
      channel: null,
      lastRun: null,
      nextRunAt: null,
      history: null,
      videos: [],
    });
    render(<YoutubeChannelSection />);
    expect(screen.getByText(/A chave da YouTube Data API não está configurada/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    cleanup();

    state.data = response({ gap: 'no_channel', channel: null, history: null, videos: [] });
    render(<YoutubeChannelSection />);
    expect(
      screen.getByText(/ficha da Wings Company \(Formatação → Clientes → redes sociais\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Próxima leitura/)).toBeTruthy();
  });

  it('warns about a failed reading and keeps the last good one on screen', () => {
    state.data = response({
      lastRun: { startedAt: '2026-10-10T10:00:00.000Z', status: 'failed', error: 'quota_exceeded' },
    });
    render(<YoutubeChannelSection />);
    expect(
      screen.getByText(
        /falhou: a quota diária da YouTube Data API acabou\. Os números abaixo são da leitura de 09\/10/,
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });

  it('says when it is loading or could not load', () => {
    render(<YoutubeChannelSection />);
    expect(screen.getByText('Carregando…')).toBeTruthy();
    cleanup();
    state.isError = true;
    render(<YoutubeChannelSection />);
    expect(screen.getByRole('alert').textContent).toMatch(/Não foi possível carregar o canal/);
  });
});

describe('formatDuration', () => {
  it('reads seconds as m:ss or h:mm:ss', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(30)).toBe('0:30');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3723)).toBe('1:02:03');
  });
});
