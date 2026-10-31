import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS,
  PASTE_DISCARD_KINDS,
  PASTE_IGNORED_KINDS,
  type InstagramProspect,
  type InstagramStatus,
  type PastePreviewResponse,
} from '@wings/shared';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Prospecção → Instagram with the API mocked: made-up @ and texts only. */

const status: { data: InstagramStatus } = {
  data: {
    enabled: true,
    aiEnabled: false,
    settings: DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS,
    pastesToday: 2,
  },
};
const preview: { data: PastePreviewResponse | undefined } = { data: undefined };
const prospects: { data: InstagramProspect[] } = { data: [] };
const previewMutate = vi.fn();
const confirmMutate = vi.fn();
const actionMutate = vi.fn();
const fetchMessage = vi.fn();
const idle = { isPending: false, isError: false, isSuccess: false, reset: vi.fn() };

vi.mock('../../api/prospect-ai.js', () => ({
  useInstagramStatus: () => ({ data: status.data, isError: false }),
  usePreviewPaste: () => ({ ...idle, data: preview.data, mutate: previewMutate }),
  useConfirmPaste: () => ({ ...idle, mutate: confirmMutate }),
  useAttachComment: () => ({ ...idle, mutate: vi.fn() }),
  useInstagramProspects: () => ({ data: { prospects: prospects.data }, isError: false }),
  useInstagramBatches: () => ({ data: { batches: [] }, isError: false }),
  useInstagramOwners: () => ({ data: { owners: [] }, isError: false }),
  useProspectAction: () => ({ ...idle, mutate: actionMutate }),
  useCreateInstagramLead: () => ({ ...idle, mutate: vi.fn() }),
  useSaveInstagramSettings: () => ({ ...idle, mutate: vi.fn() }),
  fetchFirstMessage: (id: string) => fetchMessage(id),
}));

const { InstagramTab } = await import('./InstagramProspecting.js');

const wrap = (node: ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);
const zero = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  preview.data = undefined;
  prospects.data = [];
  status.data = { ...status.data, enabled: true };
});

const prospect = (extra: Partial<InstagramProspect>): InstagramProspect => ({
  id: 'p1',
  batchId: 'b1',
  state: 'nova',
  list: 'quer_comprar',
  username: 'usuario.teste01',
  excerpt: 'quanto custa pra abrir uma unidade?',
  occurredAt: new Date(Date.now() - 14 * 86_400_000).toISOString(),
  occurredAtPrecision: 'aproximada',
  postUrl: 'https://www.instagram.com/p/PostTeste0001/',
  postOwner: 'marca.concorrente.exemplo',
  signal: 'pediu_preco',
  confidence: 75,
  justification: 'quanto custa',
  category: 'nao_identificada',
  reviewReason: null,
  decisionReason: null,
  ownerEmployeeId: 'e1',
  ownerName: 'Vendedora Teste',
  mine: true,
  approachedAt: null,
  leadId: null,
  moreComments: 0,
  purgeAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  createdAt: new Date().toISOString(),
  ...extra,
});

describe('InstagramTab', () => {
  it('off: says why with "—", never an empty list', () => {
    status.data = { ...status.data, enabled: false };
    wrap(<InstagramTab canPaste canManage={false} canConfigure={false} />);
    expect(screen.getByText(/Prospecção Instagram desligada/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ler comentários' })).toBeNull();
  });

  it('reads first; "Separar" sends the same paste only after the preview', () => {
    wrap(<InstagramTab canPaste canManage={false} canConfigure={false} />);
    fireEvent.change(screen.getByLabelText('Link do post (obrigatório)'), {
      target: { value: 'https://www.instagram.com/p/PostTeste0001/' },
    });
    fireEvent.change(screen.getByLabelText('Comentários colados'), {
      target: { value: '@usuario.teste06: qual o investimento?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ler comentários' }));
    expect(previewMutate).toHaveBeenCalledWith({
      text: '@usuario.teste06: qual o investimento?',
      postUrl: 'https://www.instagram.com/p/PostTeste0001/',
      postOwner: '',
    });
    expect(confirmMutate).not.toHaveBeenCalled();
  });

  it('the preview shows the counts and the known people, and nothing is kept yet', () => {
    preview.data = {
      postUrl: 'https://www.instagram.com/p/PostTeste0001/',
      postOwner: null,
      format: 'manual',
      comments: [
        {
          username: 'usuario.teste06',
          excerpt: 'qual o investimento?',
          when: null,
          occurredAt: new Date().toISOString(),
          tag: null,
        },
        {
          username: 'pessoa.bloqueada',
          excerpt: 'quero',
          when: null,
          occurredAt: new Date().toISOString(),
          tag: { kind: 'nao_contatar' },
        },
      ],
      usable: 1,
      linesTotal: 3,
      linesIgnored: 0,
      ignored: zero(PASTE_IGNORED_KINDS),
      discarded: zero(PASTE_DISCARD_KINDS),
      unrecognized: ['frase solta'],
      linesUnrecognized: 1,
      alreadyKnown: { naoContatar: 1, cliente: 0, lead: 0, prospect: 0 },
      estimatedCostMicroUsd: null,
      aiEnabled: false,
    };
    wrap(<InstagramTab canPaste canManage={false} canConfigure={false} />);
    expect(screen.getByText(/Nada foi gravado ainda/)).toBeTruthy();
    expect(screen.getByText('não contatar')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Separar quem quer comprar (1 comentários)' }),
    ).toBeTruthy();
  });

  it('a card: "Não contatar" asks on the card (no browser dialog); "Copiar mensagem" says why not', async () => {
    const dialog = vi.spyOn(window, 'confirm');
    prospects.data = [prospect({})];
    fetchMessage.mockResolvedValue({
      message: null,
      reason: 'A política de privacidade ainda não tem link em Ajustes.',
    });
    wrap(<InstagramTab canPaste canManage={false} canConfigure={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Minhas listas' }));
    expect(screen.getByText('@usuario.teste01')).toBeTruthy();
    expect(screen.getByText(/há cerca de 2 semanas/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir no Instagram' }).getAttribute('href')).toBe(
      'https://www.instagram.com/usuario.teste01/',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Não contatar' }));
    expect(actionMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar não contatar (não expira)' }));
    expect(actionMutate).toHaveBeenCalledWith({
      id: 'p1',
      action: 'do-not-contact',
      body: { reason: '' },
    });
    expect(dialog).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copiar mensagem' }));
    expect(await screen.findByText(/a política de privacidade ainda não tem link/i)).toBeTruthy();
  });

  it('Diretoria (no leads.write) reads the lists without any action', () => {
    prospects.data = [prospect({ mine: false })];
    wrap(<InstagramTab canPaste={false} canManage canConfigure={false} />);
    expect(screen.queryByRole('button', { name: 'Colar comentários' })).toBeNull();
    expect(screen.getByText('@usuario.teste01')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Criar lead' })).toBeNull();
  });
});
