import type { SitePostRecord } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The owned-channels tab promises one thing on screen — a draft, never a live
 * post — and must be honest when the server cannot reach the site at all.
 */

const site = { configured: true };
const posts: { current: SitePostRecord[] } = { current: [] };
const createDraft = vi.fn();
const createState: { current: Record<string, unknown> } = { current: {} };

vi.mock('../../api/ads.js', () => ({
  useSiteStatus: () => ({
    isSuccess: true,
    data: {
      status: {
        configured: site.configured,
        siteHost: site.configured ? 'wingscompany.com.br' : null,
      },
    },
  }),
  useSitePosts: () => ({ data: { posts: posts.current } }),
  useCreateSiteDraft: () => ({
    mutate: createDraft,
    reset: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    ...createState.current,
  }),
}));

const { OwnedChannelsPanel } = await import('./OwnedChannelsPanel.js');

afterEach(() => {
  cleanup();
  site.configured = true;
  posts.current = [];
  createState.current = {};
  createDraft.mockReset();
});

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });

describe('the owned-channels tab', () => {
  it('shows the site as the only real channel, the others as coming soon', () => {
    render(<OwnedChannelsPanel canPublish />);
    expect(screen.getByRole('button', { name: 'Criar rascunho no site' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Portal ClickFranquia' }).textContent).toContain(
      'Em breve',
    );
    expect(screen.getByRole('region', { name: 'App ClickFranquia' }).textContent).toContain(
      'Em breve',
    );
    // None of the paid-media fields leak into this tab.
    expect(screen.queryByText(/Verba/)).toBeNull();
  });

  it('sends a draft, and says it is not live', async () => {
    render(<OwnedChannelsPanel canPublish />);
    type(screen.getByLabelText(/^Título/), 'Como é o dia a dia de um franqueado');
    type(
      screen.getByLabelText(/^Texto do post/),
      'Um texto com mais de cinquenta caracteres para passar na validação do post.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunho no site' }));
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    expect(createDraft.mock.calls[0]?.[0]).toMatchObject({
      title: 'Como é o dia a dia de um franqueado',
    });
  });

  it('links to WordPress once the draft exists', () => {
    createState.current = {
      isSuccess: true,
      data: { editUrl: 'https://wingscompany.com.br/wp-admin/post.php?post=9&action=edit' },
    };
    render(<OwnedChannelsPanel canPublish />);
    expect(screen.getByText(/ainda não está no ar/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /revisar e publicar/ }).getAttribute('href')).toContain(
      'post=9',
    );
  });

  it('turns sending off, and says why, when the server has no credentials', () => {
    site.configured = false;
    render(<OwnedChannelsPanel canPublish />);
    expect(screen.getByText(/ainda não foi configurada no servidor/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Criar rascunho no site' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('warns about risky promises without blocking the site', () => {
    render(<OwnedChannelsPanel canPublish />);
    type(screen.getByLabelText(/^Título/), 'Retorno garantido em 12 meses');
    expect(screen.getByText(/No site isto não é bloqueado/)).toBeTruthy();
  });

  it('lists what was sent, unconfirmed attempts included', () => {
    posts.current = [
      {
        id: 'p1',
        title: 'Post enviado',
        outcome: 'unknown',
        editUrl: null,
        createdAt: '2026-09-18T12:00:00.000Z',
        createdByName: 'Eric',
      },
    ];
    render(<OwnedChannelsPanel canPublish />);
    expect(screen.getByText(/Sem confirmação — confira no WordPress/)).toBeTruthy();
  });
});
