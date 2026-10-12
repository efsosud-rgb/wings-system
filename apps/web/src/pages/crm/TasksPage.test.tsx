import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { TasksPage } from './TasksPage.js';

/** The task list: a failed request says why, it never reads as "Nada aqui." with 0 counts. */

const { state } = vi.hoisted(() => ({ state: { tasks: {} as Record<string, unknown> } }));

vi.mock('../../api/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/auth.js')>('../../api/auth.js');
  return { ...actual, useSession: () => ({ data: { id: 'e1', role: 'admin', permissions: {} } }) };
});
vi.mock('../../api/leads.js', () => ({ useSellers: () => ({ data: undefined }) }));
vi.mock('../../api/crm.js', () => ({
  useCompleteTask: () => ({ mutate: vi.fn(), isPending: false }),
  useTaskList: () => state.tasks,
}));

afterEach(cleanup);

const renderPage = () =>
  render(
    <MemoryRouter>
      <TasksPage />
    </MemoryRouter>,
  );

describe('Tarefas', () => {
  it('says why, and shows no empty groups, when the request failed', () => {
    state.tasks = {
      isLoading: false,
      isError: true,
      isSuccess: false,
      error: new ApiError(401, {}),
      data: undefined,
      refetch: vi.fn(),
    };
    renderPage();
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar as tarefas');
    expect(screen.getByRole('alert').textContent).toContain('sua sessão expirou');
    expect(screen.queryByText('Nada aqui.')).toBeNull();
    expect(screen.queryByText('Atrasadas')).toBeNull();
  });

  it('shows no empty groups while it loads', () => {
    state.tasks = { isLoading: true, isError: false, isSuccess: false, data: undefined };
    renderPage();
    expect(screen.getByText('Carregando…')).toBeTruthy();
    expect(screen.queryByText('Nada aqui.')).toBeNull();
  });

  it('keeps the earlier tasks and adds the failure line when a refresh failed', () => {
    state.tasks = {
      isLoading: false,
      isError: true,
      isSuccess: false,
      error: new TypeError('x'),
      refetch: vi.fn(),
      data: {
        tasks: [
          {
            id: 't1',
            leadId: 'l1',
            title: 'Ligar de volta',
            kind: 'call',
            dueAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
            doneAt: null,
          },
        ],
      },
    };
    renderPage();
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(screen.getByText(/Ligar de volta/)).toBeTruthy();
  });

  it('still says "Nada aqui." in each group when the request succeeded with no tasks', () => {
    state.tasks = { isLoading: false, isError: false, isSuccess: true, data: { tasks: [] } };
    renderPage();
    expect(screen.getAllByText('Nada aqui.')).toHaveLength(3);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
