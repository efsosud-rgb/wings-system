import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: { get: (path: string) => get(path) },
}));

const { RoadmapPage } = await import('./RoadmapPage.js');
const { ApiError } = await import('../api/client.js');

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RoadmapPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
});
afterEach(cleanup);

describe('Administração → Roadmap — when a request fails', () => {
  it('says "—" and why for the modules', async () => {
    get.mockRejectedValue(new ApiError(500, {}));
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar o roadmap: o servidor teve um problema \(erro 500\)/,
    );
  });

  it('does not say "Nenhum relatório gerado ainda" for reports that could not load', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/roadmap/reports') throw new TypeError('Failed to fetch');
      throw new ApiError(500, {});
    });
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Relatórios' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar os relatórios: sem conexão com o servidor/,
    );
    expect(screen.queryByText(/Nenhum relatório gerado ainda/)).toBeNull();
  });

  it('says "Nenhum relatório gerado ainda" when the reports answered with none', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/roadmap/reports') return { runs: [] };
      throw new ApiError(500, {});
    });
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Relatórios' }));
    expect(await screen.findByText(/Nenhum relatório gerado ainda/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not say "Nenhum destinatário cadastrado" for recipients that could not load', async () => {
    get.mockRejectedValue(new ApiError(403, {}));
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Destinatários' }));
    expect(
      await screen.findByText(
        /Não foi possível carregar os destinatários: você não tem permissão para ver isto/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Nenhum destinatário cadastrado.')).toBeNull();
  });

  it('says "Nenhum destinatário cadastrado." when the list answered with none', async () => {
    get.mockResolvedValue({ recipients: [] });
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: 'Destinatários' }));
    expect(await screen.findByText('Nenhum destinatário cadastrado.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
