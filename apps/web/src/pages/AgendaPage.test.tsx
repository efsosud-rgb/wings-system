import type { AgendaEvent, AgendaEventsAnswer, AgendaOverview } from '@wings/shared';
import { AGENDA_NOTICES } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    patch: (path: string, body?: unknown) => patch(path, body),
    delete: (path: string) => del(path),
  },
}));

const { AgendaPage } = await import('./AgendaPage.js');
const { ApiError } = await import('../api/client.js');

const overview = (over: Partial<AgendaOverview> = {}): AgendaOverview => ({
  state: 'ready',
  googleEmail: 'pessoa@exemplo.com',
  calendars: [
    {
      key: 'mine',
      name: 'Pessoa Teste',
      backgroundColor: '#039be5',
      foregroundColor: '#ffffff',
      canWrite: true,
    },
    {
      key: 'wings',
      name: 'Wings Company',
      backgroundColor: '#33b679',
      foregroundColor: '#ffffff',
      canWrite: true,
    },
  ],
  wings: 'writer',
  eventColors: { '11': { background: '#dc2127', foreground: '#1d1d1d' } },
  eventColorsSource: 'google',
  ...over,
});

const event = (over: Partial<AgendaEvent> = {}): AgendaEvent => ({
  calendar: 'mine',
  id: 'e1',
  uid: 'e1@google.com',
  title: 'Reunião de teste',
  allDay: false,
  start: '2026-10-14T12:00:00.000Z',
  end: '2026-10-14T13:00:00.000Z',
  location: null,
  description: null,
  meetUrl: null,
  htmlLink: null,
  colorId: null,
  tentative: false,
  organizer: { email: 'pessoa@exemplo.com', name: null, self: true },
  attendees: [],
  recurring: false,
  canEdit: true,
  guestsNotified: false,
  crm: null,
  ...over,
});

function serve(
  view: AgendaOverview | Error,
  answer: AgendaEventsAnswer | Error = { events: [], failures: [], truncated: false },
  pasted: AgendaEvent[] | Error = [],
) {
  get.mockImplementation((path: string) => {
    if (path.startsWith('/agenda/crm-meetings?')) {
      return pasted instanceof Error ? Promise.reject(pasted) : Promise.resolve({ events: pasted });
    }
    if (path === '/agenda') {
      return view instanceof Error ? Promise.reject(view) : Promise.resolve({ overview: view });
    }
    if (path.startsWith('/agenda/events?')) {
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}
const answerWith = (...events: AgendaEvent[]): AgendaEventsAnswer => ({
  events,
  failures: [],
  truncated: false,
});

function renderPage(path = '/produtividade/agenda?visao=semana&data=2026-10-14') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AgendaPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const MEETING = 'Reunião de teste, quarta-feira, 14 de outubro, 09:00 a 10:00, agenda Pessoa Teste';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T15:00:00Z'));
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Agenda — week view', () => {
  it('shows Sunday to Saturday with today marked and the 24-hour labels', async () => {
    serve(overview(), answerWith(event()));
    const { container } = renderPage();
    expect(await screen.findByRole('button', { name: MEETING })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'outubro de 2026' })).toBeTruthy();
    const heads = [...container.querySelectorAll('.agenda-tg-weekday')].map((n) => n.textContent);
    expect(heads).toEqual(['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB']);
    const columns = [...container.querySelectorAll('.agenda-tg-col')].map((n) =>
      n.getAttribute('data-day'),
    );
    expect(columns[0]).toBe('2026-10-11');
    expect(columns[6]).toBe('2026-10-17');
    const todayHead = container.querySelector('.agenda-tg-dayhead.is-today .agenda-tg-daynum');
    expect(todayHead?.getAttribute('aria-label')).toBe('14 de outubro de 2026');
    expect(todayHead?.getAttribute('aria-current')).toBe('date');
    expect(screen.getByText('00:00')).toBeTruthy();
    expect(screen.getByText('09:00', { selector: '.agenda-tg-hour' })).toBeTruthy();
    expect(screen.getByText('23:00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Semana anterior' })).toBeTruthy();
    // The range asked for: Sunday 00:00 to the next Sunday 00:00, São Paulo.
    expect(get).toHaveBeenCalledWith(
      '/agenda/events?from=2026-10-11T03%3A00%3A00.000Z&to=2026-10-18T03%3A00%3A00.000Z',
    );
    // The red line of now sits in today's column.
    expect(container.querySelector('[data-day="2026-10-14"] .agenda-now')).toBeTruthy();
  });

  it('draws overlapping events side by side', async () => {
    serve(
      overview(),
      answerWith(
        event(),
        event({
          id: 'e2',
          uid: 'e2@google.com',
          title: 'Outra reunião',
          start: '2026-10-14T12:30:00.000Z',
          end: '2026-10-14T13:30:00.000Z',
        }),
      ),
    );
    renderPage();
    const first = await screen.findByRole('button', { name: MEETING });
    const second = screen.getByRole('button', { name: /^Outra reunião/ });
    expect(first.style.left).toBe('0%');
    expect(second.style.left).toBe('50%');
    expect(first.style.width).toBe('calc(50% - 4px)');
    expect(first.textContent).toContain('09:00 – 10:00');
  });

  it('hides a calendar’s events at once when it is unticked, without reading again', async () => {
    serve(
      overview(),
      answerWith(
        event(),
        event({ calendar: 'wings', id: 'w1', uid: 'w1@google.com', title: 'Evento da Wings' }),
      ),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: /^Evento da Wings/ })).toBeTruthy();
    const reads = get.mock.calls.length;
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wings Company' }));
    expect(screen.queryByRole('button', { name: /^Evento da Wings/ })).toBeNull();
    expect(screen.getByRole('button', { name: MEETING })).toBeTruthy();
    expect(get.mock.calls.length).toBe(reads);
    expect(window.localStorage.getItem('wings.agenda.hidden')).toBe('["wings"]');
  });

  it('switches view with the keyboard and the segmented control', async () => {
    serve(overview(), answerWith(event()));
    renderPage();
    await screen.findByRole('button', { name: MEETING });
    fireEvent.keyDown(window, { key: 'm' });
    expect(screen.getByRole('button', { name: 'Mês' }).getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByRole('button', { name: 'Próximo mês' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dia' }));
    expect(screen.getByRole('heading', { name: '14 de outubro de 2026' })).toBeTruthy();
    expect(window.localStorage.getItem('wings.agenda.view')).toBe('dia');
  });
});

describe('Agenda — states', () => {
  it('asks to connect Google in Minha conta when not connected', async () => {
    serve(overview({ state: 'not_connected', calendars: [] }));
    renderPage();
    expect(await screen.findByText(AGENDA_NOTICES.notConnected)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ir para Minha conta' }).getAttribute('href')).toBe(
      '/minha-conta',
    );
    expect(get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/agenda\/events/));
  });

  it('says the Wings Company calendar is not shared, and shows the person’s own', async () => {
    serve(
      overview({
        wings: 'not_shared',
        calendars: [overview().calendars[0]!],
      }),
      answerWith(event()),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: MEETING })).toBeTruthy();
    expect(screen.getAllByText(AGENDA_NOTICES.wingsNotShared).length).toBeGreaterThan(0);
    expect(screen.queryByRole('checkbox', { name: 'Wings Company' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Pessoa Teste' })).toBeTruthy();
  });

  it('shows "—" and the reason when the events cannot be read, never an empty week', async () => {
    serve(
      overview(),
      new ApiError(502, { error: 'google_unreachable', message: 'O Google não respondeu.' }),
    );
    const { container } = renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(
      /Não foi possível carregar os eventos: O Google não respondeu\./,
    );
    expect(container.querySelector('.agenda-tg-col')).toBeNull();
    expect(screen.queryByText('00:00')).toBeNull();
  });

  it('names the calendar that could not be read while the other one shows', async () => {
    serve(overview(), {
      events: [event()],
      failures: [{ calendar: 'wings', code: 'google_rejected', message: 'O Google recusou.' }],
      truncated: false,
    });
    renderPage();
    expect(await screen.findByRole('button', { name: MEETING })).toBeTruthy();
    expect(
      screen.getByText('Não foi possível ler a agenda Wings Company: O Google recusou.'),
    ).toBeTruthy();
  });

  it('says the list is empty only after a read that succeeded', async () => {
    serve(overview());
    renderPage('/produtividade/agenda?visao=agenda&data=2026-10-14');
    expect(await screen.findByText('Nenhum evento nos próximos 30 dias')).toBeTruthy();
  });
});

describe('Agenda — meetings pasted from the deal', () => {
  const pastedEvent = (over: Partial<AgendaEvent> = {}) =>
    event({
      id: 'crm-m1',
      uid: 'crm-m1',
      title: 'Diagnóstico colado',
      start: '2026-10-15T12:00:00.000Z',
      end: '2026-10-15T13:00:00.000Z',
      canEdit: false,
      crm: { leadId: 'lead-1' },
      ...over,
    });
  const section = () => screen.findByRole('region', { name: 'Reuniões marcadas pela ficha' });

  it('lists them under the connect notice for the next 30 days when Google is not connected', async () => {
    serve(overview({ state: 'not_connected', calendars: [] }), undefined, [
      pastedEvent(),
      pastedEvent({ id: 'crm-m2', uid: 'crm-m2', title: '', crm: { leadId: null } }),
    ]);
    renderPage();
    expect(await screen.findByText(AGENDA_NOTICES.notConnected)).toBeTruthy();
    const list = within(await section());
    expect(await list.findByText(/Diagnóstico colado/)).toBeTruthy();
    expect(list.getByText(/\(Sem título\)/)).toBeTruthy();
    // Only the meeting whose deal the person may open links to it.
    const links = list.getAllByRole('link', { name: 'Abrir negociação' });
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('/crm-vendas/negociacoes/lead-1');
    // The range starts today (local midnight) and spans 30 days; Google is never asked.
    const asked = get.mock.calls
      .map(([path]) => String(path))
      .find((p) => p.includes('crm-meetings'));
    const query = new URLSearchParams(asked!.split('?')[1]);
    const from = Date.parse(query.get('from')!);
    expect(Date.parse(query.get('to')!) - from).toBe(30 * 86_400_000);
    expect(new Date(from).getHours()).toBe(0);
    expect(get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/agenda\/events/));
  });

  it('lists them under the reconnect notice too', async () => {
    serve(overview({ state: 'needs_reconnect', calendars: [] }), undefined, [pastedEvent()]);
    renderPage();
    expect(await screen.findByText(AGENDA_NOTICES.needsReconnect)).toBeTruthy();
    expect(await within(await section()).findByText(/Diagnóstico colado/)).toBeTruthy();
  });

  it('says there is none only after a read that succeeded', async () => {
    serve(overview({ state: 'not_connected', calendars: [] }));
    renderPage();
    expect(
      await within(await section()).findByText(
        'Nenhuma reunião com link colado nos próximos 30 dias.',
      ),
    ).toBeTruthy();
  });

  it('shows "—" and the reason when they cannot be read, never an empty list', async () => {
    serve(
      overview({ state: 'not_connected', calendars: [] }),
      undefined,
      new ApiError(500, { error: 'internal', message: 'Erro interno.' }),
    );
    renderPage();
    const alert = await within(await section()).findByRole('alert');
    expect(alert.textContent).toMatch(/Não foi possível carregar as reuniões: /);
    expect(screen.queryByText(/Nenhuma reunião com link colado/)).toBeNull();
    // The connect notice stays.
    expect(screen.getByText(AGENDA_NOTICES.notConnected)).toBeTruthy();
  });

  it('is not asked for once Google is connected: the events answer carries them', async () => {
    serve(overview(), answerWith(pastedEvent()));
    renderPage();
    expect(await screen.findByRole('button', { name: /Diagnóstico colado/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Reuniões marcadas pela ficha' })).toBeNull();
    expect(get).not.toHaveBeenCalledWith(expect.stringMatching(/^\/agenda\/crm-meetings/));
  });
});

describe('Agenda — details', () => {
  it('shows Meet, place, description, guests and the calendar', async () => {
    serve(
      overview(),
      answerWith(
        event({
          meetUrl: 'https://meet.google.com/abc-defg-hij',
          htmlLink: 'https://www.google.com/calendar/event?eid=abc',
          location: 'Sala 2',
          description: 'Pauta em https://exemplo.com/pauta\nSegunda linha',
          attendees: [
            {
              email: 'pessoa@exemplo.com',
              name: 'Pessoa Teste',
              response: 'aceitou',
              organizer: true,
              self: true,
            },
            {
              email: 'convidado@exemplo.com',
              name: null,
              response: 'sem_resposta',
              organizer: false,
              self: false,
            },
          ],
        }),
      ),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: MEETING }));
    const card = screen.getByRole('dialog', { name: 'Reunião de teste' });
    // The Meet opens in its own window beside the Agenda, not in a new tab.
    expect(within(card).queryByRole('link', { name: 'Participar com o Google Meet' })).toBeNull();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    fireEvent.click(within(card).getByRole('button', { name: 'Participar com o Google Meet' }));
    expect(open).toHaveBeenCalledWith(
      'https://meet.google.com/abc-defg-hij',
      'wings-meet',
      expect.stringContaining('popup'),
    );
    expect(within(card).getByText('quarta-feira, 14 de outubro · 09:00 – 10:00')).toBeTruthy();
    expect(within(card).getByText('Sala 2')).toBeTruthy();
    expect(
      within(card).getByRole('link', { name: 'https://exemplo.com/pauta' }).getAttribute('href'),
    ).toBe('https://exemplo.com/pauta');
    expect(within(card).getByText('2 convidados')).toBeTruthy();
    expect(within(card).getByText('Organizador')).toBeTruthy();
    expect(within(card).getByText('Aguardando resposta')).toBeTruthy();
    expect(within(card).getByText('Pessoa Teste', { selector: 'p' })).toBeTruthy();
    expect(within(card).getByRole('link', { name: /Abrir no Google Agenda/ })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Editar evento' })).toBeTruthy();

    fireEvent.keyDown(card, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: MEETING }));
  });

  it('a CRM meeting opens its deal and offers no edit or delete', async () => {
    serve(overview(), answerWith(event({ canEdit: false, crm: { leadId: 'lead-1' } })));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: MEETING }));
    const card = screen.getByRole('dialog');
    expect(within(card).getByText('Reunião do CRM')).toBeTruthy();
    expect(within(card).getByText(AGENDA_NOTICES.crmMeeting)).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Abrir negociação' }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/lead-1',
    );
    expect(within(card).queryByRole('button', { name: /Editar|Excluir/ })).toBeNull();
  });
});

describe('Agenda — create and delete', () => {
  it('a click at Wednesday 09:00 creates an event at 09:00 São Paulo time', async () => {
    serve(overview());
    post.mockResolvedValue({ event: event() });
    const { container } = renderPage();
    await waitFor(() => expect(container.querySelector('[data-day="2026-10-14"]')).toBeTruthy());
    const column = container.querySelector('[data-day="2026-10-14"]')!;
    fireEvent.click(column, { clientY: 9 * 48 + 5 });
    const form = screen.getByRole('dialog', { name: 'Novo evento' });
    expect(within(form).getByLabelText('Hora de início')).toHaveProperty('value', '09:00');
    expect(within(form).getByLabelText('Hora de fim')).toHaveProperty('value', '10:00');
    fireEvent.change(within(form).getByLabelText('Título'), {
      target: { value: 'Alinhamento' },
    });
    const guest = within(form).getByPlaceholderText('Adicionar convidados (e-mail)');
    fireEvent.change(guest, { target: { value: 'nao-e-email' } });
    fireEvent.keyDown(guest, { key: 'Enter' });
    expect(within(form).getByText('E-mail inválido: nao-e-email')).toBeTruthy();
    fireEvent.change(guest, { target: { value: 'convidado@exemplo.com' } });
    fireEvent.keyDown(guest, { key: 'Enter' });
    expect(within(form).getByText('convidado@exemplo.com')).toBeTruthy();
    fireEvent.click(within(form).getByRole('checkbox', { name: /Google Meet/ }));
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/agenda/events', {
        calendar: 'mine',
        title: 'Alinhamento',
        allDay: false,
        start: '2026-10-14T12:00:00.000Z',
        end: '2026-10-14T13:00:00.000Z',
        location: null,
        description: null,
        attendees: ['convidado@exemplo.com'],
        createMeet: true,
        colorId: null,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('an all-day event sends Google’s exclusive end', async () => {
    serve(overview());
    post.mockResolvedValue({ event: event() });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Criar' }));
    const form = screen.getByRole('dialog', { name: 'Novo evento' });
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Dia inteiro' }));
    fireEvent.change(within(form).getByLabelText('Data de fim'), {
      target: { value: '2026-10-16' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/agenda/events',
        expect.objectContaining({ allDay: true, start: '2026-10-14', end: '2026-10-17' }),
      ),
    );
  });

  it('shows the API’s refusal in the form', async () => {
    serve(overview());
    post.mockRejectedValue(
      new ApiError(409, {
        error: 'wings_calendar_forbidden',
        message: AGENDA_NOTICES.wingsReadOnly,
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Criar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText(AGENDA_NOTICES.wingsReadOnly)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Novo evento' })).toBeTruthy();
  });

  it('asks inside the page before deleting, never with window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    serve(
      overview(),
      answerWith(
        event({
          recurring: true,
          guestsNotified: true,
          attendees: [
            {
              email: 'convidado@exemplo.com',
              name: null,
              response: 'aceitou',
              organizer: false,
              self: false,
            },
          ],
        }),
      ),
    );
    del.mockResolvedValue({});
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: MEETING }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir evento' }));
    const ask = screen.getByRole('alertdialog', { name: 'Excluir “Reunião de teste”?' });
    expect(ask.getAttribute('aria-modal')).toBe('true');
    expect(within(ask).getByText('Os convidados recebem o cancelamento por e-mail.')).toBeTruthy();
    expect(within(ask).getByText('Só esta ocorrência é excluída.')).toBeTruthy();
    expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(within(ask).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/agenda/events/mine/e1'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe('Agenda — review fixes', () => {
  const guest = {
    email: 'convidado@exemplo.com',
    name: null,
    response: 'aceitou' as const,
    organizer: false,
    self: false,
  };

  it('deleting a guest’s own copy says it leaves only their agenda', async () => {
    serve(
      overview(),
      answerWith(
        event({
          organizer: { email: 'organiza@exemplo.com', name: null, self: false },
          attendees: [guest, { ...guest, email: 'pessoa@exemplo.com', self: true }],
        }),
      ),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: MEETING }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir evento' }));
    const ask = screen.getByRole('alertdialog');
    expect(
      within(ask).getByText('O evento sai só da sua agenda; quem organiza continua com ele.'),
    ).toBeTruthy();
    expect(within(ask).queryByText('Os convidados recebem o cancelamento por e-mail.')).toBeNull();
  });

  it('a search says “nenhum evento” only after Google answered', async () => {
    let answerSearch: (value: AgendaEventsAnswer) => void = () => {};
    get.mockImplementation((path: string) => {
      if (path === '/agenda') return Promise.resolve({ overview: overview() });
      if (path.includes('q=')) {
        return new Promise<AgendaEventsAnswer>((done) => {
          answerSearch = done;
        });
      }
      return Promise.resolve(answerWith(event()));
    });
    renderPage();
    await screen.findByRole('button', { name: MEETING });
    fireEvent.click(screen.getByRole('button', { name: 'Pesquisar' }));
    const box = screen.getByRole('searchbox', { name: 'Pesquisar eventos' });
    fireEvent.change(box, { target: { value: 'contrato' } });
    fireEvent.submit(box);
    expect(await screen.findByText('Resultados para “contrato”')).toBeTruthy();
    expect(screen.getByText('Carregando eventos…')).toBeTruthy();
    expect(screen.queryByText(/Nenhum evento encontrado/)).toBeNull();
    answerSearch(answerWith());
    expect(await screen.findByText('Nenhum evento encontrado para “contrato”')).toBeTruthy();
  });

  it('qualifies an empty list when a calendar could not be read', async () => {
    serve(overview(), {
      events: [],
      failures: [
        { calendar: 'wings', code: 'google_unreachable', message: 'O Google não respondeu.' },
      ],
      truncated: false,
    });
    renderPage('/produtividade/agenda?visao=agenda&data=2026-10-14');
    expect(
      await screen.findByText(
        'Nenhum evento nos próximos 30 dias nas agendas que puderam ser lidas',
      ),
    ).toBeTruthy();
  });

  it('keeps the form open while saving, so a refusal is seen', async () => {
    serve(overview(), answerWith());
    post.mockReturnValue(new Promise(() => {}));
    renderPage();
    await screen.findByRole('heading', { name: 'outubro de 2026' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Criar evento' })[0]!);
    const form = screen.getByRole('dialog', { name: 'Novo evento' });
    fireEvent.change(within(form).getByPlaceholderText('Adicionar título'), {
      target: { value: 'Teste' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    fireEvent.keyDown(form, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Novo evento' })).toBeTruthy();
  });

  it('a reader of Wings Company is told to ask Thais, not the organizer', async () => {
    serve(
      overview({
        wings: 'reader',
        calendars: [overview().calendars[0]!, { ...overview().calendars[1]!, canWrite: false }],
      }),
      answerWith(
        event({
          calendar: 'wings',
          canEdit: false,
          organizer: { email: 'organiza@exemplo.com', name: null, self: false },
        }),
      ),
    );
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Reunião de teste, quarta-feira, 14 de outubro, 09:00 a 10:00, agenda Wings Company',
      }),
    );
    expect(screen.getByText(AGENDA_NOTICES.wingsReadOnly)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Editar evento' })).toBeNull();
  });
});

describe('Agenda — motion', () => {
  it('slides with the period and turns every animation off under reduced motion', async () => {
    serve(overview(), answerWith(event()));
    const { container } = renderPage();
    await screen.findByRole('button', { name: MEETING });
    fireEvent.click(screen.getByRole('button', { name: 'Próxima semana' }));
    expect(container.querySelector('.agenda-swap.is-next')).toBeTruthy();
    const css = readFileSync(resolve(import.meta.dirname, 'agenda.css'), 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.agenda-swap,[\s\S]*\.agenda-dialog[\s\S]*animation: none/);
  });
});
