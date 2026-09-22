import { beforeEach, describe, expect, it } from 'vitest';
import { BUILDER_HANDOFF_KEY, takeBuilderHandoff, writeBuilderHandoff } from './builder-handoff.js';

const proposal = {
  platform: 'google_search' as const,
  name: 'Pesquisa | Franquia SP',
  objective: 'lead' as const,
  idealCustomerProfile: 'Empresário dono de negócio que quer expandir por franquias.',
  reach: { states: ['SP' as const], cities: [], customLocations: [] },
  destinationUrl: 'https://wingscompany.com.br/franquia',
  utms: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'pesquisa', utm_content: '' },
  dailyBudgetCents: 4000,
  startDate: '2026-09-28',
  endDate: '2026-10-11',
  copy: [],
  search: {
    keywords: [
      { text: 'abrir franquia', match: 'exact' as const },
      { text: 'franquia de alimentação', match: 'phrase' as const },
      { text: 'como franquear meu negócio', match: 'broad' as const },
    ],
    negativeKeywords: ['grátis', 'vaga', 'emprego', 'curso', 'currículo'],
    headlines: ['Franquia Wings'],
    descriptions: ['Conheça o modelo.'],
  },
  explanations: [
    { field: 'objective' as const, reason: 'Leads.' },
    { field: 'idealCustomerProfile' as const, reason: 'Perfil salvo.' },
    { field: 'reach' as const, reason: 'Menor CPL em SP.' },
    { field: 'dailyBudgetCents' as const, reason: 'Cabe no teto.' },
    { field: 'dates' as const, reason: 'Duas semanas.' },
    { field: 'search' as const, reason: 'Termos que já converteram.' },
  ],
  assumptions: ['Assumi que a página tem o formulário.'],
  summary: 'Pesquisa para leads em SP.',
};

beforeEach(() => sessionStorage.clear());

describe('the handoff to the builder', () => {
  it('is read once and then gone', () => {
    writeBuilderHandoff({ proposal, pending: ['Link do vídeo'] });
    const first = takeBuilderHandoff();
    expect(first?.proposal.name).toBe('Pesquisa | Franquia SP');
    expect(first?.pending).toEqual(['Link do vídeo']);
    expect(takeBuilderHandoff()).toBeNull();
    expect(sessionStorage.getItem(BUILDER_HANDOFF_KEY)).toBeNull();
  });

  it('refuses what does not validate as a proposal', () => {
    sessionStorage.setItem(BUILDER_HANDOFF_KEY, JSON.stringify({ proposal: { name: 'x' }, pending: [] }));
    expect(takeBuilderHandoff()).toBeNull();
    sessionStorage.setItem(BUILDER_HANDOFF_KEY, 'not json');
    expect(takeBuilderHandoff()).toBeNull();
  });
});
