import type { CamerasDashboard } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CamerasPage } from './CamerasPage.js';

/** Gestão → Câmeras with made-up counts: never a person, never an image. */
const hours = (entries: Record<number, number>) =>
  Array.from({ length: 24 }, (_, hour) => ({ hour, entries: entries[hour] ?? 0 }));

const answer = (overrides: Partial<CamerasDashboard> = {}): CamerasDashboard => ({
  unit: null,
  units: [{ id: 'u1', name: 'Escritório Wings', kind: 'escritorio' }],
  range: { from: '2026-09-27', to: '2026-10-26' },
  byHour: hours({ 9: 35, 12: 22, 14: 34 }),
  byWeekday: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    entries: weekday === 2 ? 169 : 0,
  })),
  peaks: [
    { hour: 9, entries: 35 },
    { hour: 14, entries: 34 },
    { hour: 12, entries: 22 },
  ],
  rooms: [
    {
      code: 'sala-1',
      name: 'Sala 1',
      capacity: 8,
      slotsObserved: 32,
      slotsOccupied: 13,
      maxOccupancy: 5,
      avgDwellMinutes: 45,
    },
  ],
  alerts: [{ kind: 'sala_ocupada_sem_reserva', count: 1 }],
  reservedEmpty: { count: null, reason: 'a Agenda ainda não cadastra salas de reunião' },
  devices: [
    {
      id: 'd1',
      name: 'Câmera da porta',
      area: 'Porta',
      kind: 'camera',
      lastBatchAt: '2026-10-20T21:00:00.000Z',
      reason: null,
    },
    {
      id: 'd2',
      name: 'Caixa da sala 2',
      area: 'Sala 2',
      kind: 'caixa',
      lastBatchAt: null,
      reason: 'dispositivo ainda não instalado: nenhum lote recebido',
    },
  ],
  reason: null,
  canManage: false,
  loadedAt: '2026-10-20T21:00:00.000Z',
  ...overrides,
});

let data = answer();
const calls: Record<string, string>[] = [];
const created = vi.fn();

vi.mock('../api/cameras.js', () => ({
  useCamerasDashboard: (query: Record<string, string>) => {
    calls.push(query);
    return { data, isLoading: false, isError: false };
  },
  useCreateCameraDevice: () => ({
    isPending: false,
    isError: false,
    error: null,
    mutate: (input: unknown, options: { onSuccess: (answer: unknown) => void }) => {
      created(input);
      options.onSuccess({
        device: {
          ...data.devices[0],
          name: 'Câmera nova',
          unit: data.units[0],
          area: { code: 'porta', name: 'Porta', kind: 'porta' },
          test: false,
          active: true,
          createdAt: '2026-10-26T00:00:00Z',
        },
        token: 'token-de-teste-que-aparece-uma-vez',
      });
    },
  }),
  useRevokeCameraDevice: () => ({ isPending: false, mutate: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  calls.length = 0;
  created.mockClear();
  data = answer();
});

const open = (url = '/gestao/cameras') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <CamerasPage />
    </MemoryRouter>,
  );

describe('Gestão › Câmeras', () => {
  it('shows entries by hour and weekday, the peaks, the rooms, the alerts and "—" with the reason where there is no number', () => {
    open();
    expect(screen.getByRole('row', { name: /09h/ }).textContent).toContain('35');
    expect(screen.getByRole('row', { name: /Terça/ }).textContent).toContain('169');
    expect(screen.getByText('09h: 35 entradas')).toBeTruthy();
    const room = screen.getByRole('row', { name: /Sala 1/ });
    expect(room.textContent).toContain('41% (13/32)');
    expect(room.textContent).toContain('45 min');
    expect(screen.getByText(/a Agenda ainda não cadastra salas de reunião/)).toBeTruthy();
    expect(screen.getByText(/Sala ocupada sem reserva · 1/)).toBeTruthy();
    const notInstalled = screen.getByRole('row', { name: /Caixa da sala 2/ });
    expect(notInstalled.textContent).toContain('—');
    expect(notInstalled.textContent).toContain('dispositivo ainda não instalado');
    expect(screen.queryByRole('form', { name: 'Cadastrar dispositivo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revogar token' })).toBeNull();
    expect(calls[0]).toEqual({ period: '30d' });
  });

  it('with no device yet, says so instead of showing zeros', () => {
    data = answer({
      devices: [],
      rooms: [],
      alerts: [],
      peaks: [],
      byHour: hours({}).map((h) => ({ ...h, entries: null })),
      byWeekday: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, entries: null })),
      reason: 'nenhum dispositivo cadastrado',
      loadedAt: null,
    });
    open('/gestao/cameras?periodo=90d&unidade=u1');
    expect(screen.getAllByText(/nenhum dispositivo cadastrado/).length).toBeGreaterThan(0);
    expect(
      within(screen.getByRole('row', { name: /09h/ })).getByLabelText(/sem dado/),
    ).toBeTruthy();
    expect(screen.getByText(/nenhum lote recebido/)).toBeTruthy();
    expect(calls[0]).toEqual({ period: '90d', unit: 'u1' });
  });

  it('lets the Admin Master register a device and shows the token once', () => {
    data = answer({ canManage: true });
    open();
    const form = screen.getByRole('form', { name: 'Cadastrar dispositivo' });
    fireEvent.change(within(form).getByLabelText('Código da área'), { target: { value: 'porta' } });
    fireEvent.change(within(form).getByLabelText('Nome da área'), { target: { value: 'Porta' } });
    fireEvent.change(within(form).getByLabelText('Nome do dispositivo'), {
      target: { value: 'Câmera nova' },
    });
    fireEvent.submit(form);
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        unitId: 'u1',
        areaCode: 'porta',
        areaName: 'Porta',
        name: 'Câmera nova',
        kind: 'camera',
        test: false,
      }),
    );
    expect(screen.getByText('token-de-teste-que-aparece-uma-vez')).toBeTruthy();
    expect(screen.getByText(/não é mostrado de novo/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Revogar token' })).toHaveLength(2);
  });
});
