import { PROJECT_STAGES, type ClientProject, type ClientProjectStage } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const patch = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    patch: (path: string, body?: unknown) => patch(path, body),
  },
}));

const { ProjectsPage } = await import('./ProjectsPage.js');
const { ApiError } = await import('../api/client.js');

const stages = (
  canEdit: (slot: string) => boolean,
  progress: Partial<Record<string, ClientProjectStage['progress']>> = {},
): ClientProjectStage[] =>
  PROJECT_STAGES.map((stage) => ({
    slot: stage.slot,
    name: stage.name,
    department: stage.department,
    progress: progress[stage.slot] ?? 'nao_iniciada',
    note: null,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    updatedByName: null,
    canEdit: canEdit(stage.slot),
  }));

const project = (extra: Partial<ClientProject>): ClientProject => ({
  id: 'p-1',
  clientId: 'c-1',
  clientName: 'Padaria Aurora',
  clientNumber: 3,
  clientActive: true,
  status: 'em_andamento',
  currentStage: '01',
  updatedAt: '2026-09-24T12:00:00.000Z',
  updatedByName: null,
  stages: stages(() => true),
  canManage: true,
  ...extra,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectsPage />
    </QueryClientProvider>,
  );
}

const board = { current: [] as ClientProject[] };

beforeEach(() => {
  board.current = [
    project({}),
    project({
      id: 'p-2',
      clientId: 'c-2',
      clientName: 'Sushi do Bairro',
      clientNumber: 7,
      status: 'parado',
      currentStage: '04',
      stages: stages(() => false, { '01': 'concluida', '04': 'bloqueada' }),
      canManage: false,
    }),
  ];
  get.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith('/projects')) {
      const params = new URL(`http://x${path}`).searchParams;
      const status = params.get('status');
      return { projects: board.current.filter((row) => !status || row.status === status) };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  patch.mockReset();
});
afterEach(cleanup);

describe('Gestão → Projetos', () => {
  it('shows one row per client with the eight stages, and only what the viewer may change is a button', async () => {
    renderPage();
    const aurora = (await screen.findByRole('cell', { name: /Padaria Aurora/ })).closest(
      'tr',
    ) as HTMLElement;
    expect(within(aurora).getByText('03')).toBeTruthy();
    expect(
      within(aurora).getByRole('button', { name: 'Status de Padaria Aurora: Em Andamento' }),
    ).toBeTruthy();
    expect(within(aurora).getByLabelText('Etapa atual de Padaria Aurora')).toHaveProperty(
      'value',
      '01',
    );
    expect(within(aurora).getAllByRole('button', { name: /: Não iniciada$/ })).toHaveLength(8);

    const sushi = screen
      .getByRole('cell', { name: /Sushi do Bairro/ })
      .closest('tr') as HTMLElement;
    expect(within(sushi).getByText('Parado')).toBeTruthy();
    expect(within(sushi).queryByRole('button')).toBeNull();
    expect(within(sushi).getByText('04 Financeiro')).toBeTruthy();
    expect(within(sushi).getByText('Concluída')).toBeTruthy();
    expect(within(sushi).getByText('Bloqueada')).toBeTruthy();
  });

  it('filters by status through the API and by name on the screen', async () => {
    renderPage();
    await screen.findByRole('cell', { name: /Padaria Aurora/ });
    fireEvent.change(screen.getByLabelText('Filtrar por status'), { target: { value: 'parado' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/projects?status=parado'));
    await waitFor(() => expect(screen.queryByRole('cell', { name: /Padaria Aurora/ })).toBeNull());
    expect(screen.getByRole('cell', { name: /Sushi do Bairro/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filtrar por status'), { target: { value: '' } });
    await screen.findByRole('cell', { name: /Padaria Aurora/ });
    fireEvent.change(screen.getByPlaceholderText('Nome do cliente'), {
      target: { value: 'sushi' },
    });
    expect(screen.queryByRole('cell', { name: /Padaria Aurora/ })).toBeNull();
    expect(screen.getByRole('cell', { name: /Sushi do Bairro/ })).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Mostrar clientes inativos'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/projects?inactive=true'));
  });

  it('changes the status, asking for a reason on Parado', async () => {
    patch.mockImplementation(async (_path: string, body: { status: string; reason?: string }) => {
      board.current[0] = project({ status: body.status as ClientProject['status'] });
      return { project: board.current[0] };
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Status de Padaria Aurora: Em Andamento' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Status de Padaria Aurora' });
    fireEvent.change(within(dialog).getByLabelText('Novo status'), { target: { value: 'parado' } });
    const save = within(dialog).getByRole('button', { name: 'Salvar status' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('Motivo'), {
      target: { value: 'Aguardando o contrato' },
    });
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/projects/c-1/status', {
        status: 'parado',
        reason: 'Aguardando o contrato',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByRole('button', { name: 'Status de Padaria Aurora: Parado' });
  });

  it('sets a stage, requiring a note when blocked, and shows the API refusal', async () => {
    patch
      .mockRejectedValueOnce(
        new ApiError(409, {
          error: 'project_closed',
          message: 'O projeto está finalizado ou cancelado.',
        }),
      )
      .mockImplementation(
        async (_path: string, body: { progress: ClientProjectStage['progress'] }) => {
          board.current[0] = project({
            currentStage: '02',
            stages: stages(() => true, { '01': body.progress }),
          });
          return { project: board.current[0] };
        },
      );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: '01 Boas Vindas: Não iniciada' }));
    const dialog = screen.getByRole('dialog', { name: '01 Boas Vindas de Padaria Aurora' });
    fireEvent.change(within(dialog).getByLabelText('Andamento'), {
      target: { value: 'bloqueada' },
    });
    const save = within(dialog).getByRole('button', { name: 'Salvar etapa' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('Observação'), {
      target: { value: 'Falta o CNPJ' },
    });
    fireEvent.click(save);
    await within(dialog).findByText('O projeto está finalizado ou cancelado.');

    fireEvent.change(within(dialog).getByLabelText('Andamento'), {
      target: { value: 'concluida' },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith('/projects/c-1/stages/01', {
        progress: 'concluida',
        note: 'Falta o CNPJ',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByRole('button', { name: '01 Boas Vindas: Concluída' });
    expect(screen.getByLabelText('Etapa atual de Padaria Aurora')).toHaveProperty('value', '02');
  });

  it('moves the current stage from the select', async () => {
    patch.mockImplementation(
      async (_path: string, body: { stage: ClientProject['currentStage'] }) => {
        board.current[0] = project({ currentStage: body.stage });
        return { project: board.current[0] };
      },
    );
    renderPage();
    fireEvent.change(await screen.findByLabelText('Etapa atual de Padaria Aurora'), {
      target: { value: '06' },
    });
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/projects/c-1/current-stage', { stage: '06' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Etapa atual de Padaria Aurora')).toHaveProperty('value', '06'),
    );
  });
});
