/**
 * Câmeras (docs/cameras.md): devices, the 15-minute batches they send and the
 * dashboard. Everything here is counts: the video never leaves the site, and
 * no image, face or identity reaches this module (the batch schema in
 * `@wings/shared` is strict, so a field the contract does not name is refused
 * as a whole). Names of units, areas and devices are places and equipment,
 * never people. Only the SHA-256 of a device's token is stored.
 */
import {
  can,
  salesRanges,
  type Actor,
  type CameraAlertKind,
  type CameraBatchInput,
  type CameraDevice,
  type CameraDeviceCreateInput,
  type CameraDeviceKind,
  type CamerasDashboard,
  type CamerasQuery,
  type CameraUnitKind,
} from '@wings/shared';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { cameraDevices } from '../../db/schema/index.js';
import { generateToken, hashToken } from '../../lib/tokens.js';

export const CAMERA_REASONS = {
  noDevice: 'nenhum dispositivo cadastrado',
  notInstalled: 'dispositivo ainda não instalado: nenhum lote recebido',
  noBatchInRange: 'nenhum lote recebido no período',
  noDoor: 'nenhum dispositivo na porta: as entradas não são contadas',
  agendaRooms: 'a Agenda ainda não cadastra salas de reunião',
} as const;

const tenantSk = sql`(select tenant_sk from dw.dim_tenant where tenant_id = ${WINGS_TENANT_ID})`;
const num = (value: unknown) => Number(value ?? 0);
const numOrNull = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
const skOf = (day: string) => Number(day.replaceAll('-', ''));

// --- devices (Admin Master) ----------------------------------------------------------------

type DeviceRow = {
  id: string;
  name: string;
  kind: CameraDeviceKind;
  unit_id: string;
  unit_name: string;
  unit_kind: CameraUnitKind;
  area_code: string;
  area_name: string;
  area_kind: CameraDevice['area']['kind'];
  test: boolean;
  active: boolean;
  created_at: string;
  last_batch_at: string | null;
};

const toDevice = (row: DeviceRow): CameraDevice => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  unit: { id: row.unit_id, name: row.unit_name, kind: row.unit_kind },
  area: { code: row.area_code, name: row.area_name, kind: row.area_kind },
  test: row.test,
  active: row.active,
  createdAt: new Date(row.created_at).toISOString(),
  lastBatchAt: row.last_batch_at ? new Date(row.last_batch_at).toISOString() : null,
});

const deviceSelect = sql`
  select cd.id, d.nome as name, d.tipo as kind, u.unidade_id as unit_id, u.nome as unit_name, u.tipo as unit_kind,
         a.area_codigo as area_code, a.nome as area_name, a.tipo as area_kind,
         cd.test, cd.revoked_at is null as active, cd.created_at::text as created_at, cd.last_batch_at::text as last_batch_at
  from camera_devices cd
  join dw.dim_dispositivo d on d.dispositivo_id = cd.id::text
  join dw.dim_unidade u on u.unidade_sk = d.unidade_sk
  join dw.dim_area a on a.area_sk = d.area_sk`;

export async function listDevices(db: Database): Promise<CameraDevice[]> {
  const rows = await db.execute<DeviceRow>(
    sql`${deviceSelect} where cd.tenant_id = ${WINGS_TENANT_ID} order by u.nome, a.nome, d.nome`,
  );
  return rows.rows.map(toDevice);
}

/**
 * Registers a device in its unit and area (the unit may be an existing one by id; the area is
 * upserted by code) and hands back the token once. Returns `unit_not_found` for an unknown unit id.
 */
export async function registerDevice(
  db: Database,
  input: CameraDeviceCreateInput,
  actorEmployeeId: string,
): Promise<{ device: CameraDevice; token: string } | 'unit_not_found'> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into dw.dim_tenant (tenant_id, nome, tipo)
      select id::text, name, 'wings' from tenants where id = ${WINGS_TENANT_ID}
      on conflict (tenant_id) do nothing`);
    let unitId = input.unitId;
    if (unitId) {
      const found = await tx.execute(
        sql`select 1 from dw.dim_unidade where unidade_id = ${unitId} and tenant_sk = ${tenantSk}`,
      );
      if (found.rows.length === 0) return 'unit_not_found';
    } else {
      unitId = randomUUID();
      await tx.execute(sql`
        insert into dw.dim_unidade (unidade_id, tenant_sk, nome, tipo, cidade, uf)
        values (${unitId}, ${tenantSk}, ${input.unitName}, ${input.unitKind}, ${input.city ?? null}, ${input.uf ?? null})`);
    }
    const area = await tx.execute<{ area_sk: number }>(sql`
      insert into dw.dim_area (tenant_sk, unidade_sk, area_codigo, nome, tipo, capacidade)
      select ${tenantSk}, u.unidade_sk, ${input.areaCode}, ${input.areaName}, ${input.areaKind}, ${input.capacity ?? null}
      from dw.dim_unidade u where u.unidade_id = ${unitId}
      on conflict (unidade_sk, area_codigo) do update
        set nome = excluded.nome, tipo = excluded.tipo, capacidade = coalesce(excluded.capacidade, dw.dim_area.capacidade)
      returning area_sk`);
    const token = generateToken();
    const [device] = await tx
      .insert(cameraDevices)
      .values({ tokenHash: hashToken(token), test: input.test, createdBy: actorEmployeeId })
      .returning({ id: cameraDevices.id });
    if (!device) throw new Error('camera device insert returned no row');
    await tx.execute(sql`
      insert into dw.dim_dispositivo (dispositivo_id, tenant_sk, unidade_sk, area_sk, nome, tipo, fabricante, modelo, teste)
      select ${device.id}, ${tenantSk}, u.unidade_sk, ${area.rows[0]!.area_sk}, ${input.name}, ${input.kind},
             ${input.manufacturer ?? null}, ${input.model ?? null}, ${input.test}
      from dw.dim_unidade u where u.unidade_id = ${unitId}`);
    const rows = await tx.execute<DeviceRow>(sql`${deviceSelect} where cd.id = ${device.id}`);
    return { device: toDevice(rows.rows[0]!), token };
  });
}

/** Ends a device's token; its facts stay. False when the device is unknown or already revoked. */
export async function revokeDevice(db: Database, id: string, now = new Date()): Promise<boolean> {
  const revoked = await db
    .update(cameraDevices)
    .set({ revokedAt: now })
    .where(and(eq(cameraDevices.id, id), isNull(cameraDevices.revokedAt)))
    .returning({ id: cameraDevices.id });
  if (revoked.length === 0) return false;
  await db.execute(sql`update dw.dim_dispositivo set ativo = false where dispositivo_id = ${id}`);
  return true;
}

export interface DeviceByToken {
  id: string;
  test: boolean;
  revoked: boolean;
  dispositivoSk: number;
  tenantSk: number;
  unidadeSk: number;
  areaSk: number;
}

/** The device a bearer token names, by the token's hash; null for an unknown token. */
export async function deviceByToken(db: Database, token: string): Promise<DeviceByToken | null> {
  const rows = await db.execute<{
    id: string;
    test: boolean;
    revoked: boolean;
    dispositivo_sk: number;
    tenant_sk: number;
    unidade_sk: number;
    area_sk: number;
  }>(sql`
    select cd.id, cd.test, cd.revoked_at is not null as revoked, d.dispositivo_sk, d.tenant_sk, d.unidade_sk, d.area_sk
    from camera_devices cd join dw.dim_dispositivo d on d.dispositivo_id = cd.id::text
    where cd.token_hash = ${hashToken(token)}`);
  const row = rows.rows[0];
  return row
    ? {
        id: row.id,
        test: row.test,
        revoked: row.revoked,
        dispositivoSk: Number(row.dispositivo_sk),
        tenantSk: Number(row.tenant_sk),
        unidadeSk: Number(row.unidade_sk),
        areaSk: Number(row.area_sk),
      }
    : null;
}

// --- the batch ---------------------------------------------------------------------------------

/** The interval's start must sit on a quarter hour inside the calendar (2024–2030). */
export function intervalProblem(startsAt: string): string | null {
  const at = new Date(startsAt);
  if (at.getUTCSeconds() !== 0 || at.getUTCMilliseconds() !== 0 || at.getUTCMinutes() % 15 !== 0)
    return 'o início de cada intervalo tem de cair num quarto de hora (:00, :15, :30, :45)';
  const year = at.getUTCFullYear();
  if (year < 2024 || year > 2030) return 'intervalo fora do calendário do modelo (2024 a 2030)';
  return null;
}

/**
 * Writes a device's batch: one row per interval in `fato_fluxo_area`, upserted by the key
 * device + interval (a batch sent twice changes nothing; a corrected one replaces the numbers),
 * and one row per alert in `fato_alerta`. A test device's rows carry `fonte = teste` and never
 * reach the dashboard.
 */
export async function ingestBatch(
  db: Database,
  device: DeviceByToken,
  batch: CameraBatchInput,
  now = new Date(),
): Promise<{ accepted: number; alerts: number }> {
  const fonte = device.test ? 'teste' : 'dispositivo';
  let alerts = 0;
  await db.transaction(async (tx) => {
    for (const interval of batch.intervals) {
      const at = new Date(interval.startsAt);
      await tx.execute(sql`
        insert into dw.fato_fluxo_area (data_sk, faixa_sk, tenant_sk, unidade_sk, area_sk, dispositivo_sk,
          entradas, saidas, ocupacao_maxima, permanencia_segundos, permanencias, inicio_em, fonte, carregado_em)
        values (dw.data_sk(${at}), dw.faixa_sk(${at}), ${device.tenantSk}, ${device.unidadeSk}, ${device.areaSk}, ${device.dispositivoSk},
          ${interval.entries}, ${interval.exits}, ${interval.maxOccupancy}, ${interval.dwellSeconds}, ${interval.dwellCount}, ${at}, ${fonte}, ${now})
        on conflict (data_sk, faixa_sk, area_sk, dispositivo_sk) do update
          set entradas = excluded.entradas, saidas = excluded.saidas, ocupacao_maxima = excluded.ocupacao_maxima,
              permanencia_segundos = excluded.permanencia_segundos, permanencias = excluded.permanencias,
              inicio_em = excluded.inicio_em, fonte = excluded.fonte, carregado_em = excluded.carregado_em`);
      for (const alert of interval.alerts) {
        const started = new Date(alert.startedAt);
        await tx.execute(sql`
          insert into dw.fato_alerta (alerta_id, data_sk, faixa_sk, tenant_sk, unidade_sk, area_sk, dispositivo_sk,
            tipo, pessoas, iniciado_em, encerrado_em, fonte, carregado_em)
          values (${`${device.id}:${started.toISOString()}:${alert.kind}`}, dw.data_sk(${started}), dw.faixa_sk(${started}),
            ${device.tenantSk}, ${device.unidadeSk}, ${device.areaSk}, ${device.dispositivoSk},
            ${alert.kind}, ${alert.people}, ${started}, ${alert.endedAt ? new Date(alert.endedAt) : null}, ${fonte}, ${now})
          on conflict (alerta_id) do update
            set pessoas = excluded.pessoas, encerrado_em = excluded.encerrado_em, fonte = excluded.fonte, carregado_em = excluded.carregado_em`);
        alerts += 1;
      }
    }
    await tx.update(cameraDevices).set({ lastBatchAt: now }).where(eq(cameraDevices.id, device.id));
  });
  return { accepted: batch.intervals.length, alerts };
}

// --- the dashboard -------------------------------------------------------------------------------

export async function camerasDashboardOf(
  db: Database,
  query: CamerasQuery,
  actor: Actor,
  now = new Date(),
): Promise<CamerasDashboard | 'unit_not_found'> {
  const range = salesRanges(query.period, now, { from: query.from, to: query.to }).current;
  const fromSk = skOf(range.from);
  const toSk = skOf(range.to);
  const units = (
    await db.execute<{ id: string; name: string; kind: CameraUnitKind; sk: number }>(sql`
      select unidade_id as id, nome as name, tipo as kind, unidade_sk as sk
      from dw.dim_unidade where tenant_sk = ${tenantSk} and unidade_sk <> 0 and ativo order by nome`)
  ).rows;
  const unit = query.unit ? units.find((u) => u.id === query.unit) : undefined;
  if (query.unit && !unit) return 'unit_not_found';
  const unitFilter = unit ? sql`and f.unidade_sk = ${unit.sk}` : sql``;
  const base = sql`f.tenant_sk = ${tenantSk} and f.fonte <> 'teste' and f.data_sk between ${fromSk} and ${toSk} ${unitFilter}`;

  const devices = (
    await db.execute<{
      id: string;
      name: string;
      kind: CameraDeviceKind;
      area: string;
      area_kind: string;
      last_batch_at: string | null;
      in_range: boolean;
    }>(sql`
      select d.dispositivo_id as id, d.nome as name, d.tipo as kind, a.nome as area, a.tipo as area_kind,
             cd.last_batch_at::text as last_batch_at,
             exists (select 1 from dw.fato_fluxo_area f where f.dispositivo_sk = d.dispositivo_sk and ${base}) as in_range
      from dw.dim_dispositivo d
      join camera_devices cd on cd.id = d.dispositivo_id::uuid
      join dw.dim_area a on a.area_sk = d.area_sk
      where d.tenant_sk = ${tenantSk} and d.dispositivo_sk <> 0 and not d.teste and d.ativo
        ${unit ? sql`and d.unidade_sk = ${unit.sk}` : sql``}
      order by a.nome, d.nome`)
  ).rows;
  const hasDoor = devices.some((d) => d.area_kind === 'porta');
  const anyInRange = devices.some((d) => d.in_range);

  const hours = (
    await db.execute<{ hour: number; entries: string | null }>(sql`
      select x.hora as hour, sum(f.entradas) as entries
      from dw.fato_fluxo_area f
      join dw.dim_area a on a.area_sk = f.area_sk
      join dw.dim_faixa_horaria x on x.faixa_sk = f.faixa_sk
      where ${base} and a.tipo = 'porta'
      group by x.hora`)
  ).rows;
  const byHour = Array.from({ length: 24 }, (_, hour) => {
    const row = hours.find((h) => Number(h.hour) === hour);
    return { hour, entries: hasDoor && anyInRange ? num(row?.entries) : null };
  });
  const weekdays = (
    await db.execute<{ weekday: number; entries: string | null }>(sql`
      select d.dia_semana as weekday, sum(f.entradas) as entries
      from dw.fato_fluxo_area f
      join dw.dim_area a on a.area_sk = f.area_sk
      join dw.dim_data d on d.data_sk = f.data_sk
      where ${base} and a.tipo = 'porta'
      group by d.dia_semana`)
  ).rows;
  const byWeekday = Array.from({ length: 7 }, (_, i) => {
    const weekday = i + 1;
    const row = weekdays.find((w) => Number(w.weekday) === weekday);
    return { weekday, entries: hasDoor && anyInRange ? num(row?.entries) : null };
  });
  const peaks = byHour
    .filter((h): h is { hour: number; entries: number } => (h.entries ?? 0) > 0)
    .sort((a, b) => b.entries - a.entries || a.hour - b.hour)
    .slice(0, 3);

  const rooms = (
    await db.execute<{
      code: string;
      name: string;
      capacity: number | null;
      observed: string;
      occupied: string;
      max_occupancy: number | null;
      avg_dwell_minutes: string | null;
    }>(sql`
      select a.area_codigo as code, a.nome as name, a.capacidade as capacity,
             count(f.area_sk) as observed,
             count(f.area_sk) filter (where f.ocupacao_maxima > 0) as occupied,
             max(f.ocupacao_maxima) as max_occupancy,
             round(sum(f.permanencia_segundos)::numeric / nullif(sum(f.permanencias), 0) / 60, 1) as avg_dwell_minutes
      from dw.dim_area a
      left join dw.fato_fluxo_area f on f.area_sk = a.area_sk and ${base}
      where a.tenant_sk = ${tenantSk} and a.tipo = 'sala_reuniao' and a.ativo
        ${unit ? sql`and a.unidade_sk = ${unit.sk}` : sql``}
      group by a.area_sk, a.area_codigo, a.nome, a.capacidade
      order by a.nome`)
  ).rows.map((r) => ({
    code: r.code,
    name: r.name,
    capacity: numOrNull(r.capacity),
    slotsObserved: num(r.observed),
    slotsOccupied: num(r.occupied),
    maxOccupancy: numOrNull(r.max_occupancy),
    avgDwellMinutes: numOrNull(r.avg_dwell_minutes),
  }));

  const alerts = (
    await db.execute<{ kind: CameraAlertKind; count: string }>(sql`
      select f.tipo as kind, count(*) as count from dw.fato_alerta f where ${base}
      group by f.tipo order by 2 desc, 1`)
  ).rows.map((r) => ({ kind: r.kind, count: num(r.count) }));

  const loaded = await db.execute<{ at: string | null }>(sql`
    select max(f.carregado_em)::text as at from dw.fato_fluxo_area f
    where f.tenant_sk = ${tenantSk} and f.fonte <> 'teste' ${unitFilter}`);

  return {
    unit: unit ? { id: unit.id, name: unit.name, kind: unit.kind } : null,
    units: units.map(({ id, name, kind }) => ({ id, name, kind })),
    range,
    byHour,
    byWeekday,
    peaks,
    rooms,
    alerts,
    reservedEmpty: { count: null, reason: CAMERA_REASONS.agendaRooms },
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      area: d.area,
      kind: d.kind,
      lastBatchAt: d.last_batch_at ? new Date(d.last_batch_at).toISOString() : null,
      reason: !d.last_batch_at
        ? CAMERA_REASONS.notInstalled
        : d.in_range
          ? null
          : CAMERA_REASONS.noBatchInRange,
    })),
    reason:
      devices.length === 0
        ? CAMERA_REASONS.noDevice
        : devices.every((d) => !d.last_batch_at)
          ? CAMERA_REASONS.notInstalled
          : !anyInRange
            ? CAMERA_REASONS.noBatchInRange
            : !hasDoor
              ? CAMERA_REASONS.noDoor
              : null,
    canManage: can(actor, 'cameras.manage').allowed,
    loadedAt: loaded.rows[0]?.at ? new Date(loaded.rows[0].at).toISOString() : null,
  };
}
