import {
  SESSION_COOKIE,
  type CameraDevice,
  type CameraDeviceCreated,
  type CamerasDashboard,
} from '@wings/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { CAMERA_REASONS } from './service.js';

/**
 * Câmeras (docs/cameras.md): devices with their own token, 15-minute batches
 * replayed from a recorded (made-up) office day, and the dashboard. No image,
 * no person: the fixture holds counts only.
 */
let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

type Batch = { intervals: Record<string, unknown>[] };
const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/lote-escritorio-2026-10-20.json'), 'utf8'),
) as { porta: Batch; 'sala-1': Batch };

type Login = { id: string; cookies: Record<string, string> };
async function login(role: 'admin_master' | 'diretoria' | 'marketing'): Promise<Login> {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'marketing' ? 'marketing' : 'diretoria',
  });
  const answer = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = answer.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

let admin: Login;
let director: Login;
let marketing: Login;
let door: CameraDeviceCreated;
let room: CameraDeviceCreated;
let probe: CameraDeviceCreated;

const WEEK = 'period=custom&from=2026-10-19&to=2026-10-25';
const send = (token: string | null, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: '/public/cameras/batches',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload: payload as Record<string, unknown>,
  });
const dashboard = async (who: Login, query = WEEK) => {
  const answer = await app.inject({
    method: 'GET',
    url: `/cameras/dashboard?${query}`,
    cookies: who.cookies,
  });
  expect(answer.statusCode).toBe(200);
  return answer.json<CamerasDashboard>();
};
const factRows = async (fonte: string) =>
  Number(
    (
      await db.execute<{ n: string }>(
        sql`select count(*) as n from dw.fato_fluxo_area where fonte = ${fonte}`,
      )
    ).rows[0]?.n,
  );

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
    }),
    db,
  });
  admin = await login('admin_master');
  director = await login('diretoria');
  marketing = await login('marketing');
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

describe('Câmeras', () => {
  it('shows "—" with the reason before any device exists', async () => {
    const empty = await dashboard(admin);
    expect(empty.reason).toBe(CAMERA_REASONS.noDevice);
    expect(empty.byHour.every((h) => h.entries === null)).toBe(true);
    expect(empty.reservedEmpty).toEqual({ count: null, reason: CAMERA_REASONS.agendaRooms });
    expect(empty.loadedAt).toBeNull();
    expect(empty.canManage).toBe(true);
  });

  it('the Admin Master registers devices and sees the token once; the list never carries it; Diretoria may not register', async () => {
    const made = await app.inject({
      method: 'POST',
      url: '/cameras/devices',
      cookies: admin.cookies,
      payload: {
        unitName: 'Escritório Wings',
        unitKind: 'escritorio',
        areaCode: 'porta',
        areaName: 'Porta',
        areaKind: 'porta',
        name: 'Câmera da porta',
        kind: 'camera',
      },
    });
    expect(made.statusCode).toBe(201);
    door = made.json<CameraDeviceCreated>();
    expect(door.token.length).toBeGreaterThanOrEqual(32);
    expect(door.device).toMatchObject({
      name: 'Câmera da porta',
      area: { code: 'porta', kind: 'porta' },
      unit: { name: 'Escritório Wings', kind: 'escritorio' },
      test: false,
      active: true,
      lastBatchAt: null,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/cameras/devices',
      cookies: admin.cookies,
      payload: {
        unitId: door.device.unit.id,
        areaCode: 'sala-1',
        areaName: 'Sala 1',
        areaKind: 'sala_reuniao',
        capacity: 8,
        name: 'Caixa da sala 1',
        kind: 'caixa',
      },
    });
    expect(second.statusCode).toBe(201);
    room = second.json<CameraDeviceCreated>();
    expect(room.device.unit.id).toBe(door.device.unit.id);
    const third = await app.inject({
      method: 'POST',
      url: '/cameras/devices',
      cookies: admin.cookies,
      payload: {
        unitId: door.device.unit.id,
        areaCode: 'recepcao',
        areaName: 'Recepção',
        areaKind: 'recepcao',
        name: 'Simulador de teste',
        kind: 'caixa',
        test: true,
      },
    });
    expect(third.statusCode).toBe(201);
    probe = third.json<CameraDeviceCreated>();
    expect(probe.device.test).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: '/cameras/devices',
      cookies: director.cookies,
    });
    expect(list.statusCode).toBe(200);
    const devices = list.json<{ devices: CameraDevice[] }>().devices;
    expect(devices.map((d) => d.name).sort()).toEqual(
      ['Caixa da sala 1', 'Câmera da porta', 'Simulador de teste'].sort(),
    );
    expect(list.body).not.toContain(door.token);
    expect(list.body).not.toContain('tokenHash');

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/cameras/devices',
          cookies: director.cookies,
          payload: {
            unitId: door.device.unit.id,
            areaCode: 'x',
            areaName: 'Área X',
            areaKind: 'outra',
            name: 'Outra',
            kind: 'camera',
          },
        })
      ).statusCode,
    ).toBe(403);
    const withImage = await app.inject({
      method: 'POST',
      url: '/cameras/devices',
      cookies: admin.cookies,
      payload: {
        unitId: door.device.unit.id,
        areaCode: 'x',
        areaName: 'Área X',
        areaKind: 'outra',
        name: 'Outra',
        kind: 'camera',
        image: 'data:image/png;base64,AAAA',
      },
    });
    expect(withImage.statusCode).toBe(400);
    const unknownUnit = await app.inject({
      method: 'POST',
      url: '/cameras/devices',
      cookies: admin.cookies,
      payload: {
        unitId: '7d3c2b1a-5e4f-4a6b-8c9d-0e1f2a3b4c5d',
        areaCode: 'x',
        areaName: 'Área X',
        areaKind: 'outra',
        name: 'Outra',
        kind: 'camera',
      },
    });
    expect(unknownUnit.statusCode).toBe(404);
  });

  it('a device delivers its batch with its own token, idempotently by device and interval; anything that is not a count is refused', async () => {
    const first = await send(door.token, fixture.porta);
    expect([first.statusCode, first.json()]).toEqual([200, { accepted: 40, alerts: 0 }]);
    const again = await send(door.token, fixture.porta);
    expect(again.statusCode).toBe(200);
    expect(await factRows('dispositivo')).toBe(40);

    // A corrected interval replaces the numbers of that interval only.
    const corrected = { intervals: [{ ...fixture.porta.intervals[0]!, entries: 30 }] };
    expect((await send(door.token, corrected)).statusCode).toBe(200);
    expect(await factRows('dispositivo')).toBe(40);
    const eight = await db.execute<{ entradas: number }>(
      sql`select entradas from dw.fato_fluxo_area where inicio_em = '2026-10-20T08:00:00-03:00'`,
    );
    expect(eight.rows[0]?.entradas).toBe(30);
    expect((await send(door.token, fixture.porta)).statusCode).toBe(200);

    expect((await send(null, fixture.porta)).statusCode).toBe(401);
    expect((await send('nao-e-um-token', fixture.porta)).statusCode).toBe(401);
    const withImage = await send(door.token, {
      intervals: [{ ...fixture.porta.intervals[0]!, image: 'data:image/jpeg;base64,/9j/4AAQ' }],
    });
    expect(withImage.statusCode).toBe(400);
    expect(withImage.json<{ message: string }>().message).toContain('image');
    const frame = await send(door.token, {
      intervals: fixture.porta.intervals.slice(0, 1),
      frame: 'AAAA',
    });
    expect(frame.statusCode).toBe(400);
    const offQuarter = await send(door.token, {
      intervals: [{ ...fixture.porta.intervals[0]!, startsAt: '2026-10-20T08:07:00-03:00' }],
    });
    expect(offQuarter.statusCode).toBe(400);
    expect(offQuarter.json<{ message: string }>().message).toContain('quarto de hora');
    expect(await factRows('dispositivo')).toBe(40);
  });

  it('answers entries by hour and weekday, the peaks, the rooms and the alerts; a test device never reaches the panel', async () => {
    expect((await send(room.token, fixture['sala-1'])).statusCode).toBe(200);
    const loud = {
      intervals: fixture.porta.intervals.map((i) => ({ ...i, entries: 999, exits: 999 })),
    };
    expect((await send(probe.token, loud)).statusCode).toBe(200);
    expect(await factRows('teste')).toBe(40);

    const data = await dashboard(admin);
    expect(data.reason).toBeNull();
    expect(data.unit).toBeNull();
    expect(data.units.map((u) => u.name)).toEqual(['Escritório Wings']);
    expect(data.byHour[9]).toEqual({ hour: 9, entries: 35 });
    expect(data.byHour[3]).toEqual({ hour: 3, entries: 0 });
    expect(data.byWeekday[1]).toEqual({ weekday: 2, entries: 169 });
    expect(data.byWeekday[0]).toEqual({ weekday: 1, entries: 0 });
    expect(data.peaks).toEqual([
      { hour: 9, entries: 35 },
      { hour: 14, entries: 34 },
      { hour: 12, entries: 22 },
    ]);
    expect(data.rooms).toEqual([
      {
        code: 'sala-1',
        name: 'Sala 1',
        capacity: 8,
        slotsObserved: 32,
        slotsOccupied: 13,
        maxOccupancy: 5,
        avgDwellMinutes: 45,
      },
    ]);
    expect(data.alerts).toEqual([{ kind: 'sala_ocupada_sem_reserva', count: 1 }]);
    expect(data.reservedEmpty.count).toBeNull();
    expect(data.devices.map((d) => [d.name, d.reason])).toEqual([
      ['Câmera da porta', null],
      ['Caixa da sala 1', null],
    ]);
    expect(data.loadedAt).not.toBeNull();
    expect(data.devices.map((d) => d.name)).not.toContain('Simulador de teste');

    const byUnit = await dashboard(admin, `${WEEK}&unit=${door.device.unit.id}`);
    expect(byUnit.unit?.name).toBe('Escritório Wings');
    expect(byUnit.byWeekday[1]?.entries).toBe(169);

    const quiet = await dashboard(admin, 'period=custom&from=2026-11-02&to=2026-11-08');
    expect(quiet.reason).toBe(CAMERA_REASONS.noBatchInRange);
    expect(quiet.byHour.every((h) => h.entries === null)).toBe(true);
    expect(quiet.devices.every((d) => d.reason === CAMERA_REASONS.noBatchInRange)).toBe(true);

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/cameras/dashboard?${WEEK}&unit=7d3c2b1a-5e4f-4a6b-8c9d-0e1f2a3b4c5d`,
          cookies: admin.cookies,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('Diretoria reads the panel without managing; other levels get 403; anonymous 401; a revoked token is refused', async () => {
    const seen = await dashboard(director);
    expect(seen.canManage).toBe(false);
    expect(seen.peaks[0]?.hour).toBe(9);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/cameras/dashboard?${WEEK}`,
          cookies: marketing.cookies,
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/cameras/dashboard' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/cameras/devices/${probe.device.id}/revoke`,
          cookies: director.cookies,
        })
      ).statusCode,
    ).toBe(403);
    const revoked = await app.inject({
      method: 'POST',
      url: `/cameras/devices/${probe.device.id}/revoke`,
      cookies: admin.cookies,
    });
    expect(revoked.statusCode).toBe(200);
    expect((await send(probe.token, fixture.porta)).statusCode).toBe(410);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/cameras/devices/${probe.device.id}/revoke`,
          cookies: admin.cookies,
        })
      ).statusCode,
    ).toBe(404);
  });
});
