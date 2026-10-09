import type { OwnedChannelsResponse } from '@wings/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = { data: {} as OwnedChannelsResponse };

vi.mock('../../api/dashboard.js', () => ({
  useOwnedChannels: () => ({ data: state.data, isError: false }),
}));
vi.mock('../../api/youtube.js', () => ({
  useYoutubeChannel: () => ({
    isError: false,
    data: {
      configured: { key: false, source: null },
      gap: 'no_key',
      channel: null,
      lastRun: null,
      nextRunAt: null,
      history: null,
      videos: [],
    },
  }),
}));

const { OwnedChannelsTab } = await import('./OwnedChannelsTab.js');

function response(overrides: Partial<OwnedChannelsResponse['blog']>): OwnedChannelsResponse {
  return {
    days: 30,
    since: '2026-08-23',
    until: '2026-09-21',
    blog: {
      configured: true,
      syncedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      mirrored: 12,
      posts: [
        {
          id: 2477,
          title: 'Como formatar uma franquia',
          publishedAt: '2026-09-10T13:00:00.000Z',
          modifiedAt: null,
          categories: ['Franchising', 'Gestão'],
          link: 'https://wingscompany.com.br/como-formatar-uma-franquia',
        },
      ],
      ...overrides,
    },
    social: null,
  };
}

afterEach(() => cleanup());

describe('Canais próprios', () => {
  it('lists the posts of the period with a link to the site, and keeps a place for social', () => {
    state.data = response({});
    render(<OwnedChannelsTab days={30} />);
    const link = screen.getByRole('link', { name: 'Como formatar uma franquia' });
    expect(link.getAttribute('href')).toBe(
      'https://wingscompany.com.br/como-formatar-uma-franquia',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('10/09/2026')).toBeTruthy();
    expect(screen.getByText('Franchising, Gestão')).toBeTruthy();
    expect(screen.getByText(/Espelho do site atualizado há 30 min/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Publicação social' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'YouTube' })).toBeTruthy();
  });

  it('tells an empty period apart from an empty mirror', () => {
    state.data = response({ posts: [] });
    render(<OwnedChannelsTab days={7} />);
    expect(
      screen.getByText(/Nenhum post publicado nos últimos 7 dias\. O espelho tem 12 posts/),
    ).toBeTruthy();
  });

  it('says when WordPress is not configured, with no fake rows', () => {
    state.data = response({ configured: false, syncedAt: null, mirrored: 0, posts: [] });
    render(<OwnedChannelsTab days={30} />);
    expect(screen.getByText(/A integração com o WordPress não está configurada/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
