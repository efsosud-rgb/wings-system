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
  'fato_atividade',
  'fato_movimentacao_etapa',
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
  it('has the 19 tables and the 2 dashboard views', async () => {
    const tables = await client.query(
      `select count(*)::int as n from information_schema.tables where table_schema = 'dw' and table_type = 'BASE TABLE'`,
    );
    const views = await client.query(
      `select table_name from information_schema.views where table_schema = 'dw' order by 1`,
    );
    expect(tables.rows[0].n).toBe(19);
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

  it('counts working minutes Monday to Friday, 9h to 18h in São Paulo: Friday 17h50 to Monday 9h50 is one hour', async () => {
    const { rows } = await client.query(
      `select dw.minutos_uteis($1, $2) as sexta_segunda,
              dw.minutos_uteis($3, $4) as mesmo_dia,
              dw.minutos_uteis($5, $6) as fim_de_semana,
              dw.minutos_uteis($7, $8) as invertido,
              dw.minutos_uteis(null, $2) as sem_inicio,
              dw.data_sk($1) as dia_sexta,
              dw.data_sk(null) as sem_dia`,
      [
        '2026-10-09T17:50:00-03:00',
        '2026-10-12T09:50:00-03:00',
        '2026-10-13T10:00:00-03:00',
        '2026-10-13T11:30:00-03:00',
        '2026-10-10T10:00:00-03:00',
        '2026-10-11T16:00:00-03:00',
        '2026-10-13T11:30:00-03:00',
        '2026-10-13T10:00:00-03:00',
      ],
    );
    expect(rows[0]).toEqual({
      sexta_segunda: 60,
      mesmo_dia: 90,
      fim_de_semana: 0,
      invertido: null,
      sem_inicio: null,
      dia_sexta: 20261009,
      sem_dia: 0,
    });
  });

  it('isolates the productivity facts by tenant for a plain role too', async () => {
    await client.query(
      `insert into dw.fato_atividade (atividade_id, data_sk, tenant_sk, tipo, evento_em, fonte)
       values ('teste:1', 20260901, $1, 'nota', '2026-09-01T12:00:00Z', 'teste'), ('teste:2', 20260901, $2, 'nota', '2026-09-01T12:00:00Z', 'teste')`,
      [ids[0], ids[1]],
    );
    await client.query(
      `insert into dw.fato_movimentacao_etapa (movimentacao_id, data_sk, tenant_sk, negociacao_id, evento_em, fonte)
       values ('teste:1', 20260901, $1, 'n1', '2026-09-01T12:00:00Z', 'teste'), ('teste:2', 20260901, $2, 'n2', '2026-09-01T12:00:00Z', 'teste')`,
      [ids[0], ids[1]],
    );
    for (const table of ['fato_atividade', 'fato_movimentacao_etapa']) {
      const sql = `select tenant_sk from dw.${table}`;
      const own = await asReader<{ tenant_sk: number }>({ 'app.tenant_sk': String(ids[0]) }, sql);
      expect(own.map((r) => r.tenant_sk)).toEqual([ids[0]]);
      expect(await asReader({}, sql)).toHaveLength(0);
    }
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
