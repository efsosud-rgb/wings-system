import type { Lead, LeadWebResearch } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { CompanyResearchPanel } from './CompanyResearchPanel.js';

/** The "Pesquisar de novo" request, stood in for: the panel only decides when to offer it. */
const redo = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  isSuccess: false,
  isError: false,
  error: null as unknown,
}));
vi.mock('../../api/leads.js', () => ({ useResearchLead: () => redo }));

/** The company research on the deal's page: findings with their sources and date, "—" with the reason for the rest. */

const research = (webResearch: LeadWebResearch | null | undefined): Lead['research'] => ({
  state: 'done',
  summary: null,
  score: null,
  criteria: [],
  links: [],
  facts:
    webResearch === undefined
      ? null
      : {
          region: null,
          emailDomain: null,
          whatsapp: null,
          links: [],
          company: null,
          searches: 0,
          webResearch,
        },
  error: null,
  updatedAt: null,
  costUsd: 0,
});

const DONE: LeadWebResearch = {
  status: 'done',
  at: '2026-10-06T21:30:00.000Z',
  reason: null,
  model: 'anthropic/claude-haiku-4.5',
  fields: [
    {
      key: 'activity',
      value: 'Rede de açaí',
      reason: null,
      sourceUrl: 'https://acai.example.com.br/sobre',
    },
    {
      key: 'location',
      value: 'Campinas/SP',
      reason: null,
      sourceUrl: 'https://acai.example.com.br/sobre',
    },
    { key: 'size', value: null, reason: 'Nenhuma página fala do porte', sourceUrl: null },
    {
      key: 'time_in_market',
      value: null,
      reason: 'As páginas encontradas não dizem isso',
      sourceUrl: null,
    },
    {
      key: 'online_presence',
      value: 'Site e Instagram ativos',
      reason: null,
      sourceUrl: 'https://www.instagram.com/acai/',
    },
  ],
  sources: [
    { url: 'https://acai.example.com.br/sobre', title: 'Sobre a Açaí da Fila' },
    { url: 'https://www.instagram.com/acai/', title: null },
    { url: 'javascript:alert(1)', title: 'Nunca vira link' },
  ],
};

afterEach(cleanup);
beforeEach(() => {
  redo.mutate.mockReset();
  Object.assign(redo, { isPending: false, isSuccess: false, isError: false, error: null });
});

describe('CompanyResearchPanel', () => {
  it('shows nothing for a lead with no company research', () => {
    const { container, rerender } = render(<CompanyResearchPanel research={research(undefined)} />);
    expect(container.innerHTML).toBe('');
    rerender(<CompanyResearchPanel research={research(null)} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows each finding, a dash with the reason when the search brought nothing, the sources and the date', () => {
    render(<CompanyResearchPanel research={research(DONE)} />);
    const panel = screen.getByRole('region', { name: 'Pesquisa da empresa' });
    expect(within(panel).getByText('O que a empresa faz')).toBeTruthy();
    expect(within(panel).getByText('Rede de açaí')).toBeTruthy();
    expect(within(panel).getByText('Nenhuma página fala do porte')).toBeTruthy();
    expect(within(panel).getByText('As páginas encontradas não dizem isso')).toBeTruthy();
    expect(within(panel).getAllByLabelText('sem dado')).toHaveLength(2);
    expect(within(panel).getByText(/Pesquisado em/).textContent).toContain(
      'Resumo automático por IA',
    );

    const link = within(panel).getByRole('link', {
      name: 'Sobre a Açaí da Fila — acai.example.com.br',
    });
    expect(link.getAttribute('href')).toBe('https://acai.example.com.br/sobre');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    // A title-less source is named by its host; a non-web address is text, not a link.
    expect(within(panel).getByRole('link', { name: 'instagram.com' }).getAttribute('href')).toBe(
      'https://www.instagram.com/acai/',
    );
    expect(within(panel).getByText('Nunca vira link').closest('a')).toBeNull();
  });

  it('says why nothing was searched, and shows no invented rows', () => {
    render(
      <CompanyResearchPanel
        research={research({
          status: 'refused',
          at: '2026-10-06T21:30:00.000Z',
          reason: 'O teto diário da pesquisa foi atingido; nenhuma chamada foi feita',
          fields: [],
          sources: [],
          model: null,
        })}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Pesquisa da empresa' });
    expect(within(panel).getByText(/teto diário da pesquisa foi atingido/)).toBeTruthy();
    expect(within(panel).queryByText('O que a empresa faz')).toBeNull();
    expect(within(panel).queryByRole('link')).toBeNull();
  });

  it('does not claim the pages say it when the search brought none', () => {
    render(
      <CompanyResearchPanel
        research={research({
          ...DONE,
          fields: DONE.fields.map((field) => ({
            ...field,
            value: null,
            reason: 'A busca não trouxe páginas para confirmar',
          })),
          sources: [],
        })}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Pesquisa da empresa' });
    expect(within(panel).queryByText('Páginas que a busca trouxe')).toBeNull();
    expect(panel.textContent).toContain(
      'A busca não trouxe páginas para confirmar; nada foi guardado.',
    );
    expect(panel.textContent).not.toContain('cada dado mostra a página de onde veio');
  });

  it('shows each value with the page that backs it, and a dash for a value without one', () => {
    render(
      <CompanyResearchPanel
        research={research({
          ...DONE,
          fields: [
            DONE.fields[0]!,
            // Stored before each value named its page.
            { key: 'location', value: 'Campinas/SP', reason: null },
            // A link that is not one of the pages the search returned is never shown.
            {
              key: 'size',
              value: '12 lojas',
              reason: null,
              sourceUrl: 'https://outra.example.com/',
            },
            DONE.fields[3]!,
            DONE.fields[4]!,
          ],
        })}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Pesquisa da empresa' });
    const activity = within(panel).getByText('Rede de açaí').closest('dd') as HTMLElement;
    const activitySource = within(activity).getByRole('link', {
      name: 'Fonte: acai.example.com.br',
    });
    expect(activitySource.getAttribute('href')).toBe('https://acai.example.com.br/sobre');
    expect(activitySource.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    const presence = within(panel)
      .getByText('Site e Instagram ativos')
      .closest('dd') as HTMLElement;
    expect(
      within(presence).getByRole('link', { name: 'Fonte: instagram.com' }).getAttribute('href'),
    ).toBe('https://www.instagram.com/acai/');
    expect(within(panel).queryByText('Campinas/SP')).toBeNull();
    expect(within(panel).queryByText('12 lojas')).toBeNull();
    expect(within(panel).getAllByText('Sem a página que sustenta este dado')).toHaveLength(2);
    expect(within(panel).getAllByLabelText('sem dado')).toHaveLength(3);
  });
});

describe('a research stored before each value named its page', () => {
  // Arrived on the cut-off day, so the worker takes a new research.
  const LEAD = {
    id: 'lead-1',
    createdAt: '2026-10-14T15:00:00.000Z',
    enteredAt: '2026-10-14T15:00:00.000Z',
  };
  // Fields with no `sourceUrl` at all, as the first 14/10 researches were written.
  const OLD: LeadWebResearch = {
    ...DONE,
    fields: DONE.fields.map(({ key, value, reason }) => ({ key, value, reason })),
  };

  it('shows the dashes, says why, and offers to ask again with the price on the button', () => {
    render(<CompanyResearchPanel research={research(OLD)} lead={LEAD} canWrite />);
    const panel = screen.getByRole('region', { name: 'Pesquisa da empresa' });
    expect(within(panel).getAllByLabelText('sem dado')).toHaveLength(5);
    expect(within(panel).getByText(/anterior à fonte por dado/)).toBeTruthy();
    const button = within(panel).getByRole('button', {
      name: 'Pesquisar de novo (cerca de US$ 0,01)',
    });
    fireEvent.click(button);
    expect(redo.mutate).toHaveBeenCalledWith('lead-1');
  });

  it('says why but offers no button to someone who cannot write the lead', () => {
    render(<CompanyResearchPanel research={research(OLD)} lead={LEAD} canWrite={false} />);
    const panel = screen.getByRole('region', { name: 'Pesquisa da empresa' });
    expect(within(panel).getByText(/anterior à fonte por dado/)).toBeTruthy();
    expect(within(panel).queryByRole('button')).toBeNull();
  });

  it('offers no button for a lead that arrived before the cut-off, and says why', () => {
    for (const lead of [
      {
        id: 'lead-2',
        createdAt: '2026-10-13T20:00:00.000Z',
        enteredAt: '2026-10-13T20:00:00.000Z',
      },
      // Created today but first arrived before: an old deal imported today is old.
      {
        id: 'lead-3',
        createdAt: '2026-10-14T15:00:00.000Z',
        enteredAt: '2026-10-01T12:00:00.000Z',
      },
    ]) {
      render(<CompanyResearchPanel research={research(OLD)} lead={lead} canWrite />);
      const panel = screen.getByRole('region', { name: 'Pesquisa da empresa' });
      expect(within(panel).queryByRole('button')).toBeNull();
      expect(within(panel).getByText(/chegou antes de 14\/10\/2026/)).toBeTruthy();
      cleanup();
    }
  });

  it('does not stick on the queue after a request that ended without a new result: the button is back with its price', () => {
    Object.assign(redo, { isSuccess: true });
    render(<CompanyResearchPanel research={research(OLD)} lead={LEAD} canWrite />);
    const button = screen.getByRole('button', {
      name: 'Pesquisar de novo (cerca de US$ 0,01)',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('does not say each value shows its page when it does not', () => {
    render(<CompanyResearchPanel research={research(OLD)} lead={LEAD} canWrite />);
    const panel = screen.getByRole('region', { name: 'Pesquisa da empresa' });
    expect(panel.textContent).not.toContain('cada dado mostra a página de onde veio');
  });

  it('waits while a research is already queued or running, and shows why a request failed', () => {
    render(
      <CompanyResearchPanel
        research={{ ...research(OLD), state: 'pending' }}
        lead={LEAD}
        canWrite
      />,
    );
    const waiting = screen.getByRole('button', { name: 'Pesquisa na fila…' }) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);
    cleanup();

    Object.assign(redo, {
      isError: true,
      error: new ApiError(409, {
        error: 'research_in_progress',
        message: 'A pesquisa deste lead já está na fila. Aguarde ela terminar.',
      }),
    });
    render(<CompanyResearchPanel research={research(OLD)} lead={LEAD} canWrite />);
    expect(screen.getByRole('alert').textContent).toBe(
      'Não foi possível pedir a pesquisa: A pesquisa deste lead já está na fila. Aguarde ela terminar.',
    );
  });

  it('offers nothing on a research that names its pages', () => {
    render(<CompanyResearchPanel research={research(DONE)} lead={LEAD} canWrite />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/anterior à fonte por dado/)).toBeNull();
  });
});
