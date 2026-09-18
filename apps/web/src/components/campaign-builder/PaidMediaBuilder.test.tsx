import type { AudienceProfile, PacingSummary } from '@wings/shared';
import { cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  it('offers only Meta, and says why the others are off', () => {
    render(<PaidMediaBuilder canRequest />);
    expect((screen.getByRole('radio', { name: /Meta/ }) as HTMLInputElement).disabled).toBe(false);
    for (const name of [/TikTok/, /YouTube/, /LinkedIn/]) {
      expect((screen.getByRole('radio', { name }) as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByText(/Sem conta de anúncios conectada/)).toBeTruthy();
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
    expect(sections).toHaveLength(13);
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
      reach: { states: ['SP', 'PR'], cities: [{ name: 'Goiânia', state: 'GO' }] },
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
      reach: { states: [], cities: [{ name: 'Curitiba', state: 'PR' }] },
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
      reach: { states: ['SP'], cities: [] },
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
