import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../../api/client.js', async (original) => ({
  ...(await original<typeof import('../../api/client.js')>()),
  api: { get: (path: string) => get(path) },
}));

const { ProjectSummary } = await import('./ProjectParts.js');
const { ApiError } = await import('../../api/client.js');

function renderSummary() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectSummary clientId="c-1" slot={null} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
});
afterEach(cleanup);

describe('the project strip on a client folder', () => {
  it('says "—" and why when the project could not be read, instead of vanishing', async () => {
    get.mockRejectedValue(new ApiError(500, {}));
    renderSummary();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Não foi possível carregar o projeto do cliente: o servidor teve um problema \(erro 500\)/,
    );
  });

  it('shows nothing when the API says the client has no project', async () => {
    get.mockRejectedValue(new ApiError(404, { error: 'not_found' }));
    const { container } = renderSummary();
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
