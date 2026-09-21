import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AgentCampaignProposalCard,
  AgentChangeProposalCard,
  AgentChatMessage,
  AgentGenerationProposalCard,
  AgentSendMessageInput,
  AgentStatusResponse,
  AgentStreamEvent,
  MediaGeneration,
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

const startGeneration = vi.fn();
const followed = { current: null as MediaGeneration | null };
vi.mock('../../api/media.js', async (original) => ({
  ...(await original<typeof import('../../api/media.js')>()),
  useStartGeneration: () => ({ mutate: startGeneration, isPending: false, error: null }),
  useGeneration: (id: string | undefined) => ({
    data: id && followed.current ? { generation: followed.current } : undefined,
  }),
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
    placements: { mode: 'manual', facebook: [], instagram: ['feed', 'stories'] },
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
  requestState.error = null;
  sent.length = 0;
  streamAgentMessage.mockClear();
  markApplied.mockClear();
  startGeneration.mockClear();
  followed.current = null;
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
  estimate: { id: 'est-1', credits: 4, expiresAt: '2026-09-21T12:15:00.000Z' },
  payload: {
    kind: 'image',
    model: 'seedream-v4',
    prompt:
      'Advertising photograph of a small business owner in front of a storefront at golden hour, 50mm, shallow depth of field.',
    explanation:
      'Dono de loja em frente ao negócio, luz de fim de tarde, espaço livre no alto para o título.',
    aspect: '4:5',
    quantity: 1,
    params: { quality: 'medium' },
    textInImage: null,
  },
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

  it('shows the cost on the card and generates only on the click, naming the estimate', async () => {
    renderChat(media(true));
    await say('Uma imagem para a campanha do RJ');
    stream({ type: 'proposal', proposal: generationCard });

    expect(screen.getByText('Custo estimado: 4 créditos')).toBeTruthy();
    expect(screen.getByText(/Dono de loja em frente ao negócio/)).toBeTruthy();
    expect(screen.getByText('Prompt enviado ao modelo')).toBeTruthy();
    expect(startGeneration).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Gerar (4 créditos)' }));
    expect(startGeneration).toHaveBeenCalledTimes(1);
    expect(startGeneration.mock.calls[0]?.[0]).toEqual({
      estimateId: 'est-1',
      proposalId: 'prop-gen-1',
    });

    // The server said yes: the card now follows the generation and offers no second click.
    followed.current = {
      id: 'gen-1',
      status: 'unknown',
      operation: 'generate',
      kind: 'image',
      model: 'seedream-v4',
      prompt: null,
      creditsEstimated: 4,
      creditsCharged: null,
      detail: 'O Kairogen não respondeu se recebeu o pedido.',
      requestedByName: null,
      createdAt: '2026-09-21T12:00:05.000Z',
      finishedAt: '2026-09-21T12:00:40.000Z',
      assetIds: [],
    };
    const options = startGeneration.mock.calls[0]?.[1] as {
      onSuccess: (body: { generation: MediaGeneration }) => void;
    };
    act(() => options.onSuccess({ generation: followed.current as MediaGeneration }));

    expect(screen.getByText(/Resultado desconhecido/)).toBeTruthy();
    expect(screen.getByText(/Confira no Kairogen antes de gerar de novo/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Gerar/ })).toBeNull();
    expect(startGeneration).toHaveBeenCalledTimes(1);
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
    expect(screen.getByText('Não foi possível estimar o custo. Peça de novo.')).toBeTruthy();
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
