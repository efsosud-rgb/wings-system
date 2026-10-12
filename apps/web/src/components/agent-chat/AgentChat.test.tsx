import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AgentCampaignProposalCard,
  AgentChangeProposalCard,
  AgentChatMessage,
  AgentGenerationProposalCard,
  AgentSendMessageInput,
  AgentStatusResponse,
  AgentStreamEvent,
  AgentTimelineEditProposalCard,
  MediaGeneration,
  StudioTimelineSnapshot,
} from '@wings/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The panel is tested against a scripted stream: the test decides which events
 * arrive and when. No test here reaches the API, let alone a model.
 */

const status = { current: null as AgentStatusResponse | null };
/** When set, that read fails with this error and holds no data. */
const failure: { status?: unknown; conversations?: unknown; conversation?: unknown } = {};
/** Earlier conversations the picker lists. */
const earlier: { current: { id: string; title: string }[] } = { current: [] };
const failed = (error: unknown) => ({
  data: undefined,
  isLoading: false,
  isError: true,
  error,
  refetch: vi.fn(),
});
const markApplied = vi.fn();
const requestFromProposal = vi.fn();
const requestState = { error: null as Error | null };

/** The stream under the test's control. */
let emit: (event: AgentStreamEvent) => void = () => undefined;
let finish: () => void = () => undefined;
/** The connection drops: the stream rejects without a `done`. */
let drop: (error: Error) => void = () => undefined;
const sent: AgentSendMessageInput[] = [];
const streamAgentMessage = vi.fn(
  (
    input: AgentSendMessageInput,
    onEvent: (event: AgentStreamEvent) => void,
    signal?: AbortSignal,
  ) => {
    sent.push(input);
    emit = onEvent;
    return new Promise<void>((resolve, reject) => {
      finish = resolve;
      drop = reject;
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  },
);

vi.mock('../../api/agent.js', async (original) => ({
  ...(await original<typeof import('../../api/agent.js')>()),
  useAgentStatus: () =>
    failure.status ? failed(failure.status) : { data: status.current, isLoading: false },
  useAgentConversations: () =>
    failure.conversations
      ? failed(failure.conversations)
      : { data: { conversations: earlier.current } },
  useAgentConversation: () =>
    failure.conversation ? failed(failure.conversation) : { data: undefined, isLoading: false },
  useMarkProposalApplied: () => ({ mutate: markApplied, isError: false }),
  useRequestFromProposal: () => ({
    mutate: requestFromProposal,
    isPending: false,
    isError: requestState.error !== null,
    error: requestState.error,
  }),
  streamAgentMessage: (...args: Parameters<typeof streamAgentMessage>) =>
    streamAgentMessage(...args),
}));

/**
 * The card's own mutations run for real; only the request leaves the test. Each
 * POST waits for the test to answer it, so a test can finish a reply while a
 * click is still on its way.
 */
type Pending = { resolve: (body: unknown) => void; reject: (error: unknown) => void };
const posted: { path: string; body: unknown; answer: Pending }[] = [];
const apiPost = vi.fn(
  (path: string, body?: unknown) =>
    new Promise((resolve, reject) => posted.push({ path, body, answer: { resolve, reject } })),
);
vi.mock('../../api/client.js', async (original) => {
  const real = await original<typeof import('../../api/client.js')>();
  return {
    ...real,
    api: { ...real.api, post: (path: string, body?: unknown) => apiPost(path, body) },
  };
});
const generationPosts = () => posted.filter((item) => item.path === '/media/generations');

const followed = { current: null as MediaGeneration | null };
const followError = { current: null as unknown };
vi.mock('../../api/media.js', async (original) => ({
  ...(await original<typeof import('../../api/media.js')>()),
  useGeneration: (id: string | undefined) => ({
    data: id && followed.current ? { generation: followed.current } : undefined,
    isError: Boolean(followError.current),
    error: followError.current,
    refetch: vi.fn(),
  }),
}));

const { AgentChat } = await import('./AgentChat.js');
const { TimelineEditContext } = await import('./ProposalCards.js');
const { createSseParser } = await import('../../api/agent.js');
const { ApiError } = await import('../../api/client.js');

function renderChat(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const usage = { spentMicroUsd: 120_000, limitMicroUsd: 2_000_000, exhausted: false };

const campaignCard: AgentCampaignProposalCard = {
  id: 'prop-1',
  kind: 'campaign',
  status: 'open',
  createdAt: '2026-09-21T12:00:00.000Z',
  approvalId: null,
  payload: {
    platform: 'google_search',
    name: 'Pesquisa — franquia SP',
    objective: 'lead',
    idealCustomerProfile: 'Empresário dono de negócio que quer expandir por franquias.',
    reach: { states: ['SP'], cities: [], customLocations: [] },
    destinationUrl: 'https://wingscompany.com.br/franquia',
    utms: {
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'pesquisa-franquia-sp',
      utm_content: 'lead',
    },
    dailyBudgetCents: 3000,
    startDate: '2026-09-22',
    endDate: '2026-09-28',
    copy: [],
    search: {
      keywords: [
        { text: 'franquia de alimentação', match: 'phrase' },
        { text: 'abrir franquia', match: 'exact' },
        { text: 'como franquear meu negócio', match: 'broad' },
      ],
      negativeKeywords: ['grátis', 'vaga', 'emprego', 'curso', 'currículo'],
      headlines: ['Franquia Wings'],
      descriptions: ['Conheça o modelo de negócio.'],
    },
    explanations: [{ field: 'dailyBudgetCents', reason: 'Cabe no disponível de R$ 469,88.' }],
    assumptions: ['Assumi que a página de destino já tem o formulário.'],
    summary: 'Campanha de pesquisa para leads em São Paulo.',
  },
  pending: [],
};

const metaCard: AgentCampaignProposalCard = {
  ...campaignCard,
  id: 'prop-3',
  payload: {
    ...campaignCard.payload,
    platform: 'meta',
    name: 'Leads RJ — Instagram',
    search: undefined,
    ageMin: 30,
    ageMax: 55,
    formatKey: 'feed_vertical',
    placements: { mode: 'manual', facebook: [], instagram: ['feed', 'stories'], threads: [] },
    budgetNote:
      'R$ 20,00 por dia fica abaixo do que o CPL de R$ 30,00 pede para 10 leads por semana.',
    copy: [
      {
        headline: 'Leve sua marca para outras cidades',
        primaryText: 'A Wings formata o seu negócio para virar franquia.',
        callToAction: 'LEARN_MORE',
        mediaBrief: 'Dono de restaurante na porta da loja, fachada ao fundo, luz do dia.',
      },
      {
        headline: 'Seu negócio pronto para franquear',
        primaryText: 'Processos, manuais e suporte para expandir.',
        callToAction: 'CONTACT_US',
        mediaBrief: 'Mesa com manuais da franquia abertos e duas pessoas conversando.',
      },
    ],
  },
  pending: ['Imagens ou vídeo de cada variação', 'Página do Facebook e conta do Instagram'],
};

const changeCard: AgentChangeProposalCard = {
  id: 'prop-2',
  kind: 'change',
  status: 'open',
  createdAt: '2026-09-21T12:00:00.000Z',
  approvalId: null,
  campaignName: 'LEAD | FORMS',
  platform: 'meta',
  currentDailyBudgetCents: 5000,
  requestable: true,
  notRequestableReason: null,
  payload: {
    kind: 'set_daily_budget',
    campaignExternalId: '2385',
    toDailyBudgetCents: 3000,
    justification: 'O CPL dobrou em sete dias sem aumento de leads.',
    evidence: [{ label: 'CPL 7 dias', value: 'R$ 84,10' }],
  },
};

function assistant(overrides: Partial<AgentChatMessage> = {}): AgentChatMessage {
  return {
    id: 'msg-2',
    role: 'assistant',
    content: 'O CPL da semana foi R$ 42,00.',
    createdAt: '2026-09-21T12:00:01.000Z',
    consulted: [],
    proposals: [],
    notice: null,
    retryable: false,
    ...overrides,
  };
}

async function say(text: string) {
  fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  await waitFor(() => expect(streamAgentMessage).toHaveBeenCalled());
}

function stream(...events: AgentStreamEvent[]) {
  act(() => {
    for (const event of events) emit(event);
  });
}

async function close() {
  await act(async () => {
    finish();
    await Promise.resolve();
  });
}

beforeEach(() => {
  status.current = { configured: true, usage };
  for (const key of Object.keys(failure)) delete failure[key as keyof typeof failure];
  earlier.current = [];
  requestState.error = null;
  sent.length = 0;
  streamAgentMessage.mockClear();
  markApplied.mockClear();
  apiPost.mockClear();
  posted.length = 0;
  followed.current = null;
  followError.current = null;
  requestFromProposal.mockClear();
});

afterEach(() => cleanup());

describe('a reply as it is written', () => {
  it('shows the text as it arrives, then the finished message', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('Como foi o CPL da semana?');

    expect(screen.getByText('Como foi o CPL da semana?')).toBeTruthy();
    expect(screen.getByText('Escrevendo…')).toBeTruthy();
    // Nothing else can be sent while this one is being answered.
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Parar' })).toBeTruthy();

    stream(
      { type: 'conversation', conversationId: 'conv-1', title: 'CPL', userMessageId: 'msg-1' },
      { type: 'consulting', tool: 'desempenho_campanhas', label: 'Desempenho das campanhas' },
    );
    expect(screen.getByText('Consultando: Desempenho das campanhas…')).toBeTruthy();

    stream({ type: 'delta', text: 'O CPL da ' }, { type: 'delta', text: 'semana' });
    expect(screen.getByText('O CPL da semana')).toBeTruthy();
    expect(screen.queryByText(/Consultando/)).toBeNull();

    stream({ type: 'done', message: assistant(), usage: { ...usage, spentMicroUsd: 140_000 } });
    await close();
    expect(screen.getByText('O CPL da semana foi R$ 42,00.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Parar' })).toBeNull();
  });

  it('sends the tab and the builder draft with the message, and keeps the conversation', async () => {
    renderChat(
      <AgentChat canRequest tab="paid" getBuilderDraft={() => ({ name: 'Rascunho aberto' })} />,
    );
    await say('Olá');
    expect(sent[0]).toEqual({
      conversationId: undefined,
      message: 'Olá',
      context: { tab: 'paid', draft: { name: 'Rascunho aberto' } },
    });

    stream(
      { type: 'conversation', conversationId: 'conv-1', title: 'Olá', userMessageId: 'msg-1' },
      { type: 'done', message: assistant(), usage },
    );
    await close();
    streamAgentMessage.mockClear();
    await say('E ontem?');
    expect(sent[1]?.conversationId).toBe('conv-1');
  });

  it('lists what was consulted, and hides the list when nothing was', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('Tem alerta aberto?');
    stream({
      type: 'done',
      usage,
      message: assistant({
        consulted: [
          { tool: 'alertas_abertos', label: 'Alertas abertos', summary: '2 alertas' },
          { tool: 'estado_da_conta', label: 'Conta, tetos e saldo', summary: 'Meta e Google' },
        ],
      }),
    });
    await close();

    expect(screen.getByText('O que consultei')).toBeTruthy();
    expect(screen.getByText('Alertas abertos')).toBeTruthy();
    expect(screen.getByText('2 alertas')).toBeTruthy();

    cleanup();
    renderChat(<AgentChat canRequest tab="paid" />);
    streamAgentMessage.mockClear();
    await say('Oi');
    stream({ type: 'done', usage, message: assistant() });
    await close();
    expect(screen.queryByText('O que consultei')).toBeNull();
  });

  it('never shows an empty line under "O que consultei"', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('Como está a conta?');
    stream({
      type: 'done',
      usage,
      message: assistant({
        consulted: [
          // The label did not come: the shared name of the tool stands in.
          { tool: 'estado_da_conta', label: '', summary: 'meta: R$ 1.750,00 disponíveis' },
          { tool: 'perfil_cliente_ideal', summary: '' } as never,
          // Nothing to say at all: not an entry.
          { tool: '', label: '', summary: '' } as never,
          {} as never,
        ],
      }),
    });
    await close();

    const items = screen.getByText('O que consultei').closest('details')?.querySelectorAll('li');
    expect([...(items ?? [])].map((item) => item.textContent)).toEqual([
      'Conta, tetos e saldometa: R$ 1.750,00 disponíveis',
      'Perfil de cliente ideal salvo',
    ]);
    for (const item of items ?? []) {
      for (const span of item.querySelectorAll('span')) expect(span.textContent).not.toBe('');
    }
  });

  it('stops on "Parar", keeps what was written and takes the next message', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('Resumo do mês');
    stream({ type: 'delta', text: 'Em setembro' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Parar' })).toBeNull());
    expect(screen.getByText('Em setembro')).toBeTruthy();
    expect(screen.getByText('Resposta interrompida.')).toBeTruthy();
    // Stopping is not a failure.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
  });

  it('offers "Tentar de novo" when the connection drops, and asks again with the same words', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('Monte uma campanha no RJ');
    stream(
      { type: 'conversation', conversationId: 'conv-9', title: 'RJ', userMessageId: 'msg-1' },
      { type: 'delta', text: 'Proponho uma campanha se tiver um perfil mais' },
    );
    await act(async () => {
      drop(new TypeError('network error'));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByText('Resposta interrompida.')).toBeTruthy());
    expect(screen.getByText('Proponho uma campanha se tiver um perfil mais')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Tentar de novo' });

    fireEvent.click(retry);
    await waitFor(() => expect(streamAgentMessage).toHaveBeenCalledTimes(2));
    expect(sent[1]).toMatchObject({
      conversationId: 'conv-9',
      message: 'Monte uma campanha no RJ',
    });
    // The words are on screen once, and the button waits while the new reply is written.
    expect(screen.getAllByText('Monte uma campanha no RJ')).toHaveLength(1);
    expect(
      (screen.getByRole('button', { name: 'Tentar de novo' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    stream({ type: 'done', usage, message: assistant({ content: 'Agora sim.' }) });
    await close();
    expect(screen.getByText('Agora sim.')).toBeTruthy();
    // Only the last reply can be asked again.
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });

  it('keeps something to ask again from even when the stream died before a single event', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('Oi');
    await act(async () => {
      drop(new TypeError('network error'));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText('Resposta interrompida.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
  });

  it('offers it for a reply the server marked as worth asking again, never for the ceiling', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('Resumo');
    stream({
      type: 'done',
      usage,
      message: assistant({
        content: 'O gasto foi',
        notice: 'A resposta foi cortada antes do fim.',
        retryable: true,
      }),
    });
    await close();
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();

    cleanup();
    renderChat(<AgentChat canRequest tab="paid" />);
    streamAgentMessage.mockClear();
    await say('Mais uma');
    stream({
      type: 'done',
      usage: { ...usage, exhausted: true },
      message: assistant({
        content: '',
        notice: 'Você atingiu o limite diário de uso do agente.',
        retryable: false,
      }),
    });
    await close();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });

  it('keeps what was written when the stream fails, and says it was cut short', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('Resumo do mês');
    stream(
      { type: 'delta', text: 'Até aqui' },
      { type: 'error', code: 'provider_error', message: 'O provedor não respondeu.' },
    );
    await close();
    expect(screen.getByText('Até aqui')).toBeTruthy();
    expect(screen.getByText('Resposta interrompida.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('O provedor não respondeu.');
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
  });
});

describe('a campaign proposal', () => {
  it('fills the builder only on the click, and records it', async () => {
    const onApplyCampaign = vi.fn();
    renderChat(<AgentChat canRequest tab="paid" onApplyCampaign={onApplyCampaign} />);
    await say('Monte uma campanha de pesquisa');
    stream({ type: 'done', usage, message: assistant({ proposals: [campaignCard] }) });
    await close();

    expect(screen.getByText('Campanha de pesquisa para leads em São Paulo.')).toBeTruthy();
    expect(screen.getByText('Google Pesquisa')).toBeTruthy();
    expect(screen.getByText(/R\$\s30,00/)).toBeTruthy();
    expect(screen.getByText('Cabe no disponível de R$ 469,88.')).toBeTruthy();
    // A card on screen is only a card.
    expect(onApplyCampaign).not.toHaveBeenCalled();
    expect(markApplied).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Aplicar no construtor' }));
    expect(onApplyCampaign).toHaveBeenCalledTimes(1);
    expect(onApplyCampaign).toHaveBeenCalledWith(campaignCard.payload, []);
    expect(markApplied).toHaveBeenCalledWith('prop-1');
    expect(screen.getByText('Aplicada no construtor')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aplicar de novo' })).toBeTruthy();
  });

  it('shows the whole proposal: briefs for Design, assumptions and what is pending', async () => {
    const onApplyCampaign = vi.fn();
    renderChat(<AgentChat canRequest tab="paid" onApplyCampaign={onApplyCampaign} />);
    await say('Monte uma campanha de leads no RJ');
    stream({ type: 'done', usage, message: assistant({ proposals: [metaCard] }) });
    await close();

    const card = screen.getByRole('article', { name: /Leads RJ — Instagram/ });
    const text = card.textContent ?? '';
    expect(text).toContain('30 a 55 anos');
    expect(text).toContain('Instagram: Feed, Stories');
    expect(text).toContain('Feed vertical');
    expect(text).toContain('(7 dias)');
    expect(text).toContain('SP (estado todo)');
    expect(text).toContain('google / cpc / pesquisa-franquia-sp / lead');
    expect(text).toContain('Briefing para o Design');
    expect(text).toContain('Dono de restaurante na porta da loja');
    expect(text).toContain('Botão: Saiba mais');
    expect(text).toContain('abaixo do que o CPL de R$ 30,00 pede');
    expect(text).toContain('Premissas');
    expect(text).toContain('Assumi que a página de destino já tem o formulário.');
    expect(text).toContain('Pendente');
    expect(text).toContain('Página do Facebook e conta do Instagram');

    fireEvent.click(screen.getByRole('button', { name: 'Aplicar no construtor' }));
    expect(onApplyCampaign).toHaveBeenCalledWith(metaCard.payload, metaCard.pending);
  });

  it('writes Google keywords with their match type', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('Monte uma campanha de pesquisa');
    stream({ type: 'done', usage, message: assistant({ proposals: [campaignCard] }) });
    await close();
    expect(
      screen.getByText('"franquia de alimentação" · [abrir franquia] · como franquear meu negócio'),
    ).toBeTruthy();
    expect(screen.getByText('grátis · vaga · emprego · curso · currículo')).toBeTruthy();
  });

  it('offers no button where there is no builder to fill', async () => {
    renderChat(<AgentChat canRequest tab="owned" />);
    await say('Monte uma campanha');
    stream({ type: 'done', usage, message: assistant({ proposals: [campaignCard] }) });
    await close();
    expect(screen.queryByRole('button', { name: 'Aplicar no construtor' })).toBeNull();
    expect(screen.getByText('Abra a aba Mídia paga para aplicar.')).toBeTruthy();
  });
});

describe('a change proposal', () => {
  async function showChange(card: AgentChangeProposalCard, canRequest = true) {
    renderChat(<AgentChat canRequest={canRequest} tab="paid" />);
    await say('O que você mudaria?');
    stream({ type: 'proposal', proposal: card });
    stream({ type: 'done', usage, message: assistant({ proposals: [card] }) });
    await close();
  }

  it('creates the request only on the click, and then points at it', async () => {
    await showChange(changeCard);
    expect(screen.getByText('Mudar a verba diária')).toBeTruthy();
    expect(screen.getByText('LEAD | FORMS')).toBeTruthy();
    expect(screen.getByText(/De R\$\s50,00 para R\$\s30,00 por dia/)).toBeTruthy();
    expect(screen.getByText('R$ 84,10')).toBeTruthy();
    expect(requestFromProposal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Criar pedido' }));
    expect(requestFromProposal).toHaveBeenCalledTimes(1);
    expect(requestFromProposal.mock.calls[0]?.[0]).toBe('prop-2');

    // The API answers: the card now shows where the request is.
    const options = requestFromProposal.mock.calls[0]?.[1] as {
      onSuccess: (result: { proposal: AgentChangeProposalCard; approvalId: string }) => void;
    };
    act(() => options.onSuccess({ proposal: changeCard, approvalId: 'ap-9' }));
    expect(screen.getByText(/Pedido criado, aguardando aprovação/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ver o pedido' }).getAttribute('href')).toBe(
      '/marketing/trafego-pago-wings/aprovacoes/ap-9',
    );
    expect(screen.queryByRole('button', { name: 'Criar pedido' })).toBeNull();
  });

  it('hides the button from someone who may not ask for changes', async () => {
    await showChange(changeCard, false);
    expect(screen.queryByRole('button', { name: 'Criar pedido' })).toBeNull();
    expect(screen.getByText('Você não tem permissão para pedir alterações.')).toBeTruthy();
  });

  it('says why when the system has no request of that kind', async () => {
    await showChange({
      ...changeCard,
      requestable: false,
      notRequestableReason: 'Negativar termo é feito à mão no Google Ads.',
      payload: { ...changeCard.payload, kind: 'add_negative_keyword', term: 'grátis' },
    });
    expect(screen.queryByRole('button', { name: 'Criar pedido' })).toBeNull();
    expect(screen.getByText('Negativar termo é feito à mão no Google Ads.')).toBeTruthy();
    expect(screen.getByText('grátis')).toBeTruthy();
  });

  it('shows the refusal of the budget guard beside the card', async () => {
    requestState.error = new Error('A alteração ultrapassa o teto mensal desta conta.');
    await showChange(changeCard);
    expect(screen.getByRole('alert').textContent).toBe(
      'A alteração ultrapassa o teto mensal desta conta.',
    );
  });
});

describe('limits of the panel', () => {
  it('stops taking messages at the daily ceiling, and says so', () => {
    status.current = {
      configured: true,
      usage: { spentMicroUsd: 2_010_000, limitMicroUsd: 2_000_000, exhausted: true },
    };
    renderChat(<AgentChat canRequest tab="paid" />);
    expect(screen.getByText(/O teto de uso de hoje \(US\$\s2,00\) foi atingido/)).toBeTruthy();
    expect((screen.getByLabelText('Mensagem') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/Uso de hoje: US\$\s2,01 de US\$\s2,00/)).toBeTruthy();
  });

  it('shows the notice of a reply that was cut by the ceiling', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('Mais uma');
    stream({
      type: 'done',
      usage: { ...usage, exhausted: true },
      message: assistant({ content: '', notice: 'O teto diário de uso do agente foi atingido.' }),
    });
    await close();
    expect(screen.getByText('O teto diário de uso do agente foi atingido.')).toBeTruthy();
  });

  it('takes no message while the agent is not configured', () => {
    status.current = { configured: false, usage };
    renderChat(<AgentChat canRequest tab="paid" />);
    expect(screen.getByText('O agente ainda não está configurado neste ambiente.')).toBeTruthy();
    expect(screen.queryByLabelText('Mensagem')).toBeNull();
  });

  it('always says that the agent only reads and proposes', () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    expect(screen.getByText(/O agente só lê e propõe/)).toBeTruthy();
  });

  it('sends on Enter and breaks the line on Shift + Enter', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    const field = screen.getByLabelText('Mensagem');
    fireEvent.change(field, { target: { value: 'Oi' } });
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(streamAgentMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(streamAgentMessage).toHaveBeenCalledTimes(1));
  });
});

const generationCard: AgentGenerationProposalCard = {
  id: 'prop-gen-1',
  kind: 'generation',
  status: 'open',
  createdAt: '2026-09-21T12:00:00.000Z',
  approvalId: null,
  generationId: null,
  clientName: 'Padaria Aurora',
  estimate: {
    id: 'est-1',
    credits: 4,
    brlCents: 0,
    providerId: 'kairogen',
    expiresAt: '2026-09-21T12:15:00.000Z',
  },
  payload: {
    clientId: '11111111-1111-4111-8111-1111111111c2',
    kind: 'image',
    provider: 'kairogen',
    model: 'seedream-v4',
    prompt:
      'Advertising photograph of a small business owner in front of a storefront at golden hour, 50mm, shallow depth of field.',
    explanation:
      'Dono de loja em frente ao negócio, luz de fim de tarde, espaço livre no alto para o título.',
    aspect: '4:5',
    quantity: 1,
    params: { quality: 'medium' },
    referenceUse: 'reference',
    textInImage: null,
  },
};

const unknownGeneration: MediaGeneration = {
  id: 'gen-1',
  status: 'unknown',
  operation: 'generate',
  kind: 'image',
  model: 'seedream-v4',
  providerId: 'kairogen',
  prompt: null,
  brlCentsEstimated: 0,
  creditsEstimated: 4,
  creditsCharged: null,
  detail: 'O Kairogen não respondeu se recebeu o pedido.',
  requestedByName: null,
  createdAt: '2026-09-21T12:00:05.000Z',
  finishedAt: '2026-09-21T12:00:40.000Z',
  assetIds: [],
  clientId: '11111111-1111-4111-8111-1111111111c2',
  clientName: 'Padaria Aurora',
};

describe('the editing agent', () => {
  const media = (canGenerate: boolean) => (
    <AgentChat
      scope="media"
      tab="media"
      title="Agente de Edição Wings"
      canRequest={false}
      canGenerate={canGenerate}
      standingHint="O agente lê, estima e propõe. Nada é gerado daqui sem o seu clique, e o custo em créditos aparece antes."
    />
  );

  it('talks to its own agent, under its own name and rule', async () => {
    renderChat(media(true));
    expect(screen.getByRole('heading', { name: 'Agente de Edição Wings' })).toBeTruthy();
    expect(screen.getByText(/Nada é gerado daqui sem o seu clique/)).toBeTruthy();
    await say('Uma imagem para a campanha do RJ');
    expect(sent[0]).toMatchObject({ scope: 'media', context: { tab: 'media' } });
  });

  it('keeps sending no scope for the traffic agent, as before', async () => {
    renderChat(<AgentChat canRequest tab="paid" />);
    await say('oi');
    expect(sent[0]).not.toHaveProperty('scope');
  });

  it('shows the camera move the agent chose on a video card, and the prompt with its term, before the click', async () => {
    renderChat(media(true));
    await say('Um vídeo da fachada da franquia');
    stream({
      type: 'proposal',
      proposal: {
        ...generationCard,
        payload: {
          ...generationCard.payload,
          kind: 'video',
          model: 'veo-3-1-fast',
          cameraMove: 'drone_ascending',
        },
      },
    });
    expect(screen.getByText('Movimento de câmera').nextElementSibling?.textContent).toBe(
      'Drone subindo · drone shot, ascending',
    );
    expect(
      screen.getByText(
        /golden hour, 50mm, shallow depth of field\. Camera movement: drone shot, ascending\.$/,
      ),
    ).toBeTruthy();
    expect(generationPosts()).toHaveLength(0);
  });

  it('shows the cost on the card and generates only on the click, naming the estimate', async () => {
    renderChat(media(true));
    await say('Uma imagem para a campanha do RJ');
    stream({ type: 'proposal', proposal: generationCard });

    expect(screen.getByText('Custo estimado: 4 créditos · Kairogen')).toBeTruthy();
    // Who it is for is on the card, before the click.
    expect(screen.getByText('Para quem').nextElementSibling?.textContent).toBe('Padaria Aurora');
    expect(screen.getByText(/Dono de loja em frente ao negócio/)).toBeTruthy();
    expect(screen.getByText('Prompt enviado ao modelo')).toBeTruthy();
    expect(generationPosts()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Gerar (4 créditos)' }));
    await waitFor(() => expect(generationPosts()).toHaveLength(1));
    expect(generationPosts()[0]?.body).toEqual({
      estimateId: 'est-1',
      proposalId: 'prop-gen-1',
    });

    // The server said yes: the card now follows the generation and offers no second click.
    followed.current = unknownGeneration;
    await act(async () => {
      generationPosts()[0]?.answer.resolve({ generation: followed.current });
      await Promise.resolve();
    });

    expect(await screen.findByText(/Resultado desconhecido/)).toBeTruthy();
    expect(screen.getByText(/Confira no Kairogen antes de gerar de novo/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Gerar/ })).toBeNull();
    expect(generationPosts()).toHaveLength(1);
    // Nothing was produced, so the card shows no picture.
    expect(screen.queryByRole('link', { name: /^Mídia gerada/ })).toBeNull();
  });

  it('shows the picture that goes with the request, and what the model will do with it', async () => {
    renderChat(media(true));
    await say('Troque o fundo desta imagem');
    stream({
      type: 'proposal',
      proposal: {
        ...generationCard,
        payload: { ...generationCard.payload, referenceAssetId: 'asset-7', referenceUse: 'edit' },
      },
    });
    expect(screen.getByText('Imagem enviada').nextElementSibling?.textContent).toBe(
      'Editar esta imagem',
    );
    const sent = screen.getByLabelText('Imagem que vai junto com o pedido');
    expect(sent.querySelector('img')?.getAttribute('src')).toBe('/api/media/assets/asset-7/file');
  });

  it('shows what was generated on the card once the generation is done', async () => {
    followed.current = {
      id: 'gen-2',
      status: 'succeeded',
      operation: 'generate',
      kind: 'image',
      model: 'seedream-v4',
      providerId: 'kairogen',
      prompt: null,
      brlCentsEstimated: 0,
      creditsEstimated: 4,
      creditsCharged: 4,
      detail: null,
      requestedByName: null,
      createdAt: '2026-09-21T12:00:05.000Z',
      finishedAt: '2026-09-21T12:00:40.000Z',
      assetIds: ['asset-9'],
      clientId: '11111111-1111-4111-8111-1111111111c2',
      clientName: 'Padaria Aurora',
    };
    renderChat(media(true));
    await say('Uma imagem');
    stream({
      type: 'proposal',
      proposal: { ...generationCard, status: 'requested', estimate: null, generationId: 'gen-2' },
    });

    const thumb = screen.getByRole('link', { name: 'Mídia gerada 1 de 1: ver na biblioteca' });
    // The library's own authenticated route: never an address at Kairogen.
    expect(thumb.querySelector('img')?.getAttribute('src')).toBe('/api/media/assets/asset-9/file');
    expect(screen.getByText(/Concluída/)).toBeTruthy();
    followed.current = null;
  });

  it('offers no button without the permission to generate, nor without an estimate', async () => {
    renderChat(media(false));
    await say('Uma imagem');
    stream({ type: 'proposal', proposal: generationCard });
    expect(screen.queryByRole('button', { name: /^Gerar/ })).toBeNull();
    expect(screen.getByText('Você não tem permissão para gerar mídia.')).toBeTruthy();
    cleanup();

    renderChat(media(true));
    await say('Outra imagem');
    stream({ type: 'proposal', proposal: { ...generationCard, id: 'prop-gen-2', estimate: null } });
    expect(screen.queryByRole('button', { name: /^Gerar/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Estimar de novo' })).toBeTruthy();
  });

  it('keeps the answer to a click made while the reply was still being written', async () => {
    // Staging, 2026-09-24: the click landed, the reply finished, the card was drawn
    // again without it, and the next click was told the estimate was already used.
    renderChat(media(true));
    await say('Use a imagem ClickFranquia e gere uma versão laranja');
    stream({ type: 'proposal', proposal: generationCard });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar (4 créditos)' }));
    await waitFor(() => expect(generationPosts()).toHaveLength(1));

    stream({
      type: 'done',
      message: assistant({ content: 'Pronto, o cartão está aí.', proposals: [generationCard] }),
      usage,
    });
    await close();

    followed.current = unknownGeneration;
    await act(async () => {
      generationPosts()[0]?.answer.resolve({ generation: unknownGeneration });
      await Promise.resolve();
    });
    expect(await screen.findByText(/Resultado desconhecido/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Gerar/ })).toBeNull();
    expect(generationPosts()).toHaveLength(1);
  });

  it('puts the price Kairogen named on the button when it refused an edit over the quote', async () => {
    renderChat(media(true));
    await say('Edite a imagem ClickFranquia');
    stream({ type: 'proposal', proposal: generationCard });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar (4 créditos)' }));
    await waitFor(() => expect(generationPosts()).toHaveLength(1));
    await act(async () => {
      generationPosts()[0]?.answer.resolve({
        generation: { ...unknownGeneration, status: 'refused' },
        requote: {
          id: 'est-5',
          credits: 5,
          brlCents: 0,
          providerId: 'kairogen',
          expiresAt: '2099-01-01T00:00:00.000Z',
          warnings: [
            'O Kairogen cobra 5 créditos por esta geração, não os 4 da estimativa dele: ela não conta a imagem enviada.',
          ],
        },
      });
      await Promise.resolve();
    });
    expect(await screen.findByText(/ela não conta a imagem enviada/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Gerar (5 créditos)' }));
    await waitFor(() => expect(generationPosts()).toHaveLength(2));
    expect(generationPosts()[1]?.body).toEqual({ estimateId: 'est-5', proposalId: 'prop-gen-1' });
  });

  it('turns a used or expired estimate into "Estimar de novo", one click, no agent', async () => {
    renderChat(media(true));
    await say('Uma imagem');
    stream({ type: 'proposal', proposal: generationCard });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar (4 créditos)' }));
    await waitFor(() => expect(generationPosts()).toHaveLength(1));
    await act(async () => {
      generationPosts()[0]?.answer.reject(
        new ApiError(409, {
          error: 'estimate_expired',
          message: 'A estimativa venceu. Estime o custo de novo.',
        }),
      );
      await Promise.resolve();
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Estimar de novo' }));
    const estimatePath = '/media/proposals/prop-gen-1/estimate';
    await waitFor(() => expect(posted.some((item) => item.path === estimatePath)).toBe(true));
    const again = posted.find((item) => item.path === estimatePath);
    await act(async () => {
      again?.answer.resolve({
        estimate: {
          id: 'est-2',
          credits: 4,
          brlCents: 0,
          providerId: 'kairogen',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
        generationId: null,
      });
      await Promise.resolve();
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Gerar (4 créditos)' }));
    await waitFor(() => expect(generationPosts()).toHaveLength(2));
    expect(generationPosts().map((item) => item.body)).toEqual([
      { estimateId: 'est-1', proposalId: 'prop-gen-1' },
      { estimateId: 'est-2', proposalId: 'prop-gen-1' },
    ]);
    // Nothing reached the agent: no second message was sent.
    expect(streamAgentMessage).toHaveBeenCalledTimes(1);
  });
});

describe('reading the event stream', () => {
  it('puts together an event split across two chunks', () => {
    const events: AgentStreamEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push('data: {"type":"delta","te');
    expect(events).toHaveLength(0);
    parser.push('xt":"Olá"}\n\ndata: {"type":"delta","text":" mundo"}\n');
    expect(events).toEqual([{ type: 'delta', text: 'Olá' }]);
    parser.push('\n');
    expect(events).toEqual([
      { type: 'delta', text: 'Olá' },
      { type: 'delta', text: ' mundo' },
    ]);
  });

  it('reads a last event that came without its closing blank line, and skips what is not JSON', () => {
    const events: AgentStreamEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    parser.push(': keep-alive\n\ndata: não é json\n\ndata: {"type":"delta","text":"fim"}');
    parser.end();
    expect(events).toEqual([{ type: 'delta', text: 'fim' }]);
  });
});

describe('timeline edits', () => {
  const card: AgentTimelineEditProposalCard = {
    id: 'prop-edit-1',
    kind: 'timeline_edit',
    status: 'open',
    createdAt: '2026-09-24T12:00:00.000Z',
    approvalId: null,
    payload: {
      explanation: 'Tiro o título e corto os 2 primeiros segundos.',
      ops: [
        { op: 'remove', clipId: 'title' },
        { op: 'set_timing', clipId: 'video', trim: 2 },
      ],
      lines: [
        'Remove texto "Seja franqueado" (0,0 s a 4,0 s)',
        'vídeo "depoimento.mp4" (0,0 s a 30,0 s): pula os primeiros 2,0 s do arquivo',
      ],
      files: {},
    },
  };
  const timeline: StudioTimelineSnapshot = {
    aspect: '9:16',
    mode: 'video',
    durationSeconds: 30,
    playheadSeconds: 0,
    selectedClipId: null,
    clips: [],
    files: [],
  };

  function bridge(previewing: string | null = null) {
    return {
      previewing,
      kept: [] as string[],
      preview: vi.fn(async () => true),
      keep: vi.fn(),
      discard: vi.fn(async () => undefined),
    };
  }
  const chat = (value: ReturnType<typeof bridge> | null) => (
    <TimelineEditContext.Provider value={value}>
      <AgentChat
        scope="media"
        tab="media"
        canRequest={false}
        getTimeline={value ? () => timeline : undefined}
      />
    </TimelineEditContext.Provider>
  );

  it('sends the timeline with the message when the editor is open', async () => {
    renderChat(chat(bridge()));
    await say('Tira o título');
    expect(sent[0]).toMatchObject({ scope: 'media', context: { tab: 'media', timeline } });
  });

  it('lists what changes and previews only on the click', async () => {
    const studio = bridge();
    renderChat(chat(studio));
    await say('Tira o título');
    stream({ type: 'proposal', proposal: card });
    const lines = screen.getByRole('list', { name: 'O que muda na linha do tempo' });
    expect(lines.textContent).toContain('Remove texto "Seja franqueado"');
    expect(lines.textContent).toContain('pula os primeiros 2,0 s do arquivo');
    expect(studio.preview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Pré-visualizar' }));
    await waitFor(() => expect(studio.preview).toHaveBeenCalledWith(card));
  });

  it('while previewing, Aplicar keeps it and Descartar takes it back', async () => {
    const studio = bridge('prop-edit-1');
    renderChat(chat(studio));
    await say('Tira o título');
    stream({ type: 'proposal', proposal: card });
    expect(screen.getByText(/Prévia na tela/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(studio.discard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(studio.keep).toHaveBeenCalledTimes(1);
  });

  it('outside the Studio, says where the edit can be seen', async () => {
    renderChat(chat(null));
    await say('Tira o título');
    stream({ type: 'proposal', proposal: card });
    expect(screen.getByText(/Abra o Studio/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Pré-visualizar' })).toBeNull();
  });
});

describe('when what the panel reads fails to load', () => {
  it('says "—" and why for the agent state, not that it is unconfigured', () => {
    failure.status = new ApiError(500, {});
    renderChat(<AgentChat canRequest tab="paid" />);

    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar o estado do agente: o servidor teve um problema (erro 500)',
    );
    expect(screen.queryByText('O agente ainda não está configurado neste ambiente.')).toBeNull();
    expect(screen.queryByLabelText('Mensagem')).toBeNull();
  });

  it('says why the earlier conversations are missing, and still takes a new message', () => {
    failure.conversations = new TypeError('Failed to fetch');
    renderChat(<AgentChat canRequest tab="paid" />);

    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar as conversas anteriores: sem conexão com o servidor',
    );
    expect(screen.getByLabelText('Mensagem')).toBeTruthy();
  });

  it('says why a chosen conversation did not open, instead of showing it empty', () => {
    earlier.current = [{ id: 'conv-1', title: 'Ajuste de verba' }];
    failure.conversation = new ApiError(500, {});
    renderChat(<AgentChat canRequest tab="paid" />);
    fireEvent.change(screen.getByLabelText('Conversas anteriores'), {
      target: { value: 'conv-1' },
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar a conversa: o servidor teve um problema (erro 500)',
    );
  });

  it('says why a generation cannot be followed, instead of "Acompanhando" for good', async () => {
    followError.current = new ApiError(500, {});
    renderChat(
      <AgentChat
        scope="media"
        tab="media"
        title="Agente de Edição Wings"
        canRequest={false}
        canGenerate
      />,
    );
    await say('Uma imagem');
    stream({
      type: 'proposal',
      proposal: { ...generationCard, status: 'requested', estimate: null, generationId: 'gen-2' },
    });

    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar o andamento da geração: o servidor teve um problema (erro 500)',
    );
    expect(screen.queryByText('Acompanhando a geração…')).toBeNull();
  });
});
