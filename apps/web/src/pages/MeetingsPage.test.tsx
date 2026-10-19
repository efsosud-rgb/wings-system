import type { MeetingListItem, RoleKey, SessionUser } from '@wings/shared';
import { ROLE_PERMISSIONS } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: { get: (path: string) => get(path) },
}));

const { MeetingsPage } = await import('./MeetingsPage.js');
const { ApiError } = await import('../api/client.js');
const { sessionKey } = await import('../api/auth.js');
const { formatDateTime } = await import('./crm/format.js');

const asRole = (role: RoleKey): SessionUser => ({
  employeeId: 'emp-1',
  fullName: 'Pessoa Teste',
  email: 'pessoa@exemplo.com',
  cargo: 'Cargo de Teste',
  role,
  sector: 'comercial',
  isSectorManager: false,
  tracksTime: true,
  permissions: ROLE_PERMISSIONS[role],
  lastLoginAt: null,
  sessionExpiresAt: '2026-10-19T23:00:00Z',
});
/** Reads its own deals / reads every deal. */
const SELLER = asRole('vendedor_expansao');
const ADMIN = asRole('admin_master');

const meeting = (over: Partial<MeetingListItem> = {}): MeetingListItem => ({
  id: 'm1',
  leadId: 'lead-1',
  title: 'Diagnóstico',
  startsAt: '2026-10-20T17:00:00.000Z',
  endsAt: '2026-10-20T18:00:00.000Z',
  status: 'agendada',
  calendar: 'vendedor',
  meetUrl: null,
  ownerEmployeeId: 'emp-1',
  googleEventId: null,
  recordingState: 'nenhuma',
  transcriptState: 'nenhuma',
  analysisState: 'nenhuma',
  summarySendState: 'nenhum',
  dealOwnerName: 'Ana Vendedora',
  ...over,
});

const UPCOMING = [
  meeting(),
  meeting({ id: 'm2', leadId: 'lead-2', title: 'Proposta', status: 'em_andamento' }),
];
const PAST = [
  meeting({
    id: 'm3',
    leadId: 'lead-3',
    title: 'Primeira conversa',
    status: 'encerrada',
    recordingState: 'guardada',
    startsAt: '2026-10-10T17:00:00.000Z',
  }),
  meeting({
    id: 'm4',
    leadId: 'lead-4',
    title: 'Desistiu',
    status: 'cancelada',
    dealOwnerName: null,
  }),
];

/** What the API answers, by `when`. */
function serve(answers: {
  upcoming?: MeetingListItem[] | Error;
  past?: MeetingListItem[] | Error;
}) {
  get.mockImplementation((path: string) => {
    const answer =
      path === '/meetings?when=upcoming'
        ? answers.upcoming
        : path === '/meetings?when=past'
          ? answers.past
          : undefined;
    if (answer === undefined) return Promise.reject(new Error(`unexpected ${path}`));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ meetings: answer });
  });
}

function renderPage(user: SessionUser = SELLER) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionKey, user);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MeetingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
});
afterEach(cleanup);

describe('Produtividade → Reuniões', () => {
  it('lists the upcoming meetings first, each linking to its deal, with status and time', async () => {
    serve({ upcoming: UPCOMING, past: PAST });
    renderPage();
    const link = await screen.findByRole('link', { name: 'Diagnóstico' });
    expect(link.getAttribute('href')).toBe('/crm-vendas/negociacoes/lead-1');
    expect(screen.getByRole('link', { name: 'Proposta' }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/lead-2',
    );
    expect(screen.getByText('Agendada')).toBeTruthy();
    expect(screen.getByText('Em andamento')).toBeTruthy();
    expect(screen.getAllByText(formatDateTime('2026-10-20T17:00:00.000Z'))).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Reuniões' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Próximas' }).className).toBe('is-active');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/meetings?when=upcoming');
    // Read-only: the page only points to the deal.
    expect(screen.getByText('Para marcar, remarcar ou iniciar, abra a negociação.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Marcar|Nova|Criar|Cancelar|Iniciar/ })).toBeNull();
  });

  it('switches to Anteriores: asks for the past ones and shows them, with the recording noted', async () => {
    serve({ upcoming: UPCOMING, past: PAST });
    renderPage();
    await screen.findByRole('link', { name: 'Diagnóstico' });
    fireEvent.click(screen.getByRole('button', { name: 'Anteriores' }));
    expect(await screen.findByRole('link', { name: 'Primeira conversa' })).toBeTruthy();
    expect(get).toHaveBeenLastCalledWith('/meetings?when=past');
    expect(screen.queryByRole('link', { name: 'Diagnóstico' })).toBeNull();
    expect(screen.getByText('Encerrada · gravada')).toBeTruthy();
    expect(screen.getByText('Cancelada')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Anteriores' }).className).toBe('is-active');
    expect(screen.getByRole('button', { name: 'Próximas' }).className).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Próximas' }));
    expect(await screen.findByRole('link', { name: 'Diagnóstico' })).toBeTruthy();
  });

  it('shows the owner of the deal only to a level that reads every lead', async () => {
    serve({ upcoming: [meeting(), meeting({ id: 'm2', title: 'Retorno', dealOwnerName: null })] });
    renderPage(ADMIN);
    expect(await screen.findByText('Agendada · Ana Vendedora')).toBeTruthy();
    expect(screen.getByText('Agendada · sem dono')).toBeTruthy();
    cleanup();

    // A seller reads their own deals: the name is theirs and adds nothing, so it is not shown.
    renderPage(SELLER);
    expect(await screen.findAllByText('Agendada')).toHaveLength(2);
    expect(screen.queryByText(/Ana Vendedora|sem dono/)).toBeNull();
  });

  it('says "—" and why when the meetings cannot be read, never an empty list', async () => {
    serve({ upcoming: new ApiError(500, {}) });
    renderPage();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /^—Não foi possível carregar as reuniões: o servidor teve um problema \(erro 500\)/,
    );
    expect(screen.queryByText('Nenhuma reunião marcada.')).toBeNull();
    expect(screen.queryByText('Nenhuma reunião anterior.')).toBeNull();

    serve({ upcoming: UPCOMING });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('link', { name: 'Diagnóstico' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says why for a refusal too (403), on the past list as on the upcoming one', async () => {
    serve({ upcoming: UPCOMING, past: new ApiError(403, { error: 'forbidden' }) });
    renderPage();
    await screen.findByRole('link', { name: 'Diagnóstico' });
    fireEvent.click(screen.getByRole('button', { name: 'Anteriores' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'você não tem permissão para ver isto',
    );
    expect(screen.queryByText('Nenhuma reunião anterior.')).toBeNull();
  });

  it('says "Carregando…" first and the empty text only after an answer that succeeded', async () => {
    get.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByText('Carregando…')).toBeTruthy();
    expect(screen.queryByText('Nenhuma reunião marcada.')).toBeNull();
    cleanup();

    serve({ upcoming: [], past: [] });
    renderPage();
    expect(await screen.findByText('Nenhuma reunião marcada.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Anteriores' }));
    await waitFor(() => expect(screen.getByText('Nenhuma reunião anterior.')).toBeTruthy());
  });
});
