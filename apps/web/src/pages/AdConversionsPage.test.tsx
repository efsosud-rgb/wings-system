import type { ConversionsPanel } from '@wings/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

const panel: { current: ConversionsPanel | null; error: unknown } = { current: null, error: null };
const permissions: { current: Record<string, string> } = { current: {} };

vi.mock('../api/ads.js', () => ({
  useConversionsPanel: () =>
    panel.error
      ? { data: undefined, isError: true, error: panel.error, refetch: vi.fn() }
      : { data: panel.current, isError: false },
  useSaveConversionMapping: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../api/auth.js', () => ({
  useSession: () => ({ data: { permissions: permissions.current }, isLoading: false }),
  hasPermission: (user: { permissions: Record<string, string> } | null, permission: string) =>
    Boolean(user?.permissions[permission]),
}));
vi.mock('../api/leads.js', () => ({
  useStages: () => ({ data: { stages: [] }, isError: false }),
}));

const { AdConversionsPage } = await import('./AdConversionsPage.js');

const view = () =>
  render(
    <MemoryRouter>
      <AdConversionsPage />
    </MemoryRouter>,
  );

const loaded: ConversionsPanel = {
  since: '2026-10-20T03:00:00.000Z',
  hashedEnabled: false,
  googleValidateOnly: true,
  metaTestEvents: false,
  platforms: [
    {
      platform: 'meta',
      enabled: true,
      missing: [],
      sent: 12,
      validated: 4,
      pending: 2,
      failed: 1,
      skipped: 3,
      errors: [{ code: 'http_400:100', count: 1 }],
      skips: [{ reason: 'no_identifier', count: 3 }],
      lastSentAt: '2026-11-01T13:00:00.000Z',
    },
    {
      platform: 'google',
      enabled: false,
      missing: ['CRM_CONVERSIONS_GOOGLE_REFRESH_TOKEN'],
      sent: 0,
      validated: 0,
      pending: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      skips: [],
      lastSentAt: null,
    },
  ],
  mappings: [],
};

afterEach(() => {
  cleanup();
  panel.current = null;
  panel.error = null;
  permissions.current = {};
});

describe('AdConversionsPage', () => {
  it('shows "—" and the reason when the panel does not load, never zeros', () => {
    panel.error = new ApiError(503, { error: 'unavailable', message: 'Fora do ar' });
    view();
    expect(screen.getByRole('alert').textContent).toContain('—');
    expect(screen.queryByText('Enviados')).toBeNull();
  });

  it('shows, per platform, what went, what failed and why', () => {
    panel.current = loaded;
    permissions.current = { 'ads.read': 'all' };
    view();
    const meta = screen.getByRole('region', { name: 'Meta' });
    expect(meta.textContent).toContain('Ligado');
    expect(meta.textContent).toContain('12');
    expect(meta.textContent).toContain('http_400:100');
    // What only a rehearsal took is counted apart, never as sent.
    expect(meta.textContent).toMatch(/Só validados[^]*4/);
    expect(meta.textContent).toContain('Sem identificador');
    const google = screen.getByRole('region', { name: 'Google Ads' });
    expect(google.textContent).toContain('Desligado');
    expect(google.textContent).toContain('CRM_CONVERSIONS_GOOGLE_REFRESH_TOKEN');
    expect(screen.getByText(/nada é enviado/)).toBeTruthy();
  });

  it('offers the stage → event form only to who holds ads.approve', () => {
    panel.current = loaded;
    permissions.current = { 'ads.read': 'all' };
    view();
    expect(screen.queryByRole('form', { name: 'Etapa e evento' })).toBeNull();
    cleanup();
    permissions.current = { 'ads.read': 'all', 'ads.approve': 'all' };
    view();
    expect(screen.getByRole('form', { name: 'Etapa e evento' })).toBeTruthy();
  });
});
