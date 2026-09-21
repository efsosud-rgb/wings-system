import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AgentCampaignProposalCard,
  AgentChangeProposalCard,
  AgentChatMessage,
  AgentSendMessageInput,
  AgentStatusResponse,
  AgentStreamEvent,
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
const markApplied = vi.fn();
const requestFromProposal = vi.fn();
const requestState = { error: null as Error | null };

/** The stream under the test's control. */
let emit: (event: AgentStreamEvent) => void = () => undefined;
let finish: () => void = () => undefined;
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
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  },
);

vi.mock('../../api/agent.js', async (original) => ({
  ...(await original<typeof import('../../api/agent.js')>()),
  useAgentStatus: () => ({ data: status.current, isLoading: false }),
  useAgentConversations: () => ({ data: { conversations: [] } }),
  useAgentConversation: () => ({ data: undefined, isLoading: false }),
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

const { AgentChat } = await import('./AgentChat.js');
const { createSseParser } = await import('../../api/agent.js');

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
    dailyBudgetCents: 3000,
    startDate: '2026-09-22',
    endDate: '2026-09-28',
    copy: [],
    search: {
      keywords: ['franquia de alimentação'],
      negativeKeywords: ['grátis'],
      headlines: ['Franquia Wings'],
      descriptions: ['Conheça o modelo de negócio.'],
    },
    explanations: [{ field: 'dailyBudgetCents', reason: 'Cabe no disponível de R$ 469,88.' }],
    summary: 'Campanha de pesquisa para leads em São Paulo.',
  },
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
  requestState.error = null;
  sent.length = 0;
  streamAgentMessage.mockClear();
  markApplied.mockClear();
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
    expect(onApplyCampaign).toHaveBeenCalledWith(campaignCard.payload);
    expect(markApplied).toHaveBeenCalledWith('prop-1');
    expect(screen.getByText('Aplicada no construtor')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aplicar de novo' })).toBeTruthy();
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
