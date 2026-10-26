/**
 * Painel de Vendas › Produtividade (docs/crm/produtividade.md): results per person,
 * read from the dimensional model (`dw`, docs/bi/README.md). Never time logged,
 * clock, mouse, keyboard, screen or camera: the people are contractors, and the
 * CRM records only what they did with a lead. This file loads the model from the
 * CRM's own tables (ids only: names stay in `employees` and are joined at read
 * time) and answers the tab in the caller's scope.
 */
import {
  can,
  grantedScope,
  NO_OWNER,
  PRODUCTIVITY_ACTIVITY_TYPES,
  salesRanges,
  type Actor,
  type Productivity,
  type ProductivityActivityType,
  type ProductivityCounts,
  type ProductivityQuery,
  type SectorSlug,
} from '@wings/shared';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { WINGS_TENANT_ID } from '../../db/schema/ads.js';
import { employees, roles, sectors } from '../../db/schema/index.js';
import { officialNumberLive } from '../whatsapp/official-number.js';
import { CRM_ENTRY_STAGES, CRM_SELLER_ROLES } from './crm.js';

const LOCK_KEY = 'dw:produtividade';
const SOURCE = 'crm';

/** What the screen says in place of a number the CRM does not record. */
export const PRODUCTIVITY_UNAVAILABLE = {
  whatsapp:
    'WhatsApp ainda fora do sistema: os vendedores respondem pelo celular até a troca do número',
  ficha: 'o CRM ainda não registra o envio da ficha',
  cof: 'o CRM ainda não registra o envio da COF',
  projects: 'o Quadro de Projetos ainda não grava prazo nem responsável por tarefa',
} as const;

// --- the load --------------------------------------------------------------------------------

/** `case l.pipeline when 'expansao' then 'novo contato' … end`: the entry stage of each funnel, by name. */
const entryStageOfPipeline = sql`case l.pipeline ${sql.join(
  Object.entries(CRM_ENTRY_STAGES).map(
    ([pipeline, name]) => sql`when ${pipeline} then ${name.toLowerCase()}`,
  ),
  sql` `,
)} end`;

/**
 * Loads `dw` from the CRM: the dimensions by natural key (users as SCD2, first
 * version from 1900-01-01), then the three facts whole (`delete` the CRM's rows,
 * `insert … select`), in one transaction under an advisory lock, so a second
 * server skips a tick instead of loading twice. Returns `ran: false` when another
 * load holds the lock.
 */
export async function loadProductivityDw(
  db: Database,
  now = new Date(),
): Promise<{ ran: boolean; negotiations?: number; activities?: number; moves?: number }> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ got: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as got`,
    );
    if (!lock.rows[0]?.got) return { ran: false };

    await tx.execute(sql`
      insert into dw.dim_tenant (tenant_id, nome, tipo)
      select id::text, name, case when id = ${WINGS_TENANT_ID} then 'wings' else 'franqueadora' end
      from tenants
      on conflict (tenant_id) do update set nome = excluded.nome, tipo = excluded.tipo`);

    // Users: close the version whose sector, level or status changed, open the new one today
    // (a second change on the same day overwrites today's version).
    const current = sql`
      select e.id::text as usuario_id, s.slug as equipe, r.key as papel, e.status = 'active' as ativo
      from employees e
      join sectors s on s.id = e.sector_id
      join roles r on r.id = e.role_id`;
    await tx.execute(sql`
      with atual as (${current})
      update dw.dim_usuario u set valido_ate = current_date, atual = false
      from atual a
      where u.usuario_id = a.usuario_id and u.atual and u.valido_de < current_date
        and (u.equipe is distinct from a.equipe or u.papel is distinct from a.papel or u.ativo <> a.ativo)`);
    await tx.execute(sql`
      with atual as (${current})
      insert into dw.dim_usuario (usuario_id, nome, equipe, papel, ativo, valido_de)
      select a.usuario_id, null, a.equipe, a.papel, a.ativo,
             case when exists (select 1 from dw.dim_usuario u where u.usuario_id = a.usuario_id)
                  then current_date else date '1900-01-01' end
      from atual a
      where not exists (
        select 1 from dw.dim_usuario u
        where u.usuario_id = a.usuario_id and u.atual
          and u.equipe is not distinct from a.equipe and u.papel is not distinct from a.papel and u.ativo = a.ativo)
      on conflict (usuario_id, valido_de) do update
        set equipe = excluded.equipe, papel = excluded.papel, ativo = excluded.ativo,
            atual = true, valido_ate = date '9999-12-31'`);

    await tx.execute(sql`
      insert into dw.dim_etapa (funil, etapa_codigo, etapa_nome, ordem, tipo)
      select pipeline, id::text, name, position, 'aberta' from crm_stages
      on conflict (funil, etapa_codigo) do update set etapa_nome = excluded.etapa_nome, ordem = excluded.ordem`);
    await tx.execute(sql`
      insert into dw.dim_lead (lead_id, tenant_sk)
      select l.id::text, t.tenant_sk from leads l join dw.dim_tenant t on t.tenant_id = l.tenant_id::text
      on conflict (lead_id) do nothing`);

    // The negotiation (accumulating snapshot) with the first-contact milestone: the CRM's own rule
    // (crm.ts `firstContactOverdueSql`): the first-contact task starts the clock when the owner is
    // set, and the contact is the task done by a person (not closed with the deal) or the deal
    // leaving the funnel's entry stage, whichever came first.
    await tx.execute(sql`delete from dw.fato_negociacao where fonte = ${SOURCE}`);
    const negotiations = await tx.execute(sql`
      with tarefa as (
        select distinct on (t.lead_id) t.lead_id, t.created_at as inicio, t.due_at as prazo,
               case when exists (
                 select 1 from lead_events ev
                 where ev.kind = 'lead.task_done' and ev.detail->>'taskId' = t.id::text
                   and ev.detail->>'closedWithDeal' = 'true')
               then null else t.done_at end as feito_em
        from lead_tasks t
        where t.kind = 'first_contact'
        order by t.lead_id, t.created_at
      ), saida as (
        select h.lead_id, min(h.at) as em
        from lead_stage_history h join leads l on l.id = h.lead_id
        where h.won is null and h.to_stage_id is not null and h.to_stage_id is distinct from h.from_stage_id
          and lower(h.from_stage) = ${entryStageOfPipeline}
        group by h.lead_id
      ), contato as (
        select t.lead_id, t.inicio, t.prazo, least(t.feito_em, s.em) as em
        from tarefa t left join saida s on s.lead_id = t.lead_id
      )
      insert into dw.fato_negociacao (
        negociacao_id, tenant_sk, lead_sk, vendedor_sk, etapa_atual_sk, criada_sk, reuniao_sk,
        ganha_sk, perdida_sk, valor_estimado, valor_fechado, dias_ate_fechar, atualizado_em, fonte,
        funil, primeiro_contato_sk, minutos_uteis_ate_primeiro_contato, primeiro_contato_no_prazo)
      select l.id::text, t.tenant_sk, coalesce(dl.lead_sk, 0), coalesce(u.usuario_sk, 0), coalesce(e.etapa_sk, 0),
             dw.data_sk(l.entered_at),
             dw.data_sk((select min(m.starts_at) from crm_meetings m
                         where m.lead_id = l.id and m.status in ('em_andamento', 'encerrada'))),
             case when l.won then dw.data_sk(l.closed_at) else 0 end,
             case when l.won = false then dw.data_sk(l.closed_at) else 0 end,
             l.value_cents / 100.0,
             case when l.won then l.value_cents / 100.0 end,
             case when l.closed_at is not null then
               (l.closed_at at time zone 'America/Sao_Paulo')::date - (l.entered_at at time zone 'America/Sao_Paulo')::date end,
             greatest(l.created_at, coalesce(l.stage_changed_at, l.created_at), coalesce(l.closed_at, l.created_at)),
             ${SOURCE}, l.pipeline,
             dw.data_sk(c.em), dw.minutos_uteis(c.inicio, c.em),
             case when c.em is not null then c.em <= c.prazo
                  when c.prazo is null or l.won is not null then null
                  when ${now} > c.prazo then false
                  else null end
      from leads l
      join dw.dim_tenant t on t.tenant_id = l.tenant_id::text
      left join dw.dim_lead dl on dl.lead_id = l.id::text
      left join dw.dim_usuario u on u.usuario_id = l.owner_employee_id::text and u.atual
      left join dw.dim_etapa e on e.etapa_codigo = l.stage_id::text
      left join contato c on c.lead_id = l.id`);

    // Activities of a person: the tables the CRM keeps them in, one row each. A message's
    // response time counts from the lead's first message still unanswered by anyone.
    await tx.execute(sql`delete from dw.fato_atividade where fonte = ${SOURCE}`);
    const activities = await tx.execute(sql`
      insert into dw.fato_atividade (
        atividade_id, data_sk, hora, tenant_sk, usuario_sk, lead_sk, negociacao_id, funil, tipo,
        minutos_uteis_resposta, evento_em, fonte)
      select x.atividade_id, dw.data_sk(x.em), extract(hour from x.em at time zone 'America/Sao_Paulo')::smallint,
             t.tenant_sk, coalesce(u.usuario_sk, 0), coalesce(dl.lead_sk, 0), l.id::text, l.pipeline, x.tipo,
             x.resposta, x.em, ${SOURCE}
      from (
        select 'lead_activities:' || a.id as atividade_id, a.lead_id, a.actor_employee_id as employee_id, a.at as em,
               case a.kind when 'call' then 'ligacao' else 'reuniao_realizada' end as tipo, null::integer as resposta
        from lead_activities a
        union all
        select 'lead_notes:' || n.id, n.lead_id, n.author_employee_id, n.created_at, 'nota', null
        from lead_notes n
        union all
        select 'lead_tasks:' || k.id, k.lead_id, k.done_by, k.done_at, 'tarefa', null
        from lead_tasks k
        where k.done_at is not null and k.done_by is not null and not exists (
          select 1 from lead_events ev
          where ev.kind = 'lead.task_done' and ev.detail->>'taskId' = k.id::text and ev.detail->>'closedWithDeal' = 'true')
        union all
        select 'crm_email_outbox:' || o.id, o.lead_id, o.sent_by, o.created_at, 'email', null
        from crm_email_outbox o
        where o.status = 'sent' and o.run_id is null and o.sent_by is not null
        union all
        select 'wa_messages:' || m.id, m.lead_id, m.employee_id, coalesce(m.sent_at, m.created_at), 'mensagem',
               dw.minutos_uteis((
                 select min(coalesce(i.wa_timestamp, i.created_at)) from wa_messages i
                 where i.conversation_id = m.conversation_id and i.direction = 'in'
                   and coalesce(i.wa_timestamp, i.created_at) < coalesce(m.sent_at, m.created_at)
                   and not exists (
                     select 1 from wa_messages o
                     where o.conversation_id = m.conversation_id and o.direction = 'out' and o.id <> m.id
                       and coalesce(o.sent_at, o.created_at) > coalesce(i.wa_timestamp, i.created_at)
                       and coalesce(o.sent_at, o.created_at) < coalesce(m.sent_at, m.created_at))
               ), coalesce(m.sent_at, m.created_at))
        from wa_messages m
        where m.direction = 'out' and m.author = 'employee' and m.employee_id is not null and m.lead_id is not null
        union all
        select 'crm_meetings:' || g.id || ':agendada', g.lead_id, g.owner_employee_id, g.created_at, 'reuniao_agendada', null
        from crm_meetings g
        where g.status <> 'cancelada'
        union all
        select 'crm_meetings:' || g.id || ':realizada', g.lead_id, g.owner_employee_id, g.starts_at, 'reuniao_realizada', null
        from crm_meetings g
        where g.status in ('em_andamento', 'encerrada')
      ) x
      join leads l on l.id = x.lead_id
      join dw.dim_tenant t on t.tenant_id = l.tenant_id::text
      left join dw.dim_usuario u on u.usuario_id = x.employee_id::text and u.atual
      left join dw.dim_lead dl on dl.lead_id = l.id::text
      where x.em is not null`);

    // Stage moves, credited to who moved (0 = automation, Sofia, triage or RD); the win/loss rows
    // of the history (from = to) stay out, they are the snapshot's milestones.
    await tx.execute(sql`delete from dw.fato_movimentacao_etapa where fonte = ${SOURCE}`);
    const moves = await tx.execute(sql`
      insert into dw.fato_movimentacao_etapa (
        movimentacao_id, data_sk, hora, tenant_sk, usuario_sk, lead_sk, negociacao_id, funil,
        etapa_origem_sk, etapa_destino_sk, avanco, evento_em, fonte)
      select 'lead_stage_history:' || h.id, dw.data_sk(h.at), extract(hour from h.at at time zone 'America/Sao_Paulo')::smallint,
             t.tenant_sk, coalesce(u.usuario_sk, 0), coalesce(dl.lead_sk, 0), l.id::text, l.pipeline,
             coalesce(eo.etapa_sk, 0), coalesce(ed.etapa_sk, 0),
             case when eo.etapa_sk is null or ed.etapa_sk is null or eo.funil <> ed.funil then null
                  else ed.ordem > eo.ordem end,
             h.at, ${SOURCE}
      from lead_stage_history h
      join leads l on l.id = h.lead_id
      join dw.dim_tenant t on t.tenant_id = l.tenant_id::text
      left join dw.dim_usuario u on u.usuario_id = h.actor_employee_id::text and u.atual
      left join dw.dim_lead dl on dl.lead_id = l.id::text
      left join dw.dim_etapa eo on eo.etapa_codigo = h.from_stage_id::text
      left join dw.dim_etapa ed on ed.etapa_codigo = h.to_stage_id::text
      where h.won is null and h.to_stage_id is distinct from h.from_stage_id`);

    return {
      ran: true,
      negotiations: negotiations.rowCount ?? 0,
      activities: activities.rowCount ?? 0,
      moves: moves.rowCount ?? 0,
    };
  });
}

/** Runs the load shortly after the start and then every `everyMs` (15 minutes by default); returns the stop. */
export function startProductivityDwScheduler(options: {
  db: Database;
  log: (facts: Record<string, unknown>) => void;
  firstMs?: number;
  everyMs?: number;
}): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await loadProductivityDw(options.db);
      if (result.ran) options.log({ job: 'dw-produtividade', ...result });
    } catch (error) {
      options.log({
        job: 'dw-produtividade',
        error: error instanceof Error ? error.name : 'unknown',
      });
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), options.firstMs ?? 20_000);
  first.unref();
  const timer = setInterval(() => void tick(), options.everyMs ?? 15 * 60_000);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

// --- the answer ------------------------------------------------------------------------------

export interface ProductivityInput extends Omit<ProductivityQuery, 'from' | 'to'> {
  from?: string;
  to?: string;
  actor: Actor;
  now?: Date;
}

interface Person {
  id: string;
  name: string;
  active: boolean;
  sector: string;
}

const num = (value: unknown) => Number(value ?? 0);
const numOrNull = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
const skOf = (day: string) => Number(day.replaceAll('-', ''));

const emptyCounts = (): ProductivityCounts => ({
  received: 0,
  firstContact: { inTime: 0, decided: 0, medianMinutes: null },
  activities: Object.fromEntries(PRODUCTIVITY_ACTIVITY_TYPES.map((t) => [t, 0])) as Record<
    ProductivityActivityType,
    number
  >,
  stageAdvances: 0,
  won: 0,
  lost: 0,
  whatsappMedianMinutes: null,
});

/**
 * The tab's numbers in the caller's scope: a seller sees their own row and the
 * totals of their sector; the Gerente comercial the people of their sector, one
 * row each; Diretoria and Admin Master everyone. The team's totals come from the
 * same queries (grouping sets), so the average on the screen covers the same
 * people the rows do.
 */
export async function productivityOf(
  db: Database,
  input: ProductivityInput,
): Promise<Productivity> {
  const now = input.now ?? new Date();
  const range = salesRanges(input.period, now, { from: input.from, to: input.to }).current;
  const pipeline = input.pipeline === 'todos' ? null : input.pipeline;
  const scope = grantedScope(input.actor, 'productivity.read') ?? 'own';

  const staff: Person[] = await db
    .select({
      id: employees.id,
      name: employees.fullName,
      active: sql<boolean>`${employees.status} = 'active'`,
      sector: sectors.slug,
    })
    .from(employees)
    .innerJoin(roles, eq(roles.id, employees.roleId))
    .innerJoin(sectors, eq(sectors.id, employees.sectorId))
    .where(inArray(roles.key, [...CRM_SELLER_ROLES]))
    .orderBy(asc(employees.fullName));
  const team =
    scope === 'own'
      ? staff.filter((p) => p.sector === input.actor.sector)
      : staff.filter(
          (p) =>
            can(input.actor, 'productivity.read', {
              sector: p.sector as SectorSlug,
              ownerEmployeeId: p.id,
            }).allowed,
        );
  let visible = scope === 'own' ? staff.filter((p) => p.id === input.actor.employeeId) : team;
  if (input.owner && input.owner !== NO_OWNER)
    visible = visible.filter((p) => p.id === input.owner);

  const ids = team.map((p) => p.id);
  const fromSk = skOf(range.from);
  const toSk = skOf(range.to);
  const tenant = sql`(select tenant_sk from dw.dim_tenant where tenant_id = ${WINGS_TENANT_ID})`;
  // A list of ids as parameters (an array parameter arrives as a record); an empty team matches nothing.
  const inTeam =
    ids.length > 0
      ? sql`u.usuario_id in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql`false`;
  const funnel = pipeline ? sql`and f.funil = ${pipeline}` : sql``;
  const inRange = (column: SQLKey) => sql`${sql.raw(`f.${column}`)} between ${fromSk} and ${toSk}`;

  const negotiations = await db.execute<{
    usuario_id: string | null;
    received: string;
    in_time: string;
    decided: string;
    median: string | null;
    won: string;
    lost: string;
  }>(sql`
    select u.usuario_id,
           count(*) filter (where ${inRange('criada_sk')}) as received,
           count(*) filter (where ${inRange('criada_sk')} and f.primeiro_contato_no_prazo) as in_time,
           count(*) filter (where ${inRange('criada_sk')} and f.primeiro_contato_no_prazo is not null) as decided,
           percentile_cont(0.5) within group (order by f.minutos_uteis_ate_primeiro_contato)
             filter (where ${inRange('criada_sk')} and f.minutos_uteis_ate_primeiro_contato is not null) as median,
           count(*) filter (where ${inRange('ganha_sk')}) as won,
           count(*) filter (where ${inRange('perdida_sk')}) as lost
    from dw.fato_negociacao f
    join dw.dim_usuario u on u.usuario_sk = f.vendedor_sk
    where f.tenant_sk = ${tenant} and f.fonte = ${SOURCE} and ${inTeam} ${funnel}
      and (${inRange('criada_sk')} or ${inRange('ganha_sk')} or ${inRange('perdida_sk')})
    group by grouping sets ((u.usuario_id), ())`);
  const activities = await db.execute<{
    usuario_id: string | null;
    tipo: ProductivityActivityType;
    n: string;
    median: string | null;
  }>(sql`
    select u.usuario_id, f.tipo, count(*) as n,
           percentile_cont(0.5) within group (order by f.minutos_uteis_resposta)
             filter (where f.minutos_uteis_resposta is not null) as median
    from dw.fato_atividade f
    join dw.dim_usuario u on u.usuario_sk = f.usuario_sk
    where f.tenant_sk = ${tenant} and f.fonte = ${SOURCE} and ${inTeam} ${funnel} and ${inRange('data_sk')}
    group by grouping sets ((u.usuario_id, f.tipo), (f.tipo))`);
  const moves = await db.execute<{ usuario_id: string | null; n: string }>(sql`
    select u.usuario_id, count(*) as n
    from dw.fato_movimentacao_etapa f
    join dw.dim_usuario u on u.usuario_sk = f.usuario_sk
    where f.tenant_sk = ${tenant} and f.fonte = ${SOURCE} and ${inTeam} ${funnel} and ${inRange('data_sk')} and f.avanco
    group by grouping sets ((u.usuario_id), ())`);

  const counts = new Map<string | null, ProductivityCounts>();
  const of = (id: string | null) => {
    let row = counts.get(id);
    if (!row) counts.set(id, (row = emptyCounts()));
    return row;
  };
  for (const r of negotiations.rows) {
    const row = of(r.usuario_id);
    row.received = num(r.received);
    row.firstContact = {
      inTime: num(r.in_time),
      decided: num(r.decided),
      medianMinutes: numOrNull(r.median),
    };
    row.won = num(r.won);
    row.lost = num(r.lost);
  }
  for (const r of activities.rows) {
    const row = of(r.usuario_id);
    row.activities[r.tipo] = num(r.n);
    if (r.tipo === 'mensagem') row.whatsappMedianMinutes = numOrNull(r.median);
  }
  for (const r of moves.rows) of(r.usuario_id).stageAdvances = num(r.n);

  const whatsappOn = await officialNumberLive(db);
  const withReasons = (row: ProductivityCounts): ProductivityCounts =>
    whatsappOn ? row : { ...row, whatsappMedianMinutes: null };
  const hasFacts = (row: ProductivityCounts) =>
    row.received + row.won + row.lost + row.stageAdvances > 0 ||
    Object.values(row.activities).some((n) => n > 0);
  const people = visible
    .map((p) => ({
      ...withReasons(counts.get(p.id) ?? emptyCounts()),
      employeeId: p.id,
      name: p.name,
      active: p.active,
    }))
    .filter((p) => p.active || hasFacts(p));

  const stages = pipeline
    ? (
        await db.execute<{ id: string; name: string; order: number; reached: number }>(sql`
          with recebida as (
            select f.negociacao_id, e.ordem as atual
            from dw.fato_negociacao f
            join dw.dim_usuario u on u.usuario_sk = f.vendedor_sk
            left join dw.dim_etapa e on e.etapa_sk = f.etapa_atual_sk
            where f.tenant_sk = ${tenant} and f.fonte = ${SOURCE} and ${inTeam} and f.funil = ${pipeline}
              and ${inRange('criada_sk')}
          ), alcance as (
            select r.negociacao_id,
                   greatest(coalesce(r.atual, 0), coalesce((
                     select max(ed.ordem) from dw.fato_movimentacao_etapa m
                     join dw.dim_etapa ed on ed.etapa_sk = m.etapa_destino_sk
                     where m.negociacao_id = r.negociacao_id and ed.funil = ${pipeline}), 0)) as ordem
            from recebida r
          )
          select e.etapa_codigo as id, e.etapa_nome as name, e.ordem as "order",
                 (select count(*) from alcance a where a.ordem >= e.ordem)::int as reached
          from dw.dim_etapa e
          where e.funil = ${pipeline} and e.etapa_sk <> 0
          order by e.ordem`)
      ).rows.map((r) => ({ ...r, order: Number(r.order), reached: Number(r.reached) }))
    : [];

  // The reason stays in the CRM (free text that may name a person): read there, grouped, by id.
  const lostReasons = (
    await db.execute<{ reason: string; count: string }>(sql`
      select lower(trim(l.lost_reason)) as reason, count(*) as count
      from dw.fato_negociacao f
      join dw.dim_usuario u on u.usuario_sk = f.vendedor_sk
      join leads l on l.id = f.negociacao_id::uuid
      where f.tenant_sk = ${tenant} and f.fonte = ${SOURCE} and ${inTeam} ${funnel} and ${inRange('perdida_sk')}
        and nullif(trim(l.lost_reason), '') is not null
      group by 1 order by 2 desc, 1 limit 20`)
  ).rows.map((r) => ({ reason: r.reason, count: num(r.count) }));

  const loaded = await db.execute<{ at: string | null }>(
    sql`select max(carregado_em)::text as at from dw.fato_negociacao where fonte = ${SOURCE}`,
  );

  return {
    scope,
    pipeline,
    range,
    people,
    team: { ...withReasons(counts.get(null) ?? emptyCounts()), people: team.length },
    stages,
    lostReasons,
    unavailable: {
      ...PRODUCTIVITY_UNAVAILABLE,
      whatsapp: whatsappOn ? null : PRODUCTIVITY_UNAVAILABLE.whatsapp,
    },
    loadedAt: loaded.rows[0]?.at ? new Date(loaded.rows[0].at).toISOString() : null,
  };
}

type SQLKey = 'criada_sk' | 'ganha_sk' | 'perdida_sk' | 'data_sk';
