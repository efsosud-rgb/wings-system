import { LEAD_PIPELINES } from '@wings/shared';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { CrmSettingsPage } from './CrmSettingsPage.js';

/** The settings tabs: a request that failed says why; it never reads as an empty list. */

const { answer } = vi.hoisted(() => ({
  answer: {} as Record<'stages' | 'sellers' | 'distribution' | 'brands', Record<string, unknown>>,
}));

const idle = { mutate: vi.fn(), isPending: false, error: null };
const ok = { isLoading: false, isError: false, isSuccess: true };

vi.mock('../../api/crm.js', () => ({
  useBrands: () => ({ ...ok, data: { brands: [] }, ...answer.brands }),
  useCreateBrand: () => idle,
  useSetBrandOnSale: () => idle,
}));
vi.mock('../../api/leads.js', () => ({
  useStages: () => ({ ...ok, data: { stages: [] }, ...answer.stages }),
  useCreateStage: () => idle,
  useUpdateStage: () => idle,
  useReorderStages: () => idle,
  useSellers: () => ({ ...ok, data: { sellers: [] }, ...answer.sellers }),
  useSetDistribution: () => idle,
  useDistribution: () => ({ ...ok, data: { distributions: [] }, ...answer.distribution }),
}));

const failed = (error: unknown) => ({
  data: undefined,
  isLoading: false,
  isError: true,
  isSuccess: false,
  error,
  refetch: vi.fn(),
});

beforeEach(() => {
  answer.stages = {};
  answer.sellers = {};
  answer.distribution = {};
  answer.brands = {};
});
afterEach(cleanup);

describe('Configurações do CRM', () => {
  it('the stages that did not load say why', () => {
    answer.stages = failed(new ApiError(500, {}));
    render(<CrmSettingsPage />);
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent ?? '');
    expect(alerts).toHaveLength(LEAD_PIPELINES.length); // one per funnel
    expect(alerts[0]).toContain('Não foi possível carregar as etapas');
    expect(alerts[0]).toContain('erro 500');
  });

  it('the rotation that did not load says why, not a blank tab', () => {
    answer.distribution = failed(new ApiError(403, {}));
    render(<CrmSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Distribuição' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar a distribuição',
    );
    expect(screen.getByRole('alert').textContent).toContain('você não tem permissão');
  });

  it('the brands that did not load say why, before the form to register one', () => {
    answer.brands = failed(new TypeError('x'));
    render(<CrmSettingsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Marcas' }));
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar as marcas');
    expect(screen.getByRole('alert').textContent).toContain('sem conexão com o servidor');
  });

  it('shows no failure line when everything loaded', () => {
    render(<CrmSettingsPage />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
