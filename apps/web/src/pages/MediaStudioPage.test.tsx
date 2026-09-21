import { WINGS_CLIENT_ID } from '@wings/shared';
import type {
  Client,
  MediaAsset,
  MediaEstimate,
  MediaGeneration,
  MediaModel,
  MediaUsage,
  SessionUser,
} from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The media studio against a scripted API. What matters most here: the cost
 * comes before the button, the button names only an estimate, and nothing is
 * ever sent a second time on its own.
 */

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    patch: (path: string, body?: unknown) => patch(path, body),
    upload: vi.fn(),
  },
}));

const session = { current: null as SessionUser | null };
vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: session.current, isLoading: false }),
  hasPermission: (user: SessionUser | null, permission: string) =>
    Boolean(user?.permissions[permission as keyof SessionUser['permissions']]),
}));

// The chat has its own tests; here it would only add requests to script.
vi.mock('../components/agent-chat/AgentChat.js', () => ({ AgentChat: () => <div>chat</div> }));

const { MediaStudioPage } = await import('./MediaStudioPage.js');
const { ApiError } = await import('../api/client.js');

const userWith = (...permissions: string[]) =>
  ({
    id: 'emp-1',
    permissions: Object.fromEntries(permissions.map((key) => [key, 'all'])),
  }) as unknown as SessionUser;

const usage: MediaUsage = {
  plan: 'free',
  balance: 45,
  usedTodayByYou: 8,
  dailyLimitPerUser: 30,
  usedThisMonth: 120,
  monthlyLimit: 500,
};

const imageModel: MediaModel = {
  key: 'seedream-v4',
  name: 'Seedream 4',
  provider: 'ByteDance',
  kind: 'image',
  creditsPerOutput: 4,
  supportedDurations: [],
  aspectRatios: ['1:1', '4:5', '9:16'],
  priceParams: [
    {
      key: 'quality',
      label: 'Qualidade',
      type: 'choice',
      options: ['low', 'medium', 'high'],
      defaultValue: 'medium',
    },
  ],
  acceptsReferenceImage: true,
  acceptsFirstFrame: false,
};
const videoModel: MediaModel = {
  key: 'veo-3-1-fast',
  name: 'Veo 3.1 Fast',
  provider: 'Google',
  kind: 'video',
  creditsPerOutput: null,
  supportedDurations: [4, 8],
  aspectRatios: null,
  priceParams: [
    {
      key: 'generate_audio',
      label: 'Gerar áudio',
      type: 'boolean',
      options: [],
      defaultValue: false,
    },
  ],
  acceptsReferenceImage: false,
  acceptsFirstFrame: false,
};

const asset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'asset-1',
  kind: 'image',
  origin: 'kairogen',
  mimeType: 'image/png',
  byteSize: 1_400_000,
  width: 1080,
  height: 1350,
  aspect: '4:5',
  durationSeconds: null,
  prompt: 'Storefront at golden hour',
  model: 'seedream-v4',
  credits: 4,
  clientId: WINGS_CLIENT_ID,
  client: 'Wings Company',
  folder: null,
  tags: ['rj'],
  ownerName: 'Marketing',
  createdAt: '2026-09-21T12:00:00.000Z',
  downloadPath: '/media/assets/asset-1/file',
  ...overrides,
});

const estimateOf = (overrides: Partial<MediaEstimate> = {}): MediaEstimate => ({
  id: 'est-1',
  credits: 4,
  expiresAt: '2026-09-21T12:15:00.000Z',
  request: { operation: 'upscale', assetId: 'asset-1', scale: 2 },
  blockedBy: null,
  usage,
  ...overrides,
});

const generationOf = (overrides: Partial<MediaGeneration> = {}): MediaGeneration => ({
  id: 'gen-1',
  status: 'running',
  operation: 'generate',
  kind: 'image',
  model: 'seedream-v4',
  prompt: null,
  creditsEstimated: 4,
  creditsCharged: null,
  detail: null,
  requestedByName: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  assetIds: [],
  clientId: WINGS_CLIENT_ID,
  clientName: 'Wings Company',
  ...overrides,
});

const AURORA = '11111111-1111-4111-8111-1111111111c2';
const clients: Client[] = [
  { id: WINGS_CLIENT_ID, name: 'Wings Company', slug: 'wings-company', active: true },
  { id: AURORA, name: 'Padaria Aurora', slug: 'padaria-aurora', active: true },
  { id: '11111111-1111-4111-8111-1111111111c3', name: 'Antigo', slug: 'antigo', active: false },
];

let assets: MediaAsset[] = [];
let generation: MediaGeneration = generationOf();

function script() {
  get.mockImplementation((path: string) => {
    if (path === '/media/studio')
      return Promise.resolve({ usage, connected: true, storageAvailable: true });
    if (path.startsWith('/media/models?kind=image'))
      return Promise.resolve({ models: [imageModel], cachedAt: '' });
    if (path.startsWith('/media/models?kind=video'))
      return Promise.resolve({ models: [videoModel], cachedAt: '' });
    if (path === '/clients') return Promise.resolve({ clients });
    if (path === '/media/generations') return Promise.resolve({ generations: [] });
    if (path.startsWith('/media/generations/')) return Promise.resolve({ generation });
    if (path.startsWith('/media/assets'))
      return Promise.resolve({ assets, storageAvailable: true });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/marketing/edicao']}>
        <Routes>
          <Route path="/marketing/edicao" element={<MediaStudioPage />} />
          <Route path="/marketing/trafego-pago-wings" element={<div>construtor</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const form = () => screen.getByRole('form', { name: 'Gerar mídia' });
const typePrompt = (text: string) =>
  fireEvent.change(within(form()).getByLabelText('Prompt'), { target: { value: text } });
const PROMPT = 'Advertising photograph of a storefront at golden hour';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  sessionStorage.clear();
  assets = [];
  generation = generationOf();
  session.current = userWith('marketing.media.read', 'marketing.media.generate', 'ads.request');
  script();
});
afterEach(cleanup);

describe('the header', () => {
  it('shows the balance, the plan and both ceilings', async () => {
    renderPage();
    expect(await screen.findByText('45 créditos')).toBeTruthy();
    expect(screen.getByText('Free')).toBeTruthy();
    expect(screen.getByText('8 de 30 créditos')).toBeTruthy();
    expect(screen.getByText('120 de 500 créditos')).toBeTruthy();
  });

  it('says so when Kairogen is not connected, and lets nothing be estimated', async () => {
    get.mockImplementation((path: string) =>
      path === '/media/studio'
        ? Promise.resolve({ usage: null, connected: false, storageAvailable: true })
        : path === '/media/generations'
          ? Promise.resolve({ generations: [] })
          : Promise.resolve({ assets: [], storageAvailable: true }),
    );
    renderPage();
    expect(await screen.findByText(/O Kairogen não está conectado/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Estimar custo' })).toHaveProperty('disabled', true);
  });
});

describe('the operator form', () => {
  it('shows the cost first, and then a button that names it and sends only the estimate', async () => {
    post.mockImplementation((path: string) =>
      path === '/media/estimates'
        ? Promise.resolve({ estimate: estimateOf() })
        : Promise.resolve({ generation: generationOf() }),
    );
    renderPage();
    await screen.findByRole('option', { name: 'Seedream 4 · 4 créditos por saída' });
    expect(screen.queryByRole('button', { name: /^Gerar/ })).toBeNull();

    typePrompt(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'Estimar custo' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]).toEqual([
      '/media/estimates',
      {
        operation: 'generate',
        kind: 'image',
        model: 'seedream-v4',
        prompt: PROMPT,
        aspect: '1:1',
        quantity: 1,
        params: { quality: 'medium' },
        clientId: WINGS_CLIENT_ID,
      },
    ]);

    expect(await screen.findByText('Custo: 4 créditos')).toBeTruthy();
    // Nothing was generated by estimating.
    expect(post).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Gerar (4 créditos)' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]).toEqual(['/media/generations', { estimateId: 'est-1' }]);
    expect(await screen.findByText('Gerando no Kairogen')).toBeTruthy();
  });

  it('throws the estimate away as soon as anything on the form changes', async () => {
    post.mockResolvedValue({ estimate: estimateOf() });
    renderPage();
    await screen.findByRole('option', { name: /Seedream 4/ });
    typePrompt(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'Estimar custo' }));
    await screen.findByRole('button', { name: 'Gerar (4 créditos)' });

    fireEvent.change(within(form()).getByLabelText('Qualidade'), { target: { value: 'high' } });
    expect(screen.queryByRole('button', { name: /^Gerar/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Estimar custo' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Estimar custo' }));
    await screen.findByRole('button', { name: 'Gerar (4 créditos)' });
    fireEvent.click(within(form()).getByRole('radio', { name: '4:5' }));
    expect(screen.queryByRole('button', { name: /^Gerar/ })).toBeNull();
  });

  it('asks who it is for, Wings Company unless somebody picks a client, and sends only the id', async () => {
    post.mockResolvedValue({ estimate: estimateOf() });
    renderPage();
    await screen.findByRole('option', { name: /Seedream 4/ });
    const forWhom = within(form()).getByLabelText('Para quem') as HTMLSelectElement;
    await within(forWhom).findByRole('option', { name: 'Padaria Aurora' });
    expect(forWhom.value).toBe(WINGS_CLIENT_ID);
    // A client that was switched off is not offered for new work.
    expect(within(forWhom).queryByRole('option', { name: 'Antigo' })).toBeNull();

    fireEvent.change(forWhom, { target: { value: AURORA } });
    typePrompt(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'Estimar custo' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[1]).toMatchObject({ clientId: AURORA, prompt: PROMPT });
    expect(JSON.stringify(post.mock.calls[0]?.[1])).not.toContain('Aurora');
  });

  it('says "custo na estimativa" for a model the catalog gives no price for', async () => {
    renderPage();
    fireEvent.change(await within(form()).findByLabelText('Tipo'), { target: { value: 'video' } });
    expect(
      await screen.findByRole('option', { name: 'Veo 3.1 Fast · custo na estimativa' }),
    ).toBeTruthy();
  });

  it('takes its controls from the model: price parameters, shapes, durations and quantity', async () => {
    renderPage();
    await screen.findByRole('option', { name: /Seedream 4/ });
    expect(within(form()).getByLabelText('Qualidade')).toBeTruthy();
    // Seedream takes no 16:9.
    expect(within(form()).getByRole('radio', { name: '16:9' })).toHaveProperty('disabled', true);
    expect(within(form()).queryByLabelText('Duração')).toBeNull();
    expect(within(within(form()).getByLabelText('Quantidade')).getAllByRole('option')).toHaveLength(
      4,
    );
    expect(within(form()).getByText('Imagem de referência')).toBeTruthy();

    fireEvent.change(within(form()).getByLabelText('Tipo'), { target: { value: 'video' } });
    await screen.findByRole('option', { name: 'Veo 3.1 Fast · custo na estimativa' });
    const duration = within(form()).getByLabelText('Duração');
    expect(
      within(duration)
        .getAllByRole('option')
        .map((item) => item.textContent),
    ).toEqual(['4 s', '8 s']);
    expect(within(within(form()).getByLabelText('Quantidade')).getAllByRole('option')).toHaveLength(
      2,
    );
    expect(within(form()).getByLabelText('Gerar áudio')).toBeTruthy();
    expect(within(form()).queryByLabelText('Qualidade')).toBeNull();
    expect(within(form()).getByRole('radio', { name: '16:9' })).toHaveProperty('disabled', false);
    expect(within(form()).queryByText('Imagem de referência')).toBeNull();
  });

  it('says why a generation is blocked, and keeps the button off', async () => {
    post.mockResolvedValue({
      estimate: estimateOf({ credits: 60, blockedBy: 'insufficient_credits' }),
    });
    renderPage();
    await screen.findByRole('option', { name: /Seedream 4/ });
    typePrompt(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'Estimar custo' }));

    expect(
      await screen.findByText('O saldo da conta no Kairogen não cobre esta geração.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Gerar (60 créditos)' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('refuses a prompt that promises income before asking anything of the server', async () => {
    renderPage();
    await screen.findByRole('option', { name: /Seedream 4/ });
    typePrompt('Banner com o texto: ganhe R$ 10 mil por mês com retorno garantido');
    fireEvent.click(screen.getByRole('button', { name: 'Estimar custo' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('shows why a generation was refused, and never sends it again by itself', async () => {
    generation = generationOf({
      status: 'refused',
      detail: 'O Kairogen cobraria 6 créditos, e a estimativa era de 4.',
      finishedAt: new Date().toISOString(),
    });
    post.mockImplementation((path: string) =>
      path === '/media/estimates'
        ? Promise.resolve({ estimate: estimateOf() })
        : Promise.resolve({ generation: generationOf() }),
    );
    renderPage();
    await screen.findByRole('option', { name: /Seedream 4/ });
    typePrompt(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'Estimar custo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar (4 créditos)' }));

    expect(await screen.findByText('Recusada pelo Kairogen')).toBeTruthy();
    expect(screen.getByText(/cobraria 6 créditos/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /tentar de novo/i })).toBeNull();
    const generations = post.mock.calls.filter(([path]) => path === '/media/generations');
    expect(generations).toHaveLength(1);
  });

  it('reports a refusal of the click itself, such as a ceiling reached meanwhile', async () => {
    post.mockImplementation((path: string) =>
      path === '/media/estimates'
        ? Promise.resolve({ estimate: estimateOf() })
        : Promise.reject(
            new ApiError(409, {
              error: 'daily_limit',
              message: 'Você atingiu o seu limite de créditos de hoje.',
            }),
          ),
    );
    renderPage();
    await screen.findByRole('option', { name: /Seedream 4/ });
    typePrompt(PROMPT);
    fireEvent.click(screen.getByRole('button', { name: 'Estimar custo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Gerar (4 créditos)' }));
    expect(await screen.findByText('Você atingiu o seu limite de créditos de hoje.')).toBeTruthy();
  });

  it('is read-only for somebody who may look but not generate', async () => {
    session.current = userWith('marketing.media.read');
    renderPage();
    expect(await screen.findByText(/não tem permissão para gerar mídia/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Estimar custo' })).toHaveProperty('disabled', true);
    expect(screen.queryByText('Enviar arquivo')).toBeNull();
  });
});

describe('the library', () => {
  it('asks the API with the filters that were chosen', async () => {
    renderPage();
    const filters = await screen.findByRole('search', { name: 'Filtros da biblioteca' });
    fireEvent.change(within(filters).getByLabelText('Tipo'), { target: { value: 'image' } });
    fireEvent.change(within(filters).getByLabelText('Origem'), { target: { value: 'kairogen' } });
    fireEvent.change(within(filters).getByLabelText('Formato'), { target: { value: '9:16' } });
    fireEvent.change(within(filters).getByLabelText('Tag'), { target: { value: 'rj' } });
    fireEvent.change(within(filters).getByLabelText('Busca'), { target: { value: 'golden hour' } });
    await within(filters).findByRole('option', { name: 'Padaria Aurora' });
    fireEvent.change(within(filters).getByLabelText('Cliente'), { target: { value: AURORA } });
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        `/media/assets?kind=image&origin=kairogen&aspect=9%3A16&tag=rj&q=golden+hour&clientId=${AURORA}`,
      ),
    );
  });

  it('estimates an upscale before offering to pay for it', async () => {
    assets = [asset()];
    post.mockImplementation((path: string) =>
      path === '/media/estimates'
        ? Promise.resolve({ estimate: estimateOf({ id: 'est-up', credits: 2 }) })
        : Promise.resolve({ generation: generationOf({ id: 'gen-up', operation: 'upscale' }) }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Imagem, 1080 × 1350/ }));
    const dialog = screen.getByRole('dialog', { name: 'Prévia da mídia' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Ampliar 2x' }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/media/estimates', {
        operation: 'upscale',
        assetId: 'asset-1',
        scale: 2,
      }),
    );
    expect(post).toHaveBeenCalledTimes(1);

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Ampliar 2x (2 créditos)' }));
    await waitFor(() =>
      expect(post).toHaveBeenLastCalledWith('/media/generations', { estimateId: 'est-up' }),
    );
  });

  it('animates only what was generated at Kairogen, and files an asset on request', async () => {
    assets = [
      asset(),
      asset({
        id: 'asset-2',
        origin: 'upload',
        prompt: null,
        model: null,
        credits: null,
        width: 1200,
        height: 1200,
        aspect: '1:1',
        downloadPath: '/media/assets/asset-2/file',
      }),
    ];
    patch.mockResolvedValue({ asset: asset() });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /^Imagem, 1200 × 1200/ }));
    let dialog = screen.getByRole('dialog', { name: 'Prévia da mídia' });
    expect(within(dialog).queryByRole('button', { name: 'Animar' })).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'Baixar' }).getAttribute('href')).toBe(
      '/api/media/assets/asset-2/file',
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Imagem, 1080 × 1350/ }));
    dialog = screen.getByRole('dialog', { name: 'Prévia da mídia' });
    expect(within(dialog).getByRole('button', { name: 'Animar' })).toBeTruthy();

    expect(within(dialog).getByText('Para quem')).toBeTruthy();
    await within(dialog).findByRole('option', { name: 'Padaria Aurora' });
    fireEvent.change(within(dialog).getByLabelText('Cliente'), { target: { value: AURORA } });
    fireEvent.change(within(dialog).getByLabelText('Pasta'), { target: { value: 'Campanha RJ' } });
    fireEvent.change(within(dialog).getByLabelText('Tags, separadas por vírgula'), {
      target: { value: 'rj, reels' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar organização' }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/media/assets/asset-1', {
        clientId: AURORA,
        folder: 'Campanha RJ',
        tags: ['rj', 'reels'],
      }),
    );
  });

  it('takes an asset to the campaign builder, for whoever may ask for campaigns', async () => {
    assets = [asset()];
    const picked = {
      mediaAssetId: 'asset-1',
      creative: {
        id: 'creative-9',
        mimeType: 'image/png',
        width: 1080,
        height: 1350,
        byteSize: 1_400_000,
      },
      video: null,
    };
    post.mockResolvedValue(picked);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Imagem, 1080 × 1350/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Usar no construtor' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/media/assets/asset-1/use-in-builder', undefined),
    );
    expect(await screen.findByText('construtor')).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem('wings.builder.pickedMedia') ?? 'null')).toEqual(
      picked,
    );
  });

  it('hides "Usar no construtor" from somebody who cannot ask for campaigns', async () => {
    session.current = userWith('marketing.media.read', 'marketing.media.generate');
    assets = [asset()];
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Imagem, 1080 × 1350/ }));
    expect(screen.queryByRole('button', { name: 'Usar no construtor' })).toBeNull();
  });
});
