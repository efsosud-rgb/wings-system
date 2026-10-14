import type { Lead, LeadWebResearch } from '@wings/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanyResearchPanel } from './CompanyResearchPanel.js';

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
