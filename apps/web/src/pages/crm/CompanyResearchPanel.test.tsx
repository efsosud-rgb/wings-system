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
    { key: 'activity', value: 'Rede de açaí', reason: null },
    { key: 'location', value: 'Campinas/SP', reason: null },
    { key: 'size', value: null, reason: 'Nenhuma página fala do porte' },
    { key: 'time_in_market', value: null, reason: 'As páginas encontradas não dizem isso' },
    { key: 'online_presence', value: 'Site e Instagram ativos', reason: null },
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

    const link = within(panel).getByRole('link', { name: 'Sobre a Açaí da Fila' });
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
});
