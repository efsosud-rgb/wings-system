import type { AudienceProfile, CustomLocation, MetaIdentities, PacingSummary } from '@wings/shared';
import { cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

/**
 * The builder is approved by what it shows, so these tests pin what the
 * operator sees: blocked copy is explained on screen, the real cost and the
 * real ceiling sit next to the budget, and launching only ever asks.
 */

const pacing: { current: PacingSummary | null } = { current: buildPacing() };

const requestCampaign = vi.fn();
const launchState: { current: { isSuccess: boolean; data?: { approvalId: string } } } = {
  current: { isSuccess: false },
};

const uploadSize = { current: { width: 1080, height: 1080 } };
let uploads = 0;

const savedAudience: { current: AudienceProfile | null } = { current: null };
const saveAudience = vi.fn();

const PAGE = '104567890123456';
const OTHER_PAGE = '209876543210987';
const INSTAGRAM = '17841400000000000';
function buildIdentities(): MetaIdentities {
  return {
    pages: [
      {
        id: PAGE,
        name: 'Wings Company',
        instagramAccounts: [{ id: INSTAGRAM, username: 'wingscompany' }],
      },
      { id: OTHER_PAGE, name: 'Wings Franquias', instagramAccounts: [] },
    ],
    default: { pageId: PAGE, instagramActorId: INSTAGRAM },
  };
}
/** What GET /ads/meta/identities answers: the lists, or the failure. */
const identities: { current: MetaIdentities | ApiError } = { current: buildIdentities() };
const refetchIdentities = vi.fn();
const saveIdentityDefault = vi.fn();
const uploadVideo = vi.fn();
const videoFailure: { current: ApiError | null } = { current: null };

vi.mock('../../api/ads.js', () => ({
  useAudienceProfile: () => ({ data: { profile: savedAudience.current } }),
  useSaveAudienceProfile: () => ({
    mutate: saveAudience,
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
  }),
  useUploadCreative: () => ({
    isPending: false,
    mutate: (
      _file: File,
      options: { onSuccess: (result: { creative: Record<string, unknown> }) => void },
    ) => {
      uploads += 1;
      options.onSuccess({
        creative: {
          id: `0000000${uploads}-0000-4000-8000-000000000000`,
          mimeType: 'image/png',
          byteSize: 1,
          ...uploadSize.current,
        },
      });
    },
  }),
  useMetaIdentities: (enabled: boolean) => {
    const failed = identities.current instanceof ApiError;
    return {
      data: enabled && !failed ? { identities: identities.current } : undefined,
      isLoading: false,
      isError: enabled && failed,
      error: failed ? identities.current : null,
      refetch: refetchIdentities,
    };
  },
  useSaveMetaIdentityDefault: () => ({
    mutate: saveIdentityDefault,
    isError: false,
    isSuccess: false,
    error: null,
  }),
  useUploadVideo: () => ({
    isPending: false,
    mutate: (
      file: File,
      options: {
        onSuccess: (result: { video: Record<string, unknown> }) => void;
        onError: (failure: Error) => void;
      },
    ) => {
      uploadVideo(file);
      if (videoFailure.current) return options.onError(videoFailure.current);
      options.onSuccess({
        video: {
          id: '33333333-3333-4333-8333-333333333333',
          mimeType: 'video/mp4',
          byteSize: 5_242_880,
        },
      });
    },
  }),
  useCockpit: () => ({ data: { cockpit: { pacing: pacing.current } }, isLoading: false }),
  useRequestCampaign: () => ({
    mutate: requestCampaign,
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    ...launchState.current,
  }),
}));

// Leaflet needs a real layout engine; the builder only cares what the map
// reports, so a stand-in reports a click and a radius change.
vi.mock('./RadiusMap.js', () => ({
  RadiusMap: ({
    value,
    onChange,
    disabled,
  }: {
    value: CustomLocation[];
    onChange: (next: CustomLocation[]) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="radius-map" data-disabled={disabled ? 'yes' : 'no'}>
      <button
        type="button"
        disabled={disabled}
        onClick={() =>
          onChange([
            ...value,
            { latitude: -22.9056, longitude: -47.0608, radiusKm: 15, label: 'Campinas' },
          ])
        }
      >
        clicar no mapa
      </button>
      <button
        type="button"
        onClick={() => onChange(value.map((item) => ({ ...item, radiusKm: 40 })))}
      >
        raio 40
      </button>
    </div>
  ),
}));

const render = (ui: ReactElement) => renderBare(<MemoryRouter>{ui}</MemoryRouter>);

const { PaidMediaBuilder } = await import('./PaidMediaBuilder.js');

function buildPacing(overrides: Partial<PacingSummary> = {}): PacingSummary {
  return {
    periodMonth: '2026-09-01',
    capCents: 400_000,
    usableCents: 280_000,
    committedCents: 100_000,
    spentCents: 50_000,
    availableCents: 180_000,
    expectedCents: 0,
    deviationPercent: null,
    elapsedDays: 18,
    totalDays: 30,
    killSwitchEngaged: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  pacing.current = buildPacing();
  launchState.current = { isSuccess: false };
  requestCampaign.mockReset();
  uploadSize.current = { width: 1080, height: 1080 };
  uploads = 0;
  savedAudience.current = null;
  saveAudience.mockReset();
  identities.current = buildIdentities();
  refetchIdentities.mockReset();
  saveIdentityDefault.mockReset();
  uploadVideo.mockReset();
  videoFailure.current = null;
});

function chooseImage(input: Element, type = 'image/png') {
  fireEvent.change(input, { target: { files: [new File(['x'], 'criativo.png', { type })] } });
}

function fillValidCampaign() {
  type(screen.getByLabelText(/^Nome da campanha/), 'Sacrifício — teste de escrita');
  type(screen.getByLabelText(/Página de destino/), 'https://wingscompany.com.br/franquia');
  const titles = screen.getAllByLabelText(/^Título/);
  const texts = screen.getAllByLabelText(/^Texto/);
  type(titles[0] as Element, 'Leve a Wings para sua cidade');
  type(texts[0] as Element, 'Fale com a gente.');
  type(titles[1] as Element, 'Seja um franqueado Wings');
  type(texts[1] as Element, 'Suporte completo.');
  type(screen.getByLabelText(/Verba por dia/), '6,00');
  type(
    screen.getByLabelText(/^Quem é o cliente ideal/),
    'Empreendedor de 30 a 50 anos, com experiência em gestão.',
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'SP' }));
  for (const input of screen.getAllByLabelText(/^Imagem — Variação/)) chooseImage(input);
}

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });

describe('the paid-media builder', () => {
  it('offers Meta, Google Pesquisa and YouTube, and says why the others are off', () => {
    render(<PaidMediaBuilder canRequest />);
    for (const name of [/^Meta/, /Google Pesquisa/, /YouTube/]) {
      expect((screen.getByRole('radio', { name }) as HTMLInputElement).disabled).toBe(false);
    }
    for (const name of [/TikTok/, /LinkedIn/]) {
      expect((screen.getByRole('radio', { name }) as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByText(/Sem conta de anúncios conectada/)).toBeTruthy();
    expect(screen.getByText(/Integração ainda não construída/)).toBeTruthy();
  });

  it('explains blocked copy on screen instead of only refusing it', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getAllByLabelText(/^Título/)[0] as Element, 'Retorno garantido em 12 meses');

    const warning = screen.getByText(/Este texto não pode ir ao ar/).closest('div');
    expect(warning?.textContent).toContain('Retorno garantido');
    expect(warning?.textContent).toContain('Nenhum resultado pode ser apresentado como garantido');
    expect(screen.getByText(/Há texto bloqueado pelo compliance/)).toBeTruthy();
  });

  it('shows the real cost next to the real ceiling', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-29');
    type(screen.getByLabelText(/Verba por dia/), '20,00');

    // R$ 20 × 10 days × 1.25 overdelivery.
    expect(screen.getAllByText('R$ 250,00').length).toBeGreaterThan(0);
    expect(screen.getByText('R$ 1.800,00')).toBeTruthy();
    expect(screen.queryByText(/passa do que a conta ainda permite/)).toBeNull();
  });

  it('opens every section with what the choice changes in practice', () => {
    render(<PaidMediaBuilder canRequest />);
    const sections = screen.getAllByRole('region').filter((el) => el.matches('.builder-section'));
    expect(sections).toHaveLength(15);
    for (const section of sections) {
      expect(section.querySelector('.builder-why')?.textContent?.length).toBeGreaterThan(40);
    }
    expect(screen.getByText(/Define como a Meta cobra e para quem mostra/)).toBeTruthy();
    expect(screen.getByText(/o lead chega no CRM com a origem certa/)).toBeTruthy();
    // The how-to hints under the fields are still there.
    expect(screen.getByText('A Meta pode gastar até 25% acima disto num dia.')).toBeTruthy();
  });

  it('says which field the estimate is waiting for, never a bare dash', () => {
    render(<PaidMediaBuilder canRequest />);
    const cost = () => screen.getByText('Custo total estimado', { selector: 'span' }).parentElement;
    expect(cost()?.textContent).toContain('Falta a verba por dia.');

    type(screen.getByLabelText(/Verba por dia/), '20 reais');
    expect(cost()?.textContent).toContain('Não entendi “20 reais”');

    type(screen.getByLabelText(/Verba por dia/), '0,50');
    expect(cost()?.textContent).toContain('pelo menos R$ 1,00');

    type(screen.getByLabelText(/Verba por dia/), '20');
    type(screen.getByLabelText(/^Fim/), '');
    expect(cost()?.textContent).toContain('Falta escolher o início e o fim');

    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-19');
    expect(cost()?.textContent).toContain('O fim da campanha está antes do início.');

    type(screen.getByLabelText(/^Fim/), '2026-09-26');
    // toLocaleString puts a non-breaking space after R$.
    expect(cost()?.textContent).toMatch(/R\$\s175,00/);
    expect(cost()?.textContent).not.toContain('—');
  });

  it('reads a dot as a decimal mark, not as a hundred times the budget', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-26');
    type(screen.getByLabelText(/Verba por dia/), '20.00');
    expect(screen.getAllByText('R$ 175,00').length).toBeGreaterThan(0);
  });

  it('warns when the campaign would not fit under the ceiling', () => {
    pacing.current = buildPacing({ availableCents: 10_000 });
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-29');
    type(screen.getByLabelText(/Verba por dia/), '20,00');
    expect(screen.getByText(/passa do que a conta ainda permite/)).toBeTruthy();
  });

  it('generates UTMs from the name and keeps an edited one', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText('Nome da campanha'), 'Expansão SP');
    expect((screen.getByLabelText('utm_campaign') as HTMLInputElement).value).toBe('expansao-sp');

    type(screen.getByLabelText('utm_campaign'), 'minha-tag');
    type(screen.getByLabelText('Nome da campanha'), 'Expansão RJ');
    expect((screen.getByLabelText('utm_campaign') as HTMLInputElement).value).toBe('minha-tag');
  });

  it('takes one image per variation and says when it will be cropped', () => {
    render(<PaidMediaBuilder canRequest />);
    const [first, second] = screen.getAllByLabelText(/^Imagem — Variação/);
    chooseImage(first as Element);
    expect(screen.getByText(/1080 × 1080 px · ✓ proporção 1:1/)).toBeTruthy();

    uploadSize.current = { width: 1200, height: 628 };
    chooseImage(second as Element);
    expect(screen.getByText(/proporção diferente de 1:1/)).toBeTruthy();

    // The preview shows each uploaded image next to its copy.
    expect(screen.getAllByAltText(/^Criativo — Variação 1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Não é a prévia oficial da Meta/)).toBeTruthy();
  });

  it('previews in the placement of the chosen format, and lets the operator see the other cut', () => {
    render(<PaidMediaBuilder canRequest />);
    const media = () => document.querySelector<HTMLElement>('.ad-preview-media')?.style.aspectRatio;
    const pressed = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('aria-pressed');

    // Feed quadrado is the default format.
    expect(pressed('Feed')).toBe('true');
    expect(media()).toBe('1080 / 1080');

    fireEvent.click(screen.getByRole('button', { name: 'Stories' }));
    expect(media()).toBe('9 / 16');
    expect(screen.getByText(/É assim que a mesma imagem seria cortada em Stories/)).toBeTruthy();

    // Back on the chosen side, the preview follows section 6 again.
    fireEvent.click(screen.getByRole('button', { name: 'Feed' }));
    type(screen.getByLabelText(/^Formato/), 'stories_reels');
    expect(pressed('Stories')).toBe('true');
    expect(media()).toBe('9 / 16');

    fireEvent.click(screen.getByRole('button', { name: 'Feed' }));
    expect(media()).toBe('4 / 5');
  });

  it('refuses a file type before sending it anywhere', () => {
    render(<PaidMediaBuilder canRequest />);
    chooseImage(screen.getAllByLabelText(/^Imagem — Variação/)[0] as Element, 'image/webp');
    expect(screen.getByText('Use uma imagem PNG ou JPEG.')).toBeTruthy();
    expect(uploads).toBe(0);
  });

  it('starts from the audience Wings saved, and leaves it editable', () => {
    savedAudience.current = {
      idealCustomerProfile: 'Empreendedor com capital próprio e perfil de gestão.',
      reach: {
        states: ['SP', 'PR'],
        cities: [{ name: 'Goiânia', state: 'GO' }],
        customLocations: [],
      },
      updatedAt: '2026-09-18T12:00:00.000Z',
      updatedByName: 'Eric',
    };
    render(<PaidMediaBuilder canRequest />);

    const icp = screen.getByLabelText(/^Quem é o cliente ideal/) as HTMLTextAreaElement;
    expect(icp.value).toContain('capital próprio');
    expect((screen.getByRole('checkbox', { name: 'PR' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Padrão atual salvo por Eric/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remover Goiânia' }));
    expect(screen.getByText('Nenhuma cidade adicionada.')).toBeTruthy();
  });

  it('takes a radius on the map into the summary and into the request', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    // The map alone is a valid reach: no state, no city.
    fireEvent.click(screen.getByRole('checkbox', { name: 'SP' }));
    fireEvent.click(screen.getByRole('button', { name: 'clicar no mapa' }));
    fireEvent.click(screen.getByRole('button', { name: 'raio 40' }));
    expect(screen.getByText('40 km ao redor de Campinas')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0].reach).toEqual({
      states: [],
      cities: [],
      customLocations: [
        { latitude: -22.9056, longitude: -47.0608, radiusKm: 40, label: 'Campinas' },
      ],
    });
  });

  it('adds cities, and saves profile and reach as the Wings default', () => {
    render(<PaidMediaBuilder canRequest />);
    fireEvent.click(screen.getByRole('button', { name: /Salvar perfil e alcance/ }));
    expect(screen.getByText(/Descreva o cliente ideal/)).toBeTruthy();
    expect(saveAudience).not.toHaveBeenCalled();

    type(screen.getByLabelText(/^Quem é o cliente ideal/), 'Empreendedor com perfil de gestão.');
    type(screen.getByLabelText('Cidade'), 'Curitiba');
    type(screen.getByLabelText('UF da cidade'), 'PR');
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar cidade' }));
    expect(screen.getAllByText(/Curitiba\/PR/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Salvar perfil e alcance/ }));
    expect(saveAudience).toHaveBeenCalledWith({
      idealCustomerProfile: 'Empreendedor com perfil de gestão.',
      reach: { states: [], cities: [{ name: 'Curitiba', state: 'PR' }], customLocations: [] },
    });
  });

  it('allows a third variation and no more', () => {
    render(<PaidMediaBuilder canRequest />);
    expect(screen.getAllByLabelText(/^Título/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Adicionar variação/ }));
    expect(screen.getAllByLabelText(/^Título/)).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Adicionar variação/ })).toBeNull();
  });

  it('checks the draft on demand without sending anything', async () => {
    render(<PaidMediaBuilder canRequest />);
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(screen.getByText(/Há campos para corrigir/)).toBeTruthy());
    expect(screen.getByText('Dê um nome à campanha')).toBeTruthy();

    fillValidCampaign();
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(screen.getByText(/Tudo conferido/)).toBeTruthy());
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('launches a request — paused by default — and never with blocked copy', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    type(screen.getAllByLabelText(/^Título/)[1] as Element, 'Retorno garantido');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(screen.getByText(/Há texto bloqueado/)).toBeTruthy());
    expect(requestCampaign).not.toHaveBeenCalled();

    type(screen.getAllByLabelText(/^Título/)[1] as Element, 'Seja um franqueado Wings');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0]).toMatchObject({
      name: 'Sacrifício — teste de escrita',
      dailyBudgetCents: 600,
      startPaused: true,
      reach: { states: ['SP'], cities: [], customLocations: [] },
      variations: [
        { creativeId: '00000001-0000-4000-8000-000000000000' },
        { creativeId: '00000002-0000-4000-8000-000000000000' },
      ],
    });
  });

  it('points at the approval once asked, and says nothing was published', () => {
    launchState.current = { isSuccess: true, data: { approvalId: 'ap-9' } };
    render(<PaidMediaBuilder canRequest />);
    expect(screen.getByText(/Nada foi publicado/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Abrir o pedido/ }).getAttribute('href')).toBe(
      '/marketing/trafego-pago-wings/aprovacoes/ap-9',
    );
  });

  it('keeps the launch button off for someone who may not ask', () => {
    render(<PaidMediaBuilder canRequest={false} />);
    expect(
      (screen.getByRole('button', { name: 'Lançar campanha' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/mas não enviar o pedido/)).toBeTruthy();
  });
});

describe('the builder on Google', () => {
  const choose = (name: RegExp) => fireEvent.click(screen.getByRole('radio', { name }));

  function fillCommon() {
    type(screen.getByLabelText(/^Nome da campanha/), 'Pesquisa — franquia SP');
    type(screen.getByLabelText(/Página de destino/), 'https://wingscompany.com.br/franquia');
    type(screen.getByLabelText(/Verba por dia/), '30,00');
    type(
      screen.getByLabelText(/^Quem é o cliente ideal/),
      'Empreendedor de 30 a 50 anos, com experiência em gestão.',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'SP' }));
  }

  function fillSearch() {
    fillCommon();
    type(
      screen.getByLabelText(/^Palavras-chave(?! negativas)/),
      'franquia de alimentação\n\n  abrir franquia  ',
    );
    type(screen.getByLabelText(/^Palavras-chave negativas/), 'grátis');
    type(screen.getByLabelText(/^Título 1/), 'Franquia Wings');
    type(screen.getByLabelText(/^Descrição 1/), 'Conheça o modelo de negócio e o suporte.');
  }

  it('shows the search fields only on Google Pesquisa, and hides what is Meta only', () => {
    render(<PaidMediaBuilder canRequest />);
    expect(screen.queryByLabelText(/^Palavras-chave(?! negativas)/)).toBeNull();
    expect(screen.queryByLabelText(/Link do vídeo/)).toBeNull();

    choose(/Google Pesquisa/);
    expect(screen.getByLabelText(/^Palavras-chave(?! negativas)/)).toBeTruthy();
    expect(screen.getByLabelText(/^Palavras-chave negativas/)).toBeTruthy();
    expect(screen.queryByLabelText(/Link do vídeo/)).toBeNull();
    // Meta's image, format and variations are gone; the map stays.
    expect(screen.queryByLabelText(/^Imagem — Variação/)).toBeNull();
    expect(screen.queryByLabelText(/^Formato/)).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Adicionar variação' })).toBeNull();
    expect(screen.getByRole('button', { name: 'clicar no mapa' })).toBeTruthy();
    expect(screen.queryByText(/ainda não vale para o Google/)).toBeNull();

    const sections = screen.getAllByRole('region').filter((el) => el.matches('.builder-section'));
    expect(sections.map((el) => el.querySelector('.builder-step')?.textContent)).toEqual(
      Array.from({ length: 11 }, (_, index) => String(index + 1)),
    );

    choose(/^Meta/);
    expect(screen.queryByLabelText(/^Palavras-chave(?! negativas)/)).toBeNull();
    expect(screen.getAllByLabelText(/^Imagem — Variação/)).toHaveLength(2);
  });

  it('shows the video fields only on YouTube, and says what kind of campaign it is', () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/YouTube/);
    expect(screen.getByLabelText(/Link do vídeo no YouTube/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Palavras-chave(?! negativas)/)).toBeNull();
    expect(screen.queryByLabelText(/^Imagem — Variação/)).toBeNull();
    expect(screen.getByText(/Criada como campanha Demand Gen restrita ao YouTube/)).toBeTruthy();
  });

  it('locks every campaign on paused, and says why on each platform', () => {
    render(<PaidMediaBuilder canRequest />);
    const paused = () =>
      screen.getByRole('checkbox', { name: /Criar a campanha/ }) as HTMLInputElement;
    expect(paused().checked).toBe(true);
    expect(paused().disabled).toBe(true);
    expect(screen.getByText(/Tudo nasce pausado: campanha, conjunto e anúncios/)).toBeTruthy();

    choose(/Google Pesquisa/);
    expect(paused().checked).toBe(true);
    expect(paused().disabled).toBe(true);
    expect(screen.getByText('Campanhas do Google nascem sempre pausadas.')).toBeTruthy();
  });

  it('launches a search request carrying only what belongs to it', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    fillSearch();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    const sent = requestCampaign.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      platform: 'google_search',
      name: 'Pesquisa — franquia SP',
      dailyBudgetCents: 3000,
      startPaused: true,
      variations: [],
      reach: { states: ['SP'], cities: [], customLocations: [] },
      search: {
        keywords: ['franquia de alimentação', 'abrir franquia'],
        negativeKeywords: ['grátis'],
        headlines: ['Franquia Wings'],
        descriptions: ['Conheça o modelo de negócio e o suporte.'],
      },
      utms: { utm_source: 'google', utm_medium: 'cpc' },
    });
    expect(sent).not.toHaveProperty('formatKey');
    expect(sent).not.toHaveProperty('youtube');
  });

  it('launches a YouTube request carrying only what belongs to it', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/YouTube/);
    fillCommon();
    type(screen.getByLabelText(/Link do vídeo/), 'https://youtu.be/dQw4w9WgXcQ');
    type(screen.getByLabelText(/^Título/), 'Conheça a Wings');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    const sent = requestCampaign.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      platform: 'youtube',
      startPaused: true,
      variations: [],
      youtube: { videoUrl: 'https://youtu.be/dQw4w9WgXcQ', headline: 'Conheça a Wings' },
      utms: { utm_source: 'youtube', utm_medium: 'paid_video' },
    });
    expect(sent).not.toHaveProperty('formatKey');
    expect(sent).not.toHaveProperty('search');
  });

  it('keeps a radius chosen on Meta when the platform becomes Google, and sends it', async () => {
    render(<PaidMediaBuilder canRequest />);
    fireEvent.click(screen.getByRole('button', { name: 'clicar no mapa' }));
    choose(/Google Pesquisa/);
    fillSearch();
    // The summary reads the states and the radius together.
    expect(screen.getAllByText(/15 km ao redor de Campinas/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0]).toMatchObject({
      platform: 'google_search',
      reach: {
        customLocations: [
          { latitude: -22.9056, longitude: -47.0608, radiusKm: 15, label: 'Campinas' },
        ],
      },
    });
  });

  it('shows the same reach block, map included, on every platform that can be chosen', () => {
    render(<PaidMediaBuilder canRequest />);
    for (const name of [/^Meta/, /Google Pesquisa/, /YouTube/]) {
      choose(name);
      const reach = screen.getByRole('region', { name: /Área de alcance/ });
      expect(reach.querySelector('.builder-states')).toBeTruthy();
      expect(reach.textContent).toContain('Cidades');
      expect(reach.querySelector('[data-testid="radius-map"]')?.getAttribute('data-disabled')).toBe(
        'no',
      );
      expect(reach.textContent).not.toContain('não aceita raio');
    }
  });

  it('sends a radius alone as a whole reach on YouTube too', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/YouTube/);
    fillCommon();
    fireEvent.click(screen.getByRole('checkbox', { name: 'SP' }));
    fireEvent.click(screen.getByRole('button', { name: 'clicar no mapa' }));
    type(screen.getByLabelText(/Link do vídeo/), 'https://youtu.be/dQw4w9WgXcQ');
    type(screen.getByLabelText(/^Título/), 'Conheça a Wings');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    expect(requestCampaign.mock.calls[0]?.[0].reach).toMatchObject({
      states: [],
      cities: [],
      customLocations: [{ radiusKm: 15 }],
    });
  });

  it('refuses a link that is not a YouTube video, and sends nothing', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/YouTube/);
    fillCommon();
    type(screen.getByLabelText(/Link do vídeo/), 'https://vimeo.com/123456');
    type(screen.getByLabelText(/^Título/), 'Conheça a Wings');
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() =>
      expect(screen.getByText('Informe um link https:// do YouTube')).toBeTruthy(),
    );
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('refuses more than 10 keywords', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    fillSearch();
    type(
      screen.getByLabelText(/^Palavras-chave(?! negativas)/),
      Array.from({ length: 11 }, (_, index) => `franquia termo ${index}`).join('\n'),
    );
    expect(screen.getByText(/11\/10/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));

    await waitFor(() => expect(screen.getByText('No máximo 10 palavras-chave')).toBeTruthy());
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('holds search copy to the compliance rules, on screen and on launch', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    fillSearch();
    type(screen.getByLabelText(/^Título 2/), 'Retorno garantido');

    expect(screen.getByText(/Este texto não pode ir ao ar/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(screen.getByText(/Há texto bloqueado/)).toBeTruthy());
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('previews the video by its YouTube still, with the typed title', () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/YouTube/);
    expect(screen.getByText('Cole um link do YouTube para ver a prévia')).toBeTruthy();

    type(screen.getByLabelText(/Link do vídeo/), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    type(screen.getByLabelText(/^Título/), 'Conheça a Wings');
    type(screen.getByLabelText(/Página de destino/), 'https://www.wingscompany.com.br/franquia');

    const still = screen.getByAltText('Miniatura do vídeo no YouTube') as HTMLImageElement;
    expect(still.src).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    const preview = still.closest('figure');
    expect(preview?.textContent).toContain('Conheça a Wings');
    expect(preview?.textContent).toContain('wingscompany.com.br');
    expect(screen.getByText(/Não é a prévia oficial do Google/)).toBeTruthy();
  });

  it('previews the search ad the way Google lays it out', () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    fillSearch();
    type(screen.getByLabelText(/^Título 2/), 'Leve para sua cidade');

    const preview = screen.getByText('Anúncio na Pesquisa do Google').closest('figure');
    expect(preview?.textContent).toContain('Patrocinado');
    expect(preview?.textContent).toContain('wingscompany.com.br › franquia');
    expect(preview?.textContent).toContain('Franquia Wings | Leve para sua cidade');
    expect(preview?.textContent).toContain('Conheça o modelo de negócio e o suporte.');
  });

  it('estimates Google at the budget itself over the period, and says so', () => {
    render(<PaidMediaBuilder canRequest />);
    type(screen.getByLabelText(/^Início/), '2026-09-20');
    type(screen.getByLabelText(/^Fim/), '2026-09-29');
    type(screen.getByLabelText(/Verba por dia/), '20,00');
    expect(screen.getAllByText('R$ 250,00').length).toBeGreaterThan(0);

    choose(/Google Pesquisa/);
    // R$ 20 × 10 days × 1: Google's 2× is a promise about one day only.
    expect(screen.getAllByText('R$ 200,00').length).toBeGreaterThan(0);
    expect(screen.queryByText('R$ 250,00')).toBeNull();
    expect(screen.queryByText('R$ 400,00')).toBeNull();
    expect(
      screen.getByText(
        'O Google pode gastar até o dobro da verba diária num dia, mas no período não cobra além da verba.',
      ),
    ).toBeTruthy();

    // A single day has no period to even it out: the worst day decides.
    type(screen.getByLabelText(/^Fim/), '2026-09-20');
    expect(screen.getAllByText('R$ 40,00').length).toBeGreaterThan(0);
    expect(screen.getByText(/o pior caso de um único dia/)).toBeTruthy();
    expect(screen.queryByText('A Meta pode gastar até 25% acima disto num dia.')).toBeNull();
  });
});

describe('the builder on Meta: ad set and ads', () => {
  const choose = (name: RegExp) => fireEvent.click(screen.getByRole('radio', { name }));
  const launch = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Lançar campanha' }));
    await waitFor(() => expect(requestCampaign).toHaveBeenCalledTimes(1));
    return requestCampaign.mock.calls[0]?.[0] as Record<string, unknown>;
  };
  const typeOf = (variation: number, name: string) =>
    fireEvent.click(
      screen
        .getAllByRole('group', { name: `Tipo de criativo — Variação ${variation}` })
        .flatMap((group) => Array.from(group.querySelectorAll('button')))
        .find((button) => button.textContent === name) as Element,
    );
  const video = (size?: number) => {
    const file = new File(['x'], 'anuncio.mp4', { type: 'video/mp4' });
    if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
    return file;
  };

  it('starts at 25–65, automatic placements and the page Wings saved', () => {
    render(<PaidMediaBuilder canRequest />);
    expect((screen.getByLabelText(/^Idade mínima/) as HTMLInputElement).value).toBe('25');
    expect((screen.getByLabelText(/^Idade máxima/) as HTMLInputElement).value).toBe('65');
    expect(
      (screen.getByRole('radio', { name: /Automático \(Advantage\+\)/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(screen.queryByRole('checkbox', { name: 'Facebook Feed' })).toBeNull();
    expect((screen.getByLabelText(/^Página do Facebook/) as HTMLSelectElement).value).toBe(PAGE);
    expect((screen.getByLabelText(/^Conta do Instagram/) as HTMLSelectElement).value).toBe(
      INSTAGRAM,
    );
    // The Drive button is still there, and still off.
    expect(
      (screen.getByRole('button', { name: /Escolher do Drive/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows none of it on Google, and sends none of it', async () => {
    render(<PaidMediaBuilder canRequest />);
    choose(/Google Pesquisa/);
    expect(screen.queryByLabelText(/^Idade mínima/)).toBeNull();
    expect(screen.queryByRole('radio', { name: /Automático/ })).toBeNull();
    expect(screen.queryByLabelText(/^Página do Facebook/)).toBeNull();

    type(screen.getByLabelText(/^Nome da campanha/), 'Pesquisa — franquia SP');
    type(screen.getByLabelText(/Página de destino/), 'https://wingscompany.com.br/franquia');
    type(screen.getByLabelText(/Verba por dia/), '30,00');
    type(
      screen.getByLabelText(/^Quem é o cliente ideal/),
      'Empreendedor de 30 a 50 anos, com experiência.',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'SP' }));
    type(screen.getByLabelText(/^Palavras-chave(?! negativas)/), 'abrir franquia');
    type(screen.getByLabelText(/^Título 1/), 'Franquia Wings');
    type(screen.getByLabelText(/^Descrição 1/), 'Conheça o modelo de negócio e o suporte.');
    const payload = await launch();
    for (const field of ['ageMin', 'ageMax', 'placements', 'identity']) {
      expect(payload).not.toHaveProperty(field);
    }
  });

  it('sends the defaults as the ad set will be created', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    expect(await launch()).toMatchObject({
      ageMin: 25,
      ageMax: 65,
      placements: { mode: 'automatic', facebook: [], instagram: [] },
      identity: { pageId: PAGE, instagramActorId: INSTAGRAM },
      startPaused: true,
      variations: [{ creativeType: 'image' }, { creativeType: 'image' }],
    });
    expect(saveIdentityDefault).not.toHaveBeenCalled();
  });

  it('refuses an age outside 18–65 and a range upside down, in Portuguese', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    type(screen.getByLabelText(/^Idade mínima/), '17');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(screen.getByText('A idade vai de 18 a 65 anos.')).toBeTruthy());

    type(screen.getByLabelText(/^Idade mínima/), '50');
    type(screen.getByLabelText(/^Idade máxima/), '30');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() =>
      expect(screen.getByText('A idade máxima não pode ser menor que a mínima')).toBeTruthy(),
    );
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('takes manual placements, and needs an Instagram account to advertise there', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    choose(/^Manual/);
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() =>
      expect(screen.getByText('Escolha ao menos um posicionamento')).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Facebook Feed' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Instagram Reels' }));
    type(screen.getByLabelText(/^Conta do Instagram/), '');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() =>
      expect(
        screen.getByText('Escolha a conta do Instagram para anunciar no Instagram'),
      ).toBeTruthy(),
    );

    type(screen.getByLabelText(/^Conta do Instagram/), INSTAGRAM);
    expect(await launch()).toMatchObject({
      placements: { mode: 'manual', facebook: ['feed'], instagram: ['reels'] },
      identity: { pageId: PAGE, instagramActorId: INSTAGRAM },
    });
  });

  it('warns about the 9:16 cut only with Stories or Reels, and never blocks', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    expect(screen.queryByText(/Stories e Reels são verticais/)).toBeNull();
    expect(screen.queryByText(/Esta imagem não é 9:16/)).toBeNull();

    choose(/^Manual/);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Facebook Feed' }));
    expect(screen.queryByText(/Stories e Reels são verticais/)).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Facebook Stories' }));
    expect(screen.getByText(/Stories e Reels são verticais \(9:16\)/)).toBeTruthy();
    // Both uploaded images are 1080 × 1080.
    expect(
      screen.getAllByText(/Esta imagem não é 9:16: será cortada em Stories e Reels/),
    ).toHaveLength(2);

    uploadSize.current = { width: 1080, height: 1920 };
    chooseImage(screen.getAllByLabelText(/^Imagem — Variação/)[0] as Element);
    expect(screen.getAllByText(/Esta imagem não é 9:16/)).toHaveLength(1);

    await launch();
  });

  it('saves the page as the Wings default only when asked, and only when it changed', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    fireEvent.click(screen.getByRole('checkbox', { name: /Guardar como padrão da Wings/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(screen.getByText(/Tudo conferido/)).toBeTruthy());
    // Ticked, but it is already the default.
    expect(saveIdentityDefault).not.toHaveBeenCalled();

    type(screen.getByLabelText(/^Página do Facebook/), OTHER_PAGE);
    expect((screen.getByLabelText(/^Conta do Instagram/) as HTMLSelectElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() => expect(saveIdentityDefault).toHaveBeenCalledTimes(1));
    expect(saveIdentityDefault).toHaveBeenCalledWith({
      pageId: OTHER_PAGE,
      instagramActorId: null,
    });
  });

  it('cannot launch where Meta is not configured, and says so', () => {
    identities.current = new ApiError(503, { error: 'meta_not_configured', message: 'x' });
    render(<PaidMediaBuilder canRequest />);
    expect(
      screen.getByText(
        /A Meta não está configurada neste ambiente — não é possível escolher a página/,
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Lançar campanha' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // Google does not depend on Meta.
    choose(/Google Pesquisa/);
    expect(
      (screen.getByRole('button', { name: 'Lançar campanha' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('offers to ask Meta again when Meta failed', () => {
    identities.current = new ApiError(502, {
      error: 'meta_unavailable',
      message: 'A Meta não respondeu.',
    });
    render(<PaidMediaBuilder canRequest />);
    expect(screen.getByText(/A Meta não respondeu\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(refetchIdentities).toHaveBeenCalledTimes(1);
  });

  it('uploads a video variation and sends its id, with no image and no cards', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    typeOf(2, 'Vídeo');
    expect(screen.getAllByLabelText(/^Imagem — Variação/)).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(/^Vídeo — Variação 2(?!,)/), {
      target: { files: [video()] },
    });
    expect(uploadVideo).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/5 MB/)).toBeTruthy();
    // The approximate preview plays the uploaded file.
    expect(
      document.querySelector('video[src="/api/ads/videos/33333333-3333-4333-8333-333333333333"]'),
    ).toBeTruthy();

    const payload = await launch();
    const second = (payload.variations as Record<string, unknown>[])[1];
    expect(second).toMatchObject({
      creativeType: 'video',
      videoId: '33333333-3333-4333-8333-333333333333',
    });
    expect(second?.creativeId).toBeUndefined();
    expect(second?.cards).toBeUndefined();
  });

  it('refuses a video over 4 GB before sending anything', () => {
    render(<PaidMediaBuilder canRequest />);
    typeOf(1, 'Vídeo');
    fireEvent.change(screen.getByLabelText(/^Vídeo — Variação 1(?!,)/), {
      target: { files: [video(4 * 1024 * 1024 * 1024 + 1)] },
    });
    expect(screen.getByText('O vídeo passa de 4 GB.')).toBeTruthy();
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('says so when the server has nowhere to keep videos', () => {
    videoFailure.current = new ApiError(503, {
      error: 'video_storage_not_configured',
      message: 'O armazenamento de vídeos não está configurado neste ambiente.',
    });
    render(<PaidMediaBuilder canRequest />);
    typeOf(1, 'Vídeo');
    fireEvent.change(screen.getByLabelText(/^Vídeo — Variação 1(?!,)/), {
      target: { files: [video()] },
    });
    expect(screen.getByText(/O armazenamento de vídeos não está configurado/)).toBeTruthy();
  });

  it('builds a carousel of two cards and sends exactly that', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    typeOf(2, 'Carrossel');
    expect(screen.getAllByText(/^Cartão \d$/)).toHaveLength(2);

    const titles = screen.getAllByLabelText(/^Título do cartão/);
    const texts = screen.getAllByLabelText(/^Texto do cartão/);
    const links = screen.getAllByLabelText(/^Link do cartão/);
    type(titles[0] as Element, 'Suporte completo');
    type(texts[0] as Element, 'Do ponto à inauguração.');
    type(links[0] as Element, 'https://wingscompany.com.br/suporte');
    type(titles[1] as Element, 'Modelo enxuto');
    type(texts[1] as Element, 'Operação simples.');
    type(links[1] as Element, 'https://wingscompany.com.br/modelo');
    chooseImage(screen.getByLabelText(/^Imagem — Variação 2, cartão 1/));
    fireEvent.click(
      Array.from(
        screen
          .getByRole('group', { name: 'Mídia — Variação 2, cartão 2' })
          .querySelectorAll('button'),
      ).find((button) => button.textContent === 'Vídeo') as Element,
    );
    fireEvent.change(screen.getByLabelText(/^Vídeo — Variação 2, cartão 2(?!,)/), {
      target: { files: [video()] },
    });

    expect(screen.getByText(/Carrossel \(2 cartões\)/)).toBeTruthy();
    const payload = await launch();
    const second = (payload.variations as Record<string, unknown>[])[1];
    expect(second).toMatchObject({ creativeType: 'carousel' });
    expect(second?.creativeId).toBeUndefined();
    expect(second?.cards).toEqual([
      {
        mediaType: 'image',
        creativeId: '00000003-0000-4000-8000-000000000000',
        headline: 'Suporte completo',
        description: 'Do ponto à inauguração.',
        link: 'https://wingscompany.com.br/suporte',
      },
      {
        mediaType: 'video',
        videoId: '33333333-3333-4333-8333-333333333333',
        headline: 'Modelo enxuto',
        description: 'Operação simples.',
        link: 'https://wingscompany.com.br/modelo',
      },
    ]);
  });

  it('refuses a carousel of one card, and blocked copy on a card', async () => {
    render(<PaidMediaBuilder canRequest />);
    fillValidCampaign();
    typeOf(2, 'Carrossel');
    type(screen.getAllByLabelText(/^Título do cartão/)[0] as Element, 'Retorno garantido');
    expect(screen.getByText(/Há texto bloqueado pelo compliance/)).toBeTruthy();
    type(screen.getAllByLabelText(/^Título do cartão/)[0] as Element, 'Suporte completo');

    fireEvent.click(screen.getAllByRole('button', { name: 'Remover cartão' })[1] as Element);
    fireEvent.click(screen.getByRole('button', { name: 'Conferir campanha' }));
    await waitFor(() =>
      expect(screen.getByText('Um carrossel tem de 2 a 10 cartões')).toBeTruthy(),
    );
    expect(requestCampaign).not.toHaveBeenCalled();
  });

  it('says where the official preview will be', () => {
    render(<PaidMediaBuilder canRequest />);
    expect(
      screen.getByText(
        /A prévia oficial da Meta fica disponível na tela da aprovação depois que os anúncios forem criados/,
      ),
    ).toBeTruthy();
  });
});
