import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { AutomationsPage, delayText, describeRule } from './AutomationsPage.js';

const mutate = vi.fn();
const idle = { mutate, isPending: false, error: null };
// What a query answers instead of its default (a failed request); reset before every test.
const { answer } = vi.hoisted(() => ({
  answer: {} as Record<'rules' | 'templates' | 'sequences' | 'limits' | 'stages', unknown>,
}));

vi.mock('../../api/automations.js', () => ({
  useAutomationRules: () => ({
    isLoading: false,
    isError: false,
    isSuccess: true,
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
    ...(answer.rules as object),
  }),
  useEmailTemplates: () => ({
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: { templates: [] },
    ...(answer.templates as object),
  }),
  useSequences: () => ({
    isLoading: false,
    isError: false,
    isSuccess: true,
    data: { sequences: [] },
    ...(answer.sequences as object),
  }),
  useCreateRule: () => idle,
  useUpdateRule: () => idle,
  useDeleteRule: () => idle,
  useSaveTemplate: () => idle,
  useSaveSequence: () => idle,
  useStageLimits: () => ({
    isError: false,
    data: { limits: [] },
    ...(answer.limits as object),
  }),
  useSetStageLimit: () => idle,
}));
vi.mock('../../api/leads.js', () => ({
  useStages: () => ({
    isLoading: false,
    isError: false,
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
    ...(answer.stages as object),
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

beforeEach(() => {
  for (const key of Object.keys(answer) as (keyof typeof answer)[]) delete answer[key];
});
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

describe('when a request fails', () => {
  const failed = (error: unknown) => ({
    data: undefined,
    isLoading: false,
    isError: true,
    isSuccess: false,
    error,
    refetch: vi.fn(),
  });
  const open = (tab?: string) => {
    renderAt('/crm-vendas/configuracoes/automacoes/expansao');
    if (tab) fireEvent.click(screen.getByRole('button', { name: tab }));
  };

  it('the rules that did not load say why, not "Nenhuma regra" under every stage', () => {
    answer.rules = failed(new ApiError(500, {}));
    open();
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar as regras');
    expect(screen.getByRole('alert').textContent).toContain('erro 500');
    expect(screen.queryByText(/Nenhuma regra/)).toBeNull();
    expect(screen.queryByText(/1\. Proposta/)).toBeNull();
  });

  it('the stages that did not load say why, not an empty page', () => {
    answer.stages = failed(new ApiError(401, {}));
    open();
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar as etapas');
    expect(screen.getByRole('alert').textContent).toContain('sua sessão expirou');
  });

  it('a stage with no rule still says "Nenhuma regra" when the request succeeded', () => {
    answer.rules = { data: { rules: [] } };
    open();
    expect(screen.getByText(/Nenhuma regra: nada acontece sozinho/)).toBeTruthy();
  });

  it('the e-mail templates that did not load say why, not "Nenhum modelo ainda."', () => {
    answer.templates = failed(new TypeError('x'));
    open('Modelos de e-mail');
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
    expect(screen.queryByText('Nenhum modelo ainda.')).toBeNull();
  });

  it('the e-mail templates still say "Nenhum modelo ainda." when the request succeeded empty', () => {
    open('Modelos de e-mail');
    expect(screen.getByText('Nenhum modelo ainda.')).toBeTruthy();
  });

  it('the sequences that did not load say why, not "Nenhuma sequência ainda."', () => {
    answer.sequences = failed(new ApiError(403, {}));
    open('Sequências');
    expect(screen.getByRole('alert').textContent).toContain('você não tem permissão');
    expect(screen.queryByText('Nenhuma sequência ainda.')).toBeNull();
  });

  it('the stage limit that did not load shows "—" and why, not a blank "padrão do sistema" field', () => {
    answer.limits = failed(new ApiError(500, {}));
    open();
    expect(screen.queryByText(/em branco: padrão do sistema/)).toBeNull();
    expect(screen.getByText(/Avisar negociação parada após quantos dias/).textContent).toContain(
      'erro 500',
    );
  });
});
