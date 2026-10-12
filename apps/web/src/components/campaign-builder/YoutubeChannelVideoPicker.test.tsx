import type { YoutubeChannelResponse, YoutubeVideoSummary } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const state: { data: YoutubeChannelResponse | undefined; isError: boolean; error?: unknown } = {
  data: undefined,
  isError: false,
};

vi.mock('../../api/youtube.js', () => ({
  useYoutubeChannel: () => ({
    data: state.data,
    isError: state.isError,
    error: state.error,
    refetch: vi.fn(),
  }),
}));

const { YoutubeChannelVideoPicker } = await import('./YoutubeChannelVideoPicker.js');

const video = (id: string, title: string, views: number, isShort: boolean | null) =>
  ({
    id,
    title,
    publishedAt: '2026-09-20T15:00:00.000Z',
    durationSeconds: isShort ? 30 : 120,
    thumbnailUrl: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    isShort,
    views,
    likes: 1,
    comments: 0,
    growth: {
      7: { value: 1, fromDay: '2026-10-02' },
      30: { value: 1, fromDay: '2026-09-09' },
    },
    link: `https://www.youtube.com/watch?v=${id}`,
  }) satisfies YoutubeVideoSummary;

const channel = (overrides: Partial<YoutubeChannelResponse> = {}): YoutubeChannelResponse => ({
  configured: { key: true, source: 'client_record' },
  gap: null,
  channel: { id: 'UCabcdefghijklmnopqrstuv', title: 'Wings Company' },
  lastRun: { startedAt: '2026-10-09T10:00:00.000Z', status: 'ok', error: null },
  nextRunAt: null,
  history: { firstDay: '2026-09-09', lastDay: '2026-10-09', days: 3 },
  videos: [
    video('aaaaaaaaaaa', 'Institucional Wings', 2000, false),
    video('bbbbbbbbbbb', 'Short da cafeteria', 300, true),
  ],
  ...overrides,
});

afterEach(() => {
  cleanup();
  state.data = undefined;
  state.isError = false;
});

describe('YoutubeChannelVideoPicker', () => {
  it('hands the picked video id to the form, without submitting it', () => {
    state.data = channel();
    const onPick = vi.fn();
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent)}>
        <YoutubeChannelVideoPicker selected={[]} max={5} onPick={onPick} />
      </form>,
    );
    expect(screen.getByRole('group', { name: 'Vídeos do canal' })).toBeTruthy();
    expect(screen.getByText(/Short · 0:30 · 300 visualizações/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Usar Short da cafeteria' }));
    expect(onPick).toHaveBeenCalledWith('bbbbbbbbbbb');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('marks what is already in the form and stops at the form limit', () => {
    state.data = channel();
    const onPick = vi.fn();
    render(<YoutubeChannelVideoPicker selected={['aaaaaaaaaaa']} max={2} onPick={onPick} />);
    const chosen = screen.getByRole('button', { name: 'Institucional Wings: já escolhido' });
    expect(chosen.hasAttribute('disabled')).toBe(true);
    expect(chosen.textContent).toBe('Escolhido');
    expect(
      screen.getByRole('button', { name: 'Usar Short da cafeteria' }).hasAttribute('disabled'),
    ).toBe(false);
    cleanup();

    render(<YoutubeChannelVideoPicker selected={['x1', 'x2']} max={2} onPick={onPick} />);
    const full = screen.getByRole('button', { name: 'Usar Short da cafeteria' });
    expect(full.hasAttribute('disabled')).toBe(true);
    expect(full.getAttribute('title')).toBe('Já há 2 vídeos no anúncio');
    fireEvent.click(full);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('falls back to pasting a link, saying why, when there is no list', () => {
    state.data = channel({ gap: 'no_key', videos: [], history: null });
    render(<YoutubeChannelVideoPicker selected={[]} max={5} onPick={vi.fn()} />);
    expect(
      screen.getByText(/falta a chave da YouTube Data API\)\. Cole o link do vídeo\./),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();

    state.data = undefined;
    state.isError = true;
    state.error = new ApiError(500, {});
    render(<YoutubeChannelVideoPicker selected={[]} max={5} onPick={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar os vídeos do canal: o servidor teve um problema (erro 500)',
    );
    expect(screen.getByText('Cole o link do vídeo.')).toBeTruthy();
    expect(screen.queryByText(/Nenhum vídeo público/)).toBeNull();
  });
});
