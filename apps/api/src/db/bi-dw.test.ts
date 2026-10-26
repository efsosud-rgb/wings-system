import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db.js';

/**
 * The BI model lives in its own `dw` schema (migration 0060, docs/bi). RLS is
 * ignored by superusers, so the isolation checks run as a plain role.
 */
let harness: TestDatabase;
let client: pg.Client;
const role = `dw_reader_${randomBytes(4).toString('hex')}`;
const FACTS = [
  'fato_midia_diaria',
  'fato_conversao',
  'fato_negociacao',
  'fato_funil_diario',
  'fato_aprovacao_verba',
  'fato_diagnostico_quiz',
  'fato_fluxo_area',
  'fato_alerta',
];
const ids: number[] = [];

async function asReader<T>(settings: Record<string, string>, sql: string): Promise<T[]> {
  await client.query('begin');
  try {
    await client.query(`set local role ${role}`);
    for (const [key, value] of Object.entries(settings)) {
      await client.query('select set_config($1, $2, true)', [key, value]);
    }
    return (await client.query(sql)).rows as T[];
  } finally {
    await client.query('rollback');
  }
}

beforeAll(async () => {
  harness = await createTestDatabase();
  client = new pg.Client({ connectionString: harness.url });
  await client.connect();
  await client.query(`create role ${role} nologin`);
  await client.query(`grant usage on schema dw to ${role}`);
  await client.query(`grant select on all tables in schema dw to ${role}`);
  for (const nome of ['a', 'b']) {
    const { rows } = await client.query<{ tenant_sk: number }>(
      `insert into dw.dim_tenant (tenant_id, nome, tipo) values ($1, $1, 'franqueadora') returning tenant_sk`,
      [`teste-${nome}`],
    );
    ids.push(rows[0]!.tenant_sk);
  }
  // Tenant A has a day with spend and a day the source did not report; tenant B one day.
  const canal = (
    await client.query<{ canal_sk: number }>(
      `select canal_sk from dw.dim_canal where canal_codigo = 'meta_ads'`,
    )
  ).rows[0]!.canal_sk;
  const insert = `insert into dw.fato_midia_diaria
    (data_sk, tenant_sk, canal_sk, campanha_sk, investimento, impressoes, cliques, leads_plataforma, fonte)
    values ($1, $2, $3, 0, $4, $5, $6, $7, 'teste')`;
  await client.query(insert, [20260901, ids[0], canal, 100, 1000, 50, 4]);
  await client.query(insert, [20260902, ids[0], canal, null, null, null, null]);
  await client.query(insert, [20260903, ids[1], canal, 7, 10, 1, 1]);
});

afterAll(async () => {
  await client?.end();
  await harness?.drop();
  const admin = new pg.Client({ connectionString: harness.url.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query(`drop role if exists ${role}`);
  await admin.end();
});

describe('BI dimensional model (schema dw)', () => {
  it('has the 23 tables and the 2 dashboard views', async () => {
    const tables = await client.query(
      `select count(*)::int as n from information_schema.tables where table_schema = 'dw' and table_type = 'BASE TABLE'`,
    );
    const views = await client.query(
      `select table_name from information_schema.views where table_schema = 'dw' order by 1`,
    );
    expect(tables.rows[0].n).toBe(23);
    expect(views.rows.map((r) => r.table_name)).toEqual(['vw_funil_marcos', 'vw_midia_mensal']);
  });

  it('covers 2024 to 2030 and keeps the "no information" member with key 0', async () => {
    const { rows } = await client.query(
      `select count(*) filter (where data_sk <> 0)::int as dias, min(data) as de, max(data) as ate,
              count(*) filter (where data_sk = 0)::int as zero
         from dw.dim_data`,
    );
    expect(rows[0].dias).toBe(2557);
    expect(rows[0].zero).toBe(1);
    expect(new Date(rows[0].de).getUTCFullYear()).toBe(2024);
    expect(new Date(rows[0].ate).getUTCFullYear()).toBe(2030);
  });

  it('never invents a holiday: the column stays null until an official source loads it', async () => {
    const { rows } = await client.query(
      `select count(*)::int as n from dw.dim_data where feriado_nacional is not null`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('has row level security on every fact table', async () => {
    const { rows } = await client.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'dw' and c.relname = any($1) and c.relrowsecurity`,
      [FACTS],
    );
    expect(rows.map((r) => r.relname).sort()).toEqual([...FACTS].sort());
  });

  it('shows a plain role only its own tenant, everything with ver_todos, nothing without a setting', async () => {
    const sql = `select tenant_sk from dw.fato_midia_diaria order by data_sk, tenant_sk`;
    const own = await asReader<{ tenant_sk: number }>({ 'app.tenant_sk': String(ids[1]) }, sql);
    const all = await asReader<{ tenant_sk: number }>({ 'app.ver_todos_tenants': 'on' }, sql);
    const none = await asReader<{ tenant_sk: number }>({}, sql);
    expect(own.map((r) => r.tenant_sk)).toEqual([ids[1]]);
    expect(all).toHaveLength(3);
    expect(none).toHaveLength(0);
  });

  it('applies the same isolation through the views (security_invoker)', async () => {
    const sql = `select tenant_sk, investimento, cpl, dias_sem_investimento_informado from dw.vw_midia_mensal`;
    const rows = await asReader<{
      tenant_sk: number;
      investimento: string | null;
      cpl: string | null;
      dias_sem_investimento_informado: string;
    }>({ 'app.tenant_sk': String(ids[0]) }, sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_sk).toBe(ids[0]);
    expect(Number(rows[0]!.investimento)).toBe(100);
    expect(Number(rows[0]!.cpl)).toBe(25);
    expect(Number(rows[0]!.dias_sem_investimento_informado)).toBe(1);
  });

  it('has the 96 quarter-hour slots and finds the slot of an instant in São Paulo time', async () => {
    const { rows } = await client.query(
      `select (select count(*)::int from dw.dim_faixa_horaria where faixa_sk <> 0) as faixas,
              dw.faixa_sk('2026-10-20T08:45:00-03:00') as oito_e_quarenta_e_cinco,
              dw.faixa_sk('2026-10-20T00:00:00-03:00') as meia_noite,
              dw.faixa_sk('2026-10-20T23:59:00-03:00') as ultima,
              dw.faixa_sk(null) as sem,
              (select periodo from dw.dim_faixa_horaria where faixa_sk = 36) as periodo_das_oito`,
    );
    expect(rows[0]).toEqual({
      faixas: 96,
      oito_e_quarenta_e_cinco: 36,
      meia_noite: 1,
      ultima: 96,
      sem: 0,
      periodo_das_oito: 'manhã',
    });
  });

  it('isolates the camera facts and dimensions by tenant for a plain role too (no image column anywhere)', async () => {
    const unit = async (tenant: number) =>
      (
        await client.query<{ unidade_sk: number }>(
          `insert into dw.dim_unidade (unidade_id, tenant_sk, nome, tipo) values ($1, $2, 'Unidade Teste', 'loja') returning unidade_sk`,
          [`unidade-${tenant}`, tenant],
        )
      ).rows[0]!.unidade_sk;
    const [a, b] = [await unit(ids[0]!), await unit(ids[1]!)];
    await client.query(
      `insert into dw.fato_fluxo_area (data_sk, faixa_sk, tenant_sk, unidade_sk, area_sk, dispositivo_sk, entradas, inicio_em, fonte)
       values (20260901, 40, $1, $3, 0, 0, 5, '2026-09-01T12:45:00-03:00', 'teste'),
              (20260901, 41, $2, $4, 0, 0, 7, '2026-09-01T13:00:00-03:00', 'teste')`,
      [ids[0], ids[1], a, b],
    );
    await client.query(
      `insert into dw.fato_alerta (alerta_id, data_sk, faixa_sk, tenant_sk, unidade_sk, area_sk, dispositivo_sk, tipo, iniciado_em, fonte)
       values ('t:1', 20260901, 40, $1, $3, 0, 0, 'lotacao', '2026-09-01T12:45:00-03:00', 'teste'),
              ('t:2', 20260901, 40, $2, $4, 0, 0, 'lotacao', '2026-09-01T12:45:00-03:00', 'teste')`,
      [ids[0], ids[1], a, b],
    );
    for (const table of ['dim_unidade', 'fato_fluxo_area', 'fato_alerta']) {
      const sql = `select tenant_sk from dw.${table} where tenant_sk in (${ids.join(',')})`;
      const own = await asReader<{ tenant_sk: number }>({ 'app.tenant_sk': String(ids[0]) }, sql);
      expect(own.map((r) => r.tenant_sk)).toEqual([ids[0]]);
      expect(await asReader({}, sql)).toHaveLength(0);
    }
    const columns = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'dw'
        and table_name in ('dim_unidade', 'dim_area', 'dim_dispositivo', 'fato_fluxo_area', 'fato_alerta')`,
    );
    for (const { column_name } of columns.rows)
      expect(column_name).not.toMatch(/imagem|image|foto|frame|rosto|face|video|pessoa_id/);
  });

  it('turns a division by zero into null instead of zero', async () => {
    const { rows } = await client.query(
      `select round(sum(investimento) / nullif(sum(leads_plataforma), 0), 2) as cpl
         from dw.fato_midia_diaria where tenant_sk = $1 and data_sk = 20260902`,
      [ids[0]],
    );
    expect(rows[0].cpl).toBeNull();
  });
});
