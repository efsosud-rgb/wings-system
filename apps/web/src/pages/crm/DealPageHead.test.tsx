import type { CrmStage, Lead, LeadEvent, LeadFile, LeadNote, LeadTask } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { DealPage, daysInStage, orderFields } from './DealPage.js';

/**
 * The deal's page, part 1: the head (name edited in place, tags, win or
 * lose), the stage bar with the days in the current stage, the action bar
 * and the "new deal: first contact until HH:MM" strip.
 */

const {
  dealMutate,
  taskMutate,
  leadMutate,
  summaryMutate,
  askMutate,
  askState,
  nextStepMutate,
  meetingState,
  queryState,
  idle,
  mutation,
} = vi.hoisted(() => ({
  dealMutate: vi.fn(),
  summaryMutate: vi.fn(),
  askMutate: vi.fn(),
  nextStepMutate: vi.fn(),
  meetingState: {
    list: { data: undefined as unknown, isLoading: false, isError: true, error: null as unknown },
    one: { data: undefined as unknown, isLoading: false, isError: false, error: null as unknown },
  },
  askState: {
    data: undefined as { answer: string; model: string } | undefined,
    error: null as unknown,
  },
  taskMutate: vi.fn(),
  leadMutate: vi.fn(),
  queryState: {
    lead: null as Lead | null,
    tasks: [] as LeadTask[],
    stages: [] as CrmStage[],
    permissions: {} as Record<string, string>,
    files: [] as LeadFile[],
    events: [] as LeadEvent[],
    notes: [] as LeadNote[],
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
    ad: null,
    utm: null,
    trafficSource: null,
    conversionIdentifier: null,
  },
  pipeline: 'expansao',
  brand: null,
  valueCents: 4500000,
  expectedCloseAt: null,
  company: null,
  contacts: [],
  crm: null,
  consent: { legalBasis: null, consentedAt: null, source: null, text: null },
  fields: { instagram: null, website: null, companyName: null, cnpj: null },
  checks: {},
  aiSummary: null,
  suspect: null,
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
  enteredAt: '2026-10-03T11:30:00.000Z',
  enteredAtSource: 'meta_created_time',
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
      events: queryState.events,
      notes: queryState.notes,
      tasks: queryState.tasks,
      history: [],
      activities: [],
    },
  }),
  useSellers: idle,
  useStages: () => ({ data: { stages: queryState.stages }, isLoading: false, isError: false }),
  useUpdateLead: () => mutation(leadMutate),
  useUpdateTask: () => mutation(taskMutate),
  useCheckLead: () => mutation(),
  useClearSuspect: () => mutation(),
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
  useLeadFiles: () => ({ data: queryState.files ?? [], isLoading: false, isError: false }),
  useRemoveLeadFile: () => mutation(),
  useSendLeadFile: () => ({ ...mutation(), mutateAsync: vi.fn() }),
  useGenerateSummary: () => mutation(summaryMutate),
  useMeetings: () => meetingState.list,
  useMeeting: () => meetingState.one,
  useNextStepTask: () => mutation(nextStepMutate),
  useCreateMeeting: () => mutation(),
  useUpdateMeeting: () => mutation(),
  useUploadRecording: () => mutation(),
  fetchRecordingLink: vi.fn(),
  useMeetingTranscript: () => ({ data: undefined, isLoading: false, isError: false }),
  useNameSpeakers: () => mutation(),
  useRequestAnalysis: () => mutation(),
  useSummarySend: () => ({
    create: mutation(),
    edit: mutation(),
    approve: mutation(),
    refuse: mutation(),
    send: mutation(),
  }),
  useAskDeal: () => ({ ...mutation(askMutate), data: askState.data, error: askState.error }),
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

const registerTabs = () => screen.getByRole('tablist', { name: 'Registrar' });
const sectionTabs = () => screen.getByRole('tablist', { name: 'Seções da negociação' });
const selectedTab = () => within(registerTabs()).getByRole('tab', { selected: true }).textContent;
const selectedSection = () =>
  within(sectionTabs()).getByRole('tab', { selected: true }).textContent;

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
  it('opens the register tab of each action; Ligação the call panel; WhatsApp the conversation; Reunião its section', () => {
    show();
    const bar = screen.getByRole('toolbar', { name: 'Ações' });
    expect(selectedTab()).toBe('Anotação');
    fireEvent.click(within(bar).getByRole('button', { name: 'Ligação' }));
    const panel = within(screen.getByRole('dialog', { name: 'Ligação' }));
    expect(panel.getByRole('button', { name: 'Copiar número' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Registrar ligação' })).toBeTruthy();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    fireEvent.click(panel.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog', { name: 'Ligação' })).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: 'Tarefa' }));
    expect(selectedTab()).toBe('Tarefa');
    fireEvent.click(within(bar).getByRole('button', { name: 'E-mail' }));
    expect(selectedSection()).toBe('E-mail');
    expect(screen.getByText('Aba de e-mail')).toBeTruthy();
    const whatsapp = within(bar).getByRole('link', { name: 'WhatsApp' });
    expect(whatsapp.getAttribute('href')).toBe('/crm-vendas/negociacoes/l1/whatsapp');
    fireEvent.click(within(bar).getByRole('button', { name: 'Reunião' }));
    expect(selectedSection()).toBe('Reunião');
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
    expect(screen.getByRole('dialog', { name: 'Ligação' })).toBeTruthy();
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
      'Entrou em',
    ])
      expect(labels()).toContain(label);
    expect(about().getByText('R$ 60 mil')).toBeTruthy();
    expect(about().getByText('Niterói')).toBeTruthy();
    expect(about().getByLabelText('Valor estimado')).toBeTruthy();
    expect(about().getByLabelText('Marca')).toBeTruthy();
  });

  it('shows when the deal entered, in Brasília time, right after the source', () => {
    queryState.lead = lead({
      enteredAt: '2026-10-07T17:32:00.000Z',
      enteredAtSource: 'meta_created_time',
    });
    show();
    expect(about().getByText(/07\/10\/2026 às 14:32/)).toBeTruthy();
    expect(about().queryByText(/recebido pelo sistema/)).toBeNull();
    expect(labels().indexOf('Entrou em')).toBe(labels().indexOf('Fonte') + 1);
  });

  it('says "recebido pelo sistema" when the source brought no date', () => {
    queryState.lead = lead({
      enteredAt: '2026-10-07T17:32:00.000Z',
      enteredAtSource: 'received',
    });
    show();
    expect(about().getByText(/recebido pelo sistema/)).toBeTruthy();
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
    expect(contacts.getByRole('link', { name: 'Conversa do WhatsApp' }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1/whatsapp',
    );
    fireEvent.click(contacts.getByRole('button', { name: 'Ligar' }));
    expect(screen.getByRole('dialog', { name: 'Ligação' })).toBeTruthy();
  });

  it('"+ Adicionar" on the right opens the contact form on the left', () => {
    show();
    const card = within(screen.getByRole('region', { name: 'Contatos: 0' }));
    fireEvent.click(card.getByRole('button', { name: '+ Adicionar' }));
    expect(screen.getByPlaceholderText('Nome')).toBeTruthy();
  });
});

describe('the right column', () => {
  it('counts contacts, the company, proposals and files; proposals wait, files open the tab', () => {
    queryState.files = [
      {
        id: 'f1',
        fileId: 'd1',
        name: 'proposta.pdf',
        mimeType: 'application/pdf',
        byteSize: 2048,
        version: 1,
        addedByName: 'Eric',
        createdAt: '2026-10-05T12:00:00.000Z',
      },
    ];
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
    expect(summary).toEqual(['Contatos 2', 'Empresa 1', 'Propostas 0', 'Arquivos 1']);
    expect(within(cards[2]!).getByRole('button', { name: 'em breve' })).toBeTruthy();
    expect(within(cards[1]!).getByRole('link', { name: 'Padaria Sol' })).toBeTruthy();
    fireEvent.click(within(cards[3]!).getByRole('button', { name: 'proposta.pdf' }));
    expect(selectedSection()).toBe('Arquivos');
    expect(screen.getByText('1 arquivo · na pasta Comercial › Negociações do Drive')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remover proposta.pdf da negociação' })).toBeTruthy();
  });
});

describe('the form line in Origem', () => {
  it('says when the person filled the form, for Meta and TikTok leads only', () => {
    const consent = {
      legalBasis: 'consent' as const,
      consentedAt: '2026-10-03T12:00:00.000Z',
      source: 'meta_lead_ads',
      text: null,
    };
    const whenFilled = `Preencheu o formulário em ${new Date(consent.consentedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`;
    queryState.lead = lead({ consent, origin: { ...lead({}).origin, source: 'meta_lead_ads' } });
    show();
    expect(screen.getByText(whenFilled)).toBeTruthy();
    cleanup();
    queryState.lead = lead({ consent, origin: { ...lead({}).origin, source: 'tiktok_lead_ads' } });
    show();
    expect(screen.getByText(whenFilled)).toBeTruthy();
    cleanup();
    queryState.lead = lead({ consent, origin: { ...lead({}).origin, source: 'site_form' } });
    show();
    expect(screen.queryByText(whenFilled)).toBeNull();
  });
});

describe('the AI summary', () => {
  it('shows "—" and "Ainda não gerado." until asked; "Gerar resumo" asks', () => {
    show();
    const panel = within(screen.getByRole('region', { name: 'Resumo da IA' }));
    expect(panel.getByText('Ainda não gerado.')).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Gerar resumo' }));
    expect(summaryMutate).toHaveBeenCalled();
  });

  it('shows the text, when it was made and what it came from; "Atualizar" asks again', () => {
    queryState.lead = lead({
      aiSummary: {
        text: 'Em aberto na etapa inicial. Quer abrir em Niterói.',
        generatedAt: '2026-10-06T13:00:00.000Z',
        model: 'anthropic/claude-sonnet-5',
        basedOn: { events: 4, answers: 2 },
      },
    });
    show();
    const panel = within(screen.getByRole('region', { name: 'Resumo da IA' }));
    expect(panel.getByText('Em aberto na etapa inicial. Quer abrir em Niterói.')).toBeTruthy();
    expect(panel.getByText(/com base em 4 registros e 2 respostas/).textContent).toContain(
      `Gerado em ${new Date('2026-10-06T13:00:00.000Z').toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`,
    );
    expect(panel.getByRole('button', { name: 'Atualizar' })).toBeTruthy();
  });

  it('"Faça uma pergunta" sends the question and shows the answer', () => {
    askState.data = { answer: 'Não consta no registro.', model: 'x' };
    show();
    const panel = within(screen.getByRole('region', { name: 'Resumo da IA' }));
    fireEvent.click(panel.getByRole('button', { name: 'Faça uma pergunta' }));
    fireEvent.change(panel.getByLabelText('Pergunta sobre a negociação'), {
      target: { value: 'Ela já tem ponto?' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'Perguntar' }));
    expect(askMutate).toHaveBeenCalledWith('Ela já tem ponto?');
    expect(panel.getByRole('status').textContent).toBe('Não consta no registro.');
    askState.data = undefined;
  });
});

describe('the Reunião section', () => {
  it('offers Agendar, keeps Iniciar off without a meeting, shows "—" with the reason while the API is off, and the Cliente field on Expansão', () => {
    meetingState.list = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError(404, { error: 'not_found', message: 'x' }),
    };
    show();
    fireEvent.click(within(sectionTabs()).getByRole('tab', { name: 'Reunião' }));
    const body = within(sectionTabs().parentElement!);
    expect(
      (body.getByRole('button', { name: /Agendar reunião/ }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (body.getByRole('button', { name: /Iniciar reunião/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(body.getByText('A API de reuniões ainda não está ligada.')).toBeTruthy();
    expect(body.getByText('Cliente (marca franqueadora)')).toBeTruthy();
    expect(body.getByLabelText('Marca')).toBeTruthy();
    fireEvent.click(body.getByRole('button', { name: 'Registrar reunião feita' }));
    expect(selectedTab()).toBe('Reunião');
  });

  it('shows, for a meeting that ended, the summary, participants, topics, next steps (each a task on a click) and the evaluation', () => {
    meetingState.list = {
      data: [
        {
          id: 'm1',
          leadId: 'l1',
          title: 'Diagnóstico',
          startsAt: '2026-10-05T14:00:00.000Z',
          endsAt: '2026-10-05T15:00:00.000Z',
          status: 'encerrada',
          calendar: 'vendedor',
          meetUrl: 'https://meet.google.com/abc-defg-hij',
          ownerEmployeeId: 'e1',
          recordingState: 'guardada',
          transcriptState: 'pronta',
          analysisState: 'pronta',
          summarySendState: 'nenhum',
        },
      ],
      isLoading: false,
      isError: false,
      error: null,
    };
    meetingState.one = {
      data: {
        ...(meetingState.list.data as unknown[])[0]!,
        attendees: [{ email: 'p@example.com', name: 'Paulo', responseStatus: 'aceitou' }],
        googleEventId: null,
        recording: { state: 'guardada', fileId: 'f', durationSeconds: 100, sizeBytes: 10 },
        transcript: { state: 'pronta', segments: 10, error: null },
        analysis: {
          state: 'pronta',
          summary: 'Conversa sobre o modelo quiosque.',
          topics: ['Faturamento', 'Prazo de abertura'],
          participants: [{ speaker: 'S2', role: 'cliente', suggestedName: 'Paulo' }],
          nextSteps: [
            { what: 'Enviar proposta', owner: 'vendedor', dueAt: '2026-10-10', taskId: null },
            { what: 'Falar com o sócio', owner: 'cliente', dueAt: null, taskId: 't9' },
          ],
          leadEvaluation: { score: 72, fit: 'bom', reasons: ['Tem capital'], risks: ['Sócio'] },
          model: 'anthropic/claude-sonnet-5',
          costUsd: 0.01,
          analyzedAt: '2026-10-05T15:20:00.000Z',
          reason: null,
        },
        summarySend: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
      isLoading: false,
      isError: false,
      error: null,
    };
    window.open = vi.fn();
    show();
    fireEvent.click(within(sectionTabs()).getByRole('tab', { name: 'Reunião' }));
    const body = within(sectionTabs().parentElement!);
    expect(body.getByText('1 reunião')).toBeTruthy();
    fireEvent.click(body.getByRole('button', { name: 'Abrir o Meet ao lado' }));
    expect(window.open).toHaveBeenCalledWith(
      'https://meet.google.com/abc-defg-hij',
      'wings-meet',
      expect.stringContaining('popup'),
    );
    fireEvent.click(body.getByRole('button', { name: 'Diagnóstico' }));
    expect(body.getByText('Conversa sobre o modelo quiosque.')).toBeTruthy();
    expect(body.getByText(/Paulo · aceitou/)).toBeTruthy();
    expect(body.getByText('Faturamento')).toBeTruthy();
    expect(body.getByText(/Enviar proposta · vendedor · até 10\/10\/2026/)).toBeTruthy();
    expect(body.getByText('já é tarefa')).toBeTruthy();
    fireEvent.click(body.getByRole('button', { name: 'Virar tarefa' }));
    expect(nextStepMutate).toHaveBeenCalledWith(0);
    expect(body.getByText('72/100')).toBeTruthy();
    expect(body.getByText(/Riscos: Sócio/)).toBeTruthy();
    meetingState.list = { data: undefined, isLoading: false, isError: true, error: null };
  });
});

describe('the sections in the centre', () => {
  beforeEach(() => {
    queryState.notes = [
      { id: 'n1', at: '2026-10-04T10:00:00.000Z', authorName: 'Eric', body: 'Ligar amanhã' },
    ];
    queryState.events = [
      {
        id: 'ev1',
        at: '2026-10-03T12:00:00.000Z',
        kind: 'lead.received.meta_lead_ads',
        detail: {},
      },
      {
        id: 'ev2',
        at: '2026-10-05T09:00:00.000Z',
        kind: 'lead.file_added',
        detail: { fileId: 'd1' },
      },
    ];
    queryState.tasks = [
      firstContact(),
      firstContact({
        id: 't2',
        kind: 'follow_up',
        title: 'Enviar proposta',
        dueAt: '2026-10-08T12:00:00.000Z',
        auto: false,
      }),
      firstContact({
        id: 't3',
        kind: 'follow_up',
        title: 'Mandar material',
        dueAt: '2026-10-02T12:00:00.000Z',
        auto: false,
        doneAt: '2026-10-02T13:00:00.000Z',
        doneByName: 'Eric',
      }),
    ];
  });

  it('opens on Histórico and filters the timeline by kind', () => {
    show();
    expect(selectedSection()).toBe('Histórico');
    const filter = within(screen.getByRole('group', { name: 'Filtrar histórico' }));
    expect(filter.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Tudo',
      'Anotações',
      'Tarefas',
      'Arquivos',
      'Sistema',
    ]);
    expect(screen.getByText('Ligar amanhã')).toBeTruthy();
    expect(screen.getByText('Arquivo adicionado')).toBeTruthy();
    fireEvent.click(filter.getByRole('button', { name: 'Anotações' }));
    expect(screen.getByText('Ligar amanhã')).toBeTruthy();
    expect(screen.queryByText('Arquivo adicionado')).toBeNull();
    expect(screen.queryByText('Chegou pelo Meta Lead Ads')).toBeNull();
    fireEvent.click(filter.getByRole('button', { name: 'Anotações' }));
    expect(screen.getByText('Chegou pelo Meta Lead Ads')).toBeTruthy();
  });

  it('Tarefas lists the open ones with a checkbox and the done ones after; "Criar tarefa" opens the form', () => {
    show();
    fireEvent.click(within(sectionTabs()).getByRole('tab', { name: 'Tarefas' }));
    const body = within(sectionTabs().parentElement!);
    expect(body.getByText('2 abertas · 1 concluída')).toBeTruthy();
    fireEvent.click(body.getByRole('checkbox', { name: 'Concluir Enviar proposta' }));
    expect(taskMutate).toHaveBeenCalledWith({ taskId: 't2', done: true });
    expect(body.getByText(/concluída 02\/10\/2026/)).toBeTruthy();
    fireEvent.click(body.getByRole('button', { name: 'Criar tarefa' }));
    expect(selectedTab()).toBe('Tarefa');
  });

  it('Questionários shows the answers as they came, or says there are none', () => {
    queryState.lead = lead({
      formAnswers: { Budget: 'R$ 100 mil', 'Já trabalha com franquia': 'Não' },
      firstMessage: 'Quero saber mais',
    });
    show();
    fireEvent.click(within(sectionTabs()).getByRole('tab', { name: 'Questionários' }));
    const answers = within(screen.getByLabelText('Respostas do formulário'));
    expect(answers.getByText('Budget')).toBeTruthy();
    expect(answers.getByText('R$ 100 mil')).toBeTruthy();
    expect(screen.getAllByText('Quero saber mais').length).toBeGreaterThan(0);
    cleanup();
    queryState.lead = lead({});
    show();
    fireEvent.click(within(sectionTabs()).getByRole('tab', { name: 'Questionários' }));
    expect(screen.getByText('Nenhum questionário respondido por esta pessoa.')).toBeTruthy();
  });

  it('Propostas waits, disabled, "em breve"', () => {
    show();
    const tab = within(sectionTabs()).getByRole('tab', { name: 'Propostas (em breve)' });
    expect((tab as HTMLButtonElement).disabled).toBe(true);
  });
});
