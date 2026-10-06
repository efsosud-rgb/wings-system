import type { CrmStage, Lead, LeadTask } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DealPage, daysInStage, orderFields } from './DealPage.js';

/**
 * The deal's page, part 1: the head (name edited in place, tags, win or
 * lose), the stage bar with the days in the current stage, the action bar
 * and the "new deal: first contact until HH:MM" strip.
 */

const { dealMutate, taskMutate, leadMutate, queryState, idle, mutation } = vi.hoisted(() => ({
  dealMutate: vi.fn(),
  taskMutate: vi.fn(),
  leadMutate: vi.fn(),
  queryState: {
    lead: null as Lead | null,
    tasks: [] as LeadTask[],
    stages: [] as CrmStage[],
    permissions: {} as Record<string, string>,
  },
  idle: () => ({ data: undefined, isLoading: false, isError: false }),
  mutation: (mutate = vi.fn()) => ({ mutate, isPending: false, error: null }),
}));

const NOW = new Date('2026-10-06T14:00:00.000Z');

const lead = (over: Omit<Partial<Lead>, 'work'> & { work?: Partial<Lead['work']> }): Lead => ({
  id: 'l1',
  name: 'Elena',
  email: 'elena@example.com',
  phone: '5511999990000',
  city: null,
  formAnswers: null,
  status: 'new',
  ownerEmployeeId: 'e1',
  firstMessage: null,
  whatsapp: null,
  origin: {
    clientId: 'c1',
    clientName: 'Wings Company',
    clientMapped: false,
    source: 'site_form',
    channel: null,
    landingPage: null,
    campaignId: null,
    campaignName: null,
    formId: null,
    trackingCode: null,
    externalId: null,
  },
  pipeline: 'expansao',
  brand: null,
  valueCents: 4500000,
  expectedCloseAt: null,
  company: null,
  contacts: [],
  crm: null,
  consent: { legalBasis: null, consentedAt: null, source: null, text: null },
  research: {
    state: 'none',
    summary: null,
    score: null,
    criteria: [],
    links: [],
    facts: null,
    error: null,
    updatedAt: null,
    costUsd: 0,
  },
  createdAt: '2026-10-03T12:00:00.000Z',
  updatedAt: '2026-10-03T12:00:00.000Z',
  ...over,
  work: {
    stageId: 's1',
    stage: 'Sem contato',
    stageChangedAt: '2026-10-03T12:00:00.000Z',
    won: null,
    closedAt: null,
    lostReason: null,
    ownerName: 'Eric',
    managedBy: 'wings',
    ...over.work,
  },
});

const stage = (over: Partial<CrmStage>): CrmStage => ({
  id: 's1',
  pipeline: 'expansao',
  name: 'Sem contato',
  position: 1,
  active: true,
  rdStageId: null,
  sofiaEntry: false,
  probability: 10,
  ...over,
});

const firstContact = (over: Partial<LeadTask> = {}): LeadTask => ({
  id: 't1',
  leadId: 'l1',
  leadName: 'Elena',
  leadCompanyName: null,
  kind: 'first_contact',
  title: 'Primeiro contato',
  dueAt: '2026-10-06T15:30:00.000Z',
  doneAt: null,
  assigneeEmployeeId: 'e1',
  assigneeName: 'Eric',
  auto: true,
  createdAt: '2026-10-03T12:00:00.000Z',
  doneByName: null,
  ...over,
});

vi.mock('../../api/auth.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/auth.js')>('../../api/auth.js');
  return {
    ...actual,
    useSession: () => ({
      data: {
        id: 'e1',
        fullName: 'Eric Souza',
        role: 'vendedor_expansao',
        permissions: queryState.permissions,
      },
    }),
  };
});

vi.mock('../../api/leads.js', () => ({
  useLead: () => ({
    isLoading: false,
    isError: false,
    data: queryState.lead && {
      lead: queryState.lead,
      events: [],
      notes: [],
      tasks: queryState.tasks,
      history: [],
      activities: [],
    },
  }),
  useSellers: idle,
  useStages: () => ({ data: { stages: queryState.stages }, isLoading: false, isError: false }),
  useUpdateLead: () => mutation(leadMutate),
  useUpdateTask: () => mutation(taskMutate),
  useAddNote: () => mutation(),
  useCreateTask: () => mutation(),
}));

vi.mock('../../api/crm.js', () => ({
  useUpdateDeal: () => mutation(dealMutate),
  useAddActivity: () => mutation(),
  useBrands: idle,
  useLinkContact: () => mutation(),
  useUnlinkContact: () => mutation(),
  useContacts: idle,
  useCompanies: idle,
}));

vi.mock('./LeadEmailTab.js', () => ({
  LeadEmailTab: () => <div>Aba de e-mail</div>,
}));

const show = () =>
  render(
    <MemoryRouter initialEntries={['/crm-vendas/negociacoes/l1']}>
      <Routes>
        <Route path="/crm-vendas/negociacoes/:id" element={<DealPage />} />
      </Routes>
    </MemoryRouter>,
  );

const selectedTab = () => screen.getByRole('tab', { selected: true }).textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  dealMutate.mockClear();
  taskMutate.mockClear();
  leadMutate.mockClear();
  queryState.permissions = { 'leads.read': 'own', 'leads.write': 'own' };
  queryState.lead = lead({});
  queryState.tasks = [firstContact()];
  queryState.stages = [
    stage({}),
    stage({ id: 's2', name: 'Em contato', position: 2, probability: 30 }),
    stage({ id: 's3', name: 'Proposta', position: 3, probability: 60 }),
  ];
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the name', () => {
  it('is a heading that turns into a field on click; Enter saves the trimmed name', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Renomear Elena' }));
    const field = screen.getByRole('textbox', { name: 'Nome da negociação' }) as HTMLInputElement;
    expect(field.value).toBe('Elena');
    fireEvent.change(field, { target: { value: ' Padaria Sol ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(dealMutate).toHaveBeenCalledWith({ name: 'Padaria Sol' }, expect.anything());
  });

  it('Esc cancels, and a name too short or unchanged is not sent', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Renomear Elena' }));
    const field = screen.getByRole('textbox', { name: 'Nome da negociação' });
    fireEvent.change(field, { target: { value: 'E' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(dealMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Renomear Elena' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome da negociação' }), {
      target: { value: 'Outra' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Nome da negociação' }), {
      key: 'Escape',
    });
    expect(dealMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Renomear Elena' })).toBeTruthy();
  });

  it('is plain text for who cannot write', () => {
    queryState.permissions = { 'leads.read': 'own' };
    show();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Elena');
    expect(screen.queryByRole('button', { name: 'Renomear Elena' })).toBeNull();
    expect(screen.queryByRole('toolbar', { name: 'Ações' })).toBeNull();
  });
});

describe('the tags and the stage bar', () => {
  it('says "Nova" while the first contact is open, with the funnel and the source', () => {
    show();
    const head = within(screen.getByRole('banner'));
    expect(head.getByText('Nova')).toBeTruthy();
    expect(head.getByText('Expansão')).toBeTruthy();
  });

  it('drops "Nova" once the first contact is done', () => {
    queryState.tasks = [firstContact({ doneAt: '2026-10-03T12:30:00.000Z' })];
    show();
    expect(screen.queryByText('Nova')).toBeNull();
    expect(screen.queryByText(/faça o primeiro contato/)).toBeNull();
  });

  it('shows the days in the current stage on its button only, and a click moves the deal', () => {
    show();
    const bar = screen.getByRole('group', { name: 'Etapas' });
    expect(within(bar).getByRole('button', { name: /Sem contato/ }).textContent).toBe(
      'Sem contato · 3 dias',
    );
    fireEvent.click(within(bar).getByRole('button', { name: 'Proposta' }));
    expect(leadMutate).toHaveBeenCalledWith({ stageId: 's3' });
  });

  it('counts whole days: 0 today, 1 dia, N dias', () => {
    expect(daysInStage('2026-10-06T10:00:00.000Z', NOW.getTime())).toBe('0 dias');
    expect(daysInStage('2026-10-05T10:00:00.000Z', NOW.getTime())).toBe('1 dia');
    expect(daysInStage('2026-09-20T10:00:00.000Z', NOW.getTime())).toBe('16 dias');
  });
});

describe('win or lose', () => {
  it('"Marcar perda" asks for the reason before sending', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Marcar perda' }));
    const reason = screen.getByPlaceholderText('Motivo da perda');
    expect(
      (screen.getByRole('button', { name: 'Confirmar perda' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(reason, { target: { value: 'Sem verba' } });
    fireEvent.submit(reason.closest('form')!);
    expect(leadMutate).toHaveBeenCalledWith(
      { won: false, lostReason: 'Sem verba' },
      expect.anything(),
    );
  });

  it('"Marcar venda" sends the win', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Marcar venda' }));
    expect(leadMutate).toHaveBeenCalledWith({ won: true });
  });
});

describe('the action bar', () => {
  it('opens the register tab of each action; WhatsApp and Reunião wait, disabled, "em breve"', () => {
    show();
    const bar = screen.getByRole('toolbar', { name: 'Ações' });
    expect(selectedTab()).toBe('Anotação');
    fireEvent.click(within(bar).getByRole('button', { name: 'Ligação' }));
    expect(selectedTab()).toBe('Ligação');
    expect(
      within(screen.getByRole('tablist').parentElement!).getByRole('button', {
        name: 'Copiar telefone',
      }),
    ).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Tarefa' }));
    expect(selectedTab()).toBe('Tarefa');
    fireEvent.click(within(bar).getByRole('button', { name: 'E-mail' }));
    expect(screen.getByText('Aba de e-mail')).toBeTruthy();
    const whatsapp = within(bar).getByRole('button', { name: 'WhatsApp (em breve)' });
    const meet = within(bar).getByRole('button', { name: 'Reunião (em breve)' });
    expect((whatsapp as HTMLButtonElement).disabled).toBe(true);
    expect((meet as HTMLButtonElement).disabled).toBe(true);
    expect(whatsapp.textContent).toContain('em breve');
  });

  it('"Mais" keeps the meeting already held', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Mais' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Registrar reunião feita' }));
    expect(selectedTab()).toBe('Reunião');
    expect(screen.getByRole('button', { name: 'Registrar reunião' })).toBeTruthy();
  });
});

describe('the first-contact strip', () => {
  it('names the deadline time while the task is open; "Contato feito" closes it', () => {
    show();
    const strip = screen.getByRole('region', { name: 'Primeiro contato' });
    expect(strip.textContent).toContain('Nova negociação: faça o primeiro contato até');
    expect(strip.textContent).toContain(
      new Date('2026-10-06T15:30:00.000Z').toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
    fireEvent.click(within(strip).getByRole('button', { name: 'Ligar' }));
    expect(selectedTab()).toBe('Ligação');
    fireEvent.click(within(strip).getByRole('button', { name: 'Contato feito' }));
    expect(taskMutate).toHaveBeenCalledWith({ taskId: 't1', done: true });
  });

  it('says the deadline passed when it did', () => {
    queryState.tasks = [firstContact({ dueAt: '2026-10-06T13:00:00.000Z' })];
    show();
    expect(screen.getByRole('region', { name: 'Primeiro contato' }).textContent).toContain(
      'o prazo do primeiro contato venceu',
    );
  });

  it('is not shown on a closed deal, and the first contact never lists among the next tasks', () => {
    queryState.lead = lead({ work: { won: true } });
    show();
    expect(screen.queryByRole('region', { name: 'Primeiro contato' })).toBeNull();
    expect(screen.getByText('Nenhuma tarefa aberta.')).toBeTruthy();
  });
});

describe('"Sobre a negociação"', () => {
  const section = () => screen.getByRole('region', { name: 'Sobre a negociação' });
  const about = () => within(section());
  const labels = () => Array.from(section().querySelectorAll('dt')).map((dt) => dt.textContent);

  it('lists the deal fields and every form answer, the answers as given', () => {
    queryState.lead = lead({
      city: 'Niterói',
      formAnswers: {
        Budget: 'R$ 60 mil',
        'Nome da marca': 'Casal do Churros',
        Qualificação: 'Quente',
      },
    });
    show();
    for (const label of [
      'Valor',
      'Previsão',
      'Dono',
      'Funil',
      'Etapa',
      'Empresa',
      'Marca',
      'Cidade',
      'Fonte',
      'Budget',
      'Nome da marca',
      'Qualificação',
      'Criada em',
    ])
      expect(labels()).toContain(label);
    expect(about().getByText('R$ 60 mil')).toBeTruthy();
    expect(about().getByText('Niterói')).toBeTruthy();
    expect(about().getByLabelText('Valor estimado')).toBeTruthy();
    expect(about().getByLabelText('Marca')).toBeTruthy();
  });

  it('"Personalizar" hides a field and moves another up, and the choice survives a reload of the page', () => {
    show();
    fireEvent.click(about().getByRole('button', { name: 'Personalizar' }));
    fireEvent.click(about().getByLabelText('Funil'));
    fireEvent.click(about().getByRole('button', { name: 'Subir Dono' }));
    fireEvent.click(about().getByRole('button', { name: 'Pronto' }));
    expect(labels()).not.toContain('Funil');
    expect(labels().slice(0, 3)).toEqual(['Valor', 'Dono', 'Previsão']);
    cleanup();
    show();
    expect(labels()).not.toContain('Funil');
    expect(labels().slice(0, 3)).toEqual(['Valor', 'Dono', 'Previsão']);
    fireEvent.click(about().getByRole('button', { name: 'Personalizar' }));
    fireEvent.click(about().getByRole('button', { name: 'Voltar ao padrão' }));
    fireEvent.click(about().getByRole('button', { name: 'Pronto' }));
    expect(labels().slice(0, 3)).toEqual(['Valor', 'Previsão', 'Dono']);
  });

  it('keeps a field never seen before (a new form question) at the end of a saved order', () => {
    const fields = [{ key: 'a' }, { key: 'answer:Nova pergunta' }, { key: 'b' }];
    const { shown } = orderFields(fields, { order: ['b', 'a'], hidden: ['a'] });
    expect(shown.map((f) => f.key)).toEqual(['b', 'answer:Nova pergunta']);
  });
});

describe('the contacts', () => {
  it('shows the phone and the e-mail with a copy button each, and the WhatsApp that waits', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    show();
    const contacts = within(screen.getByRole('region', { name: 'Contatos' }));
    fireEvent.click(contacts.getByRole('button', { name: 'Copiar telefone' }));
    expect(writeText).toHaveBeenCalledWith('+5511999990000');
    fireEvent.click(contacts.getByRole('button', { name: 'Copiar e-mail' }));
    expect(writeText).toHaveBeenCalledWith('elena@example.com');
    expect(
      (contacts.getByRole('button', { name: 'WhatsApp (em breve)' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('"+ Adicionar" on the right opens the contact form on the left', () => {
    show();
    const card = within(screen.getByRole('region', { name: 'Contatos: 0' }));
    fireEvent.click(card.getByRole('button', { name: '+ Adicionar' }));
    expect(screen.getByPlaceholderText('Nome')).toBeTruthy();
  });
});

describe('the right column', () => {
  it('counts contacts, the company, proposals and files; proposals and files wait', () => {
    queryState.lead = lead({
      company: { id: 'c1', name: 'Padaria Sol', clientId: null },
      contacts: [
        {
          id: 'k1',
          name: 'Elena',
          email: null,
          phone: '5511999990000',
          jobTitle: 'Sócia',
          primary: true,
        },
        {
          id: 'k2',
          name: 'Paulo',
          email: 'p@example.com',
          phone: null,
          jobTitle: null,
          primary: false,
        },
      ],
    });
    show();
    const cards = screen.getAllByRole('region').filter((r) => r.classList.contains('crm-assoc'));
    const summary = cards.map((c) =>
      c.querySelector('h2 > span')!.textContent!.replace(/\s+/g, ' ').trim(),
    );
    expect(summary).toEqual(['Contatos 2', 'Empresa 1', 'Propostas 0', 'Arquivos 0']);
    expect(within(cards[2]!).getByRole('button', { name: 'em breve' })).toBeTruthy();
    expect(within(cards[3]!).getByRole('button', { name: 'em breve' })).toBeTruthy();
    expect(within(cards[1]!).getByRole('link', { name: 'Padaria Sol' })).toBeTruthy();
  });
});
