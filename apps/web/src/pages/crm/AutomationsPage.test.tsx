import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationsPage, delayText, describeRule } from './AutomationsPage.js';

const mutate = vi.fn();
const idle = { mutate, isPending: false, error: null };

vi.mock('../../api/automations.js', () => ({
  useAutomationRules: () => ({
    isLoading: false,
    data: {
      rules: [
        {
          id: 'r1',
          pipeline: 'expansao',
          stageId: 's1',
          position: 1,
          kind: 'create_task',
          config: { title: 'Ligar de novo', dueInHours: 2, businessHours: true, assignee: 'owner' },
          delayMinutes: 0,
          active: true,
        },
      ],
    },
  }),
  useEmailTemplates: () => ({ data: { templates: [] } }),
  useSequences: () => ({ data: { sequences: [] } }),
  useCreateRule: () => idle,
  useUpdateRule: () => idle,
  useDeleteRule: () => idle,
  useSaveTemplate: () => idle,
  useSaveSequence: () => idle,
}));
vi.mock('../../api/leads.js', () => ({
  useStages: () => ({
    isLoading: false,
    data: {
      stages: [
        {
          id: 's1',
          pipeline: 'expansao',
          name: 'Proposta',
          position: 1,
          active: true,
          probability: 50,
        },
        {
          id: 's2',
          pipeline: 'expansao',
          name: 'Antiga',
          position: 2,
          active: false,
          probability: 0,
        },
      ],
    },
  }),
  useSellers: () => ({
    data: { sellers: [{ id: 'u1', name: 'Thais Teste', role: 'x', active: true }] },
  }),
}));

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/crm-vendas/configuracoes" element={<p>Configurações</p>} />
        <Route
          path="/crm-vendas/configuracoes/automacoes/:pipeline"
          element={<AutomationsPage />}
        />
      </Routes>
    </MemoryRouter>,
  );

afterEach(cleanup);

describe('Regras de automação', () => {
  it('shows each active stage with its rules written in plain words', () => {
    renderAt('/crm-vendas/configuracoes/automacoes/expansao');
    expect(screen.getByRole('heading', { name: /Regras de automação · Expansão/ })).toBeTruthy();
    expect(screen.getByText(/1\. Proposta/)).toBeTruthy();
    expect(screen.queryByText(/Antiga/)).toBeNull();
    expect(
      screen.getByText(/Criar tarefa “Ligar de novo” para o responsável, prazo de 2 h úteis/),
    ).toBeTruthy();
  });

  it('opens the form to add a rule with the five actions of the Bitrix24 model', () => {
    renderAt('/crm-vendas/configuracoes/automacoes/expansao');
    fireEvent.click(screen.getByRole('button', { name: '+ Adicionar regra' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    for (const label of [
      'Criar tarefa',
      'Mudar o responsável',
      'Avisar alguém',
      'Iniciar uma sequência',
      'Enviar modelo de e-mail',
    ])
      expect(options).toContain(label);
  });

  it('sends an unknown funnel back to the settings', () => {
    renderAt('/crm-vendas/configuracoes/automacoes/outra');
    expect(screen.getByText('Configurações')).toBeTruthy();
  });

  it('writes delays and actions without ids or data of a person', () => {
    expect(delayText(0)).toBe('ao entrar na etapa');
    expect(delayText(90)).toBe('90 min depois');
    expect(delayText(120)).toBe('2 h depois');
    expect(delayText(2880)).toBe('2 dias depois');
    const refs = {
      sellers: [{ id: 'u1', name: 'Thais Teste', role: 'x', active: true }],
      templates: [],
      sequences: [],
    };
    expect(describeRule('change_owner', { to: 'rotation' }, refs)).toBe(
      'Passar para o próximo do rodízio',
    );
    expect(describeRule('notify', { recipients: ['owner', 'u1'], message: 'Atenção' }, refs)).toBe(
      'Avisar o responsável, Thais: “Atenção”',
    );
  });
});
