-- Limpeza dos leads (docs/crm/limpeza-leads.md): apaga os leads de teste e junta os
-- repetidos (mesmo WhatsApp ou mesmo e-mail) num lead só.
--
-- Tudo numa transação. O script de fora (limpar-leads.sh) acrescenta o fim: COMMIT ao
-- aplicar, ROLLBACK ao simular; a simulação faz exatamente o mesmo trabalho e desfaz.
-- Na tela só saem contagens e códigos, nunca nome, e-mail ou telefone; ids de lead
-- (para conferir na tela do CRM) saem em linhas que começam com dois espaços, que o
-- script de fora deixa só no log.
--
-- Depende só das tabelas da produção em 0501fcf (migração 0070); as que vieram depois
-- (lead_files, crm_meetings) são tratadas quando existem. Uma tabela nova ligada a
-- leads que este arquivo não conhece faz tudo parar antes de mexer em qualquer coisa.
--
-- Parâmetros (set_config, antes deste arquivo):
--   limpeza.lote              limpeza-leads-AAAAMMDDTHHMMSSZ
--   limpeza.limite_chave      um telefone/e-mail presente em mais leads do que isto não junta
--   limpeza.apagar_suspeitos  1 apaga também os "teste" ganhos, em etapa 3+ ou com contrato
--   limpeza.esperado_apagar   número da simulação ('' = sem conferência)
--   limpeza.esperado_juntar   idem
--   limpeza.rd_lido           1 quando a tabela temporária rd_teste traz os testes lidos do RD
-- e a tabela temporária rd_teste(rd_deal_id text), criada antes (pode estar vazia).

\set ON_ERROR_STOP on
\set VERBOSITY terse
\pset tuples_only on
\pset format unaligned
\pset footer off
\pset pager off

begin;
set local lock_timeout = '15s';
set local client_min_messages = warning;

-- Ninguém grava em leads enquanto isto roda (leituras seguem); dura segundos.
lock table public.leads in exclusive mode;

create temp table antes on commit drop as select count(*) as leads from public.leads;

-- normalização --------------------------------------------------------------------

create function pg_temp.sem_acento(t text) returns text language sql immutable as $f$
  select translate(lower(coalesce(t, '')), 'áàâãäåéèêëíìîïóòôõöúùûüçñý', 'aaaaaaeeeeiiiiooooouuuucny')
$f$;

-- Uma palavra que começa com "teste" (teste, testes, teste1, joao.teste@...).
create function pg_temp.tem_teste(t text) returns boolean language sql immutable as $f$
  select pg_temp.sem_acento(t) ~ '(^|[^a-z0-9])teste'
$f$;

-- O WhatsApp: como normalizeBrazilianPhone (55 + DDD + número) e, num celular gravado
-- sem o 9 (12 dígitos começando em 6-9 depois do DDD), com o 9.
create function pg_temp.fone(p text) returns text language sql immutable as $f$
  select case
      when n is not null and length(n) = 12 and substr(n, 5, 1) in ('6', '7', '8', '9')
        then substr(n, 1, 4) || '9' || substr(n, 5)
      else n
    end
  from (
    select case
        when d = '' or d ~ '^(\d)\1*$' then null
        when length(d) in (10, 11) then '55' || d
        when length(d) in (12, 13) and d like '55%' then d
      end as n
    from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) a
  ) b
$f$;

-- Sem o passo do 9, para contar os grupos que só existem por causa dele.
create function pg_temp.fone_sem_9(p text) returns text language sql immutable as $f$
  select case
      when d = '' or d ~ '^(\d)\1*$' then null
      when length(d) in (10, 11) then '55' || d
      when length(d) in (12, 13) and d like '55%' then d
    end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) a
$f$;

create function pg_temp.email(e text) returns text language sql immutable as $f$
  select case
      when lower(btrim(e)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then lower(btrim(e))
    end
$f$;

-- guardas -------------------------------------------------------------------------

-- Tabelas que guardam o id de um lead: as com chave estrangeira para leads, mais
-- client_contracts (lead_id sem chave). passo 4 = filha de leads; passo 5 = filha de
-- uma filha (re-inserida depois dela ao desfazer). soltar = nos testes, a linha fica e
-- só perde o lead (a marca da Meta que impede o mesmo lead de voltar; o contrato).
create temp table filhas (
  tabela text primary key,
  tem_lead boolean not null,
  passo int not null default 4,
  via_tabela text,
  via_coluna text,
  soltar boolean not null default false
) on commit drop;

insert into filhas (tabela, tem_lead)
select r.relname, true
from pg_constraint c
join pg_class r on r.oid = c.conrelid
join pg_namespace n on n.oid = r.relnamespace
where c.contype = 'f' and c.confrelid = 'public.leads'::regclass and n.nspname = 'public'
group by r.relname;

insert into filhas (tabela, tem_lead, soltar)
select 'client_contracts', true, true
where exists (
  select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'client_contracts' and column_name = 'lead_id'
);

update filhas set soltar = true where tabela = 'meta_leadgen_events';

do $g$
declare
  r record;
  ruim text;
begin
  select string_agg(format('%s.%s', n.nspname, t.relname), ', ') into ruim
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where c.contype = 'f' and c.confrelid = 'public.leads'::regclass and n.nspname <> 'public';
  if ruim is not null then
    raise exception 'tabela de outro esquema ligada a leads: % (revise o script)', ruim;
  end if;

  select string_agg(tabela, ', ') into ruim
  from filhas
  where tabela not in (
    'crm_automation_runs', 'crm_email_outbox', 'crm_meetings', 'crm_notifications',
    'lead_activities', 'lead_contacts', 'lead_enrichment_ledger', 'lead_events',
    'lead_files', 'lead_notes', 'lead_stage_history', 'lead_tasks',
    'meta_leadgen_events', 'client_contracts'
  );
  if ruim is not null then
    raise exception 'tabela ligada a leads que este script não conhece: % (revise o script)', ruim;
  end if;

  -- Toda ligação com leads é pela coluna lead_id.
  select string_agg(t.relname || '.' || a.attname, ', ') into ruim
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.contype = 'f' and c.confrelid = 'public.leads'::regclass and a.attname <> 'lead_id';
  if ruim is not null then
    raise exception 'ligação com leads fora da coluna lead_id: % (revise o script)', ruim;
  end if;

  -- Filhas das filhas (crm_email_outbox -> crm_automation_runs; crm_meeting_analysis_runs -> crm_meetings).
  for r in
    select t.relname as tabela, p.relname as pai, a.attname as coluna
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_class p on p.oid = c.confrelid
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and p.relnamespace = 'public'::regnamespace
      -- só as que são apagadas: das soltas (contrato, marca da Meta) nenhuma linha some
      and p.relname in (select tabela from filhas where not soltar) and c.conrelid <> c.confrelid
  loop
    if (r.tabela, r.pai) not in (
      ('crm_email_outbox', 'crm_automation_runs'), ('crm_meeting_analysis_runs', 'crm_meetings')
    ) then
      raise exception 'tabela ligada a %, filha de leads, que este script não conhece: % (revise o script)', r.pai, r.tabela;
    end if;
    if exists (select 1 from filhas where tabela = r.tabela) then
      update filhas set passo = 5, via_tabela = r.pai, via_coluna = r.coluna where tabela = r.tabela;
    else
      insert into filhas (tabela, tem_lead, passo, via_tabela, via_coluna)
      values (r.tabela, false, 5, r.pai, r.coluna);
    end if;
  end loop;

  select string_agg(t.relname, ', ') into ruim
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_class p on p.oid = c.confrelid
  where c.contype = 'f' and p.relnamespace = 'public'::regnamespace and c.conrelid <> c.confrelid
    and p.relname in (select tabela from filhas where passo = 5);
  if ruim is not null then
    raise exception 'terceiro nível ligado a leads: % (revise o script)', ruim;
  end if;

  -- Contatos e empresas de teste só são apagados conhecendo quem aponta para eles.
  select string_agg(t.relname || '.' || a.attname, ', ') into ruim
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.contype = 'f'
    and c.confrelid in ('public.crm_contacts'::regclass, 'public.crm_companies'::regclass)
    and (t.relname, a.attname) not in (
      ('crm_companies', 'merged_into_id'), ('crm_contacts', 'company_id'),
      ('crm_contacts', 'merged_into_id'), ('lead_contacts', 'contact_id')
    );
  if ruim is not null then
    raise exception 'ligação com contatos/empresas que este script não conhece: % (revise o script)', ruim;
  end if;

  -- Índice único que junte lead_id com mais de uma outra coluna não é tratado ao juntar.
  select string_agg(i.indexrelid::regclass::text, ', ') into ruim
  from pg_index i
  join pg_class t on t.oid = i.indrelid
  where i.indisunique and t.relnamespace = 'public'::regnamespace
    and t.relname in (select tabela from filhas where tem_lead)
    and exists (
      select 1 from pg_attribute a
      where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname = 'lead_id'
    )
    and i.indnatts > 2;
  if ruim is not null then
    raise exception 'índice único com lead_id e mais de uma coluna: % (revise o script)', ruim;
  end if;
end
$g$;

-- 1. plano: leads de teste ------------------------------------------------------------

create temp table plano_teste on commit drop as
select
  l.id,
  pg_temp.tem_teste(l.name) as por_nome,
  pg_temp.tem_teste(l.email) as por_email,
  coalesce(pg_temp.tem_teste(co.name), false) as por_empresa,
  (l.rd_deal_id is not null and l.rd_deal_id in (select rd_deal_id from rd_teste)) as por_rd,
  (l.won is false and pg_temp.tem_teste(l.lost_reason)) as por_motivo,
  (l.rd_deal_id is not null and (
    exists (select 1 from public.rd_crm_deals d where d.rd_id = l.rd_deal_id and d.is_test)
    or exists (select 1 from public.campaign_leads c where c.rd_deal_id = l.rd_deal_id and c.is_test)
  )) as por_painel,
  l.won,
  l.stage_order,
  l.pipeline,
  l.import_batch_id,
  l.company_id,
  exists (select 1 from public.client_contracts k where k.lead_id = l.id) as tem_contrato
from public.leads l
left join public.crm_companies co on co.id = l.company_id;

delete from plano_teste
where not (por_nome or por_email or por_empresa or por_rd or por_motivo or por_painel);

alter table plano_teste add column suspeito text, add column apagar boolean;

-- Com cara de negociação de verdade: fica, a não ser que peçam (limpeza.apagar_suspeitos).
update plano_teste set suspeito = case
  when won is true then 'ganha'
  when tem_contrato then 'contrato'
  when won is null and coalesce(stage_order, 0) >= 3 then 'etapa_3_ou_mais'
end;

update plano_teste
set apagar = suspeito is null or current_setting('limpeza.apagar_suspeitos') = '1';

create temp table apagar on commit drop as select id from plano_teste where apagar;
alter table apagar add primary key (id);

-- 2. plano: repetidos -------------------------------------------------------------------

create temp table base on commit drop as
select
  l.id,
  l.created_at,
  l.won,
  l.pipeline,
  l.owner_employee_id,
  l.stage_order,
  l.managed_by,
  pg_temp.fone(l.phone) as fone,
  pg_temp.fone_sem_9(l.phone) as fone_sem_9,
  pg_temp.email(l.email) as email
from public.leads l
where l.id not in (select id from apagar);

create temp table chaves on commit drop as
select id, 'fone'::text as tipo, fone as chave from base where fone is not null
union all
select id, 'email', email from base where email is not null;

-- Telefones e e-mails da própria Wings (funcionários, links de WhatsApp, clientes)
-- digitados num lead não dizem que dois leads são a mesma pessoa.
create temp table chaves_da_casa on commit drop as
select distinct tipo, chave from (
  select 'fone' as tipo, pg_temp.fone(phone) as chave from public.employees
  union all select 'email', pg_temp.email(email) from public.employees
  union all select 'fone', pg_temp.fone(phone) from public.lead_tracking_links
  union all select 'fone', pg_temp.fone(phone) from public.clients
  union all select 'fone', pg_temp.fone(whatsapp) from public.clients
  union all select 'email', pg_temp.email(email) from public.clients
) c
where chave is not null;

create temp table chaves_ignoradas on commit drop as
select k.tipo, k.chave, count(*) as leads,
  case when exists (select 1 from chaves_da_casa c where c.tipo = k.tipo and c.chave = k.chave)
    then 'da_casa' else 'muitos' end as motivo
from chaves k
group by k.tipo, k.chave
having count(*) > 1
  and (
    count(*) > current_setting('limpeza.limite_chave')::int
    or exists (select 1 from chaves_da_casa c where c.tipo = k.tipo and c.chave = k.chave)
  );

delete from chaves k using chaves_ignoradas i where k.tipo = i.tipo and k.chave = i.chave;
delete from chaves k
where (k.tipo, k.chave) in (select tipo, chave from chaves group by tipo, chave having count(*) = 1);

-- Grupos: leads ligados por qualquer telefone ou e-mail em comum, mesmo em cadeia.
create temp table comp on commit drop as select distinct id, id::text as raiz from chaves;

do $c$
declare
  mudou int;
begin
  loop
    with m as (
      select k.tipo, k.chave, min(c.raiz) as r from chaves k join comp c using (id) group by k.tipo, k.chave
    ), x as (
      select k.id, min(m.r) as r from chaves k join m using (tipo, chave) group by k.id
    )
    update comp c set raiz = x.r from x where c.id = x.id and x.r < c.raiz;
    get diagnostics mudou = row_count;
    exit when mudou = 0;
  end loop;
end
$c$;

create temp table grupo on commit drop as
select c.raiz, b.* from comp c join base b using (id);

create temp table grupo_info on commit drop as
select
  g.raiz,
  count(*) as tamanho,
  count(*) filter (where g.won is true) as ganhas,
  count(*) filter (where g.won is null) as abertas,
  count(distinct g.pipeline) filter (where g.won is null) as funis_abertos,
  count(distinct g.owner_employee_id) filter (where g.won is null) as donos_abertos,
  bool_or(exists (select 1 from chaves k where k.id = g.id and k.tipo = 'fone')) as por_fone,
  bool_or(exists (select 1 from chaves k where k.id = g.id and k.tipo = 'email')) as por_email
from grupo g
group by g.raiz;

alter table grupo_info add column conflito text;

-- Juntar apagaria uma negociação viva: o grupo fica separado, para uma pessoa decidir.
update grupo_info set conflito = case
  when ganhas >= 2 then 'duas_ganhas'
  when ganhas >= 1 and abertas >= 1 then 'ganha_e_aberta'
  when funis_abertos >= 2 then 'abertas_em_funis_diferentes'
  when donos_abertos >= 2 then 'abertas_com_donos_diferentes'
end;

-- Quem fica: a ganha, senão a aberta, senão a perdida; depois a que tem dono, a tocada
-- no Wings System, a de etapa mais adiantada, a mais antiga.
create temp table juncao on commit drop as
select
  g.id,
  g.raiz,
  first_value(g.id) over w as vencedor,
  row_number() over w as ordem
from grupo g
join grupo_info i using (raiz)
where i.conflito is null
window w as (
  partition by g.raiz
  order by
    case when g.won is true then 0 when g.won is null then 1 else 2 end,
    g.owner_employee_id is null,
    g.managed_by is distinct from 'wings',
    g.stage_order desc nulls last,
    g.created_at,
    g.id
);

create temp table perdedor on commit drop as
select id, vencedor, ordem from juncao where id <> vencedor;
alter table perdedor add primary key (id);

create temp table vencedores on commit drop as select distinct vencedor as id from perdedor;
alter table vencedores add primary key (id);

-- O BI (dw.dim_lead) não tem carga ainda; se tiver linhas destes leads, alguém precisa olhar antes.
do $d$
declare
  n int;
begin
  if to_regclass('dw.dim_lead') is not null then
    execute $q$
      select count(*) from dw.dim_lead
      where lead_id in (select id::text from apagar union all select id::text from perdedor)
    $q$ into n;
    if n > 0 then
      raise exception 'dw.dim_lead tem % linha(s) de leads que sumiriam (revise o BI antes)', n;
    end if;
  end if;
end
$d$;

-- 3. o plano em números -------------------------------------------------------------------

select format(
  'teste por campo: nome %s, e-mail %s, empresa %s, nome do negócio no RD %s, motivo de perda %s, marcado no painel %s',
  count(*) filter (where por_nome), count(*) filter (where por_email),
  count(*) filter (where por_empresa), count(*) filter (where por_rd),
  count(*) filter (where por_motivo), count(*) filter (where por_painel)
) from plano_teste;

select format(
  'teste: %s lead(s) (do lote rd-crm-20261006T1840Z: %s; de outros lotes do RD: %s; sem lote: %s)',
  count(*),
  count(*) filter (where import_batch_id = 'rd-crm-20261006T1840Z'),
  count(*) filter (where import_batch_id is not null and import_batch_id <> 'rd-crm-20261006T1840Z'),
  count(*) filter (where import_batch_id is null)
) from plano_teste;

select 'teste por funil: ' || coalesce(string_agg(format('%s %s', funil, n), ', ' order by funil), 'nenhum')
from (select coalesce(pipeline, 'sem funil') as funil, count(*) as n from plano_teste group by 1) f;

select format(
  'teste com cara de negociação de verdade: %s (ganha %s, etapa 3 ou mais %s, com contrato %s) -> %s',
  count(*) filter (where suspeito is not null),
  count(*) filter (where suspeito = 'ganha'),
  count(*) filter (where suspeito = 'etapa_3_ou_mais'),
  count(*) filter (where suspeito = 'contrato'),
  case when current_setting('limpeza.apagar_suspeitos') = '1'
    then 'APAGADOS JUNTO (APAGAR_SUSPEITOS=1)'
    else 'ficam (para apagar também: APAGAR_SUSPEITOS=1)' end
) from plano_teste;

select format('teste a apagar: %s', count(*)) from apagar;

select format(
  'repetidos: telefones/e-mails ignorados: %s da própria Wings, %s em mais de %s leads (%s lead(s) nesses)',
  count(*) filter (where motivo = 'da_casa'),
  count(*) filter (where motivo = 'muitos'),
  current_setting('limpeza.limite_chave'),
  coalesce(sum(leads), 0)
) from chaves_ignoradas;

select format(
  'repetidos: %s grupo(s) (só telefone %s, só e-mail %s, os dois %s); maior grupo: %s leads; %s telefone(s) juntam números gravados com e sem o 9',
  count(*),
  count(*) filter (where por_fone and not por_email),
  count(*) filter (where por_email and not por_fone),
  count(*) filter (where por_fone and por_email),
  coalesce(max(tamanho), 0),
  (
    select count(*) from (
      select k.chave from chaves k join base b using (id)
      where k.tipo = 'fone' group by k.chave having count(distinct b.fone_sem_9) > 1
    ) x
  )
) from grupo_info;

select format(
  'repetidos em conflito (ficam separados): %s grupo(s), %s lead(s) (duas ganhas %s, ganha e aberta %s, abertas em funis diferentes %s, abertas com donos diferentes %s)',
  count(*) filter (where conflito is not null),
  coalesce(sum(tamanho) filter (where conflito is not null), 0),
  count(*) filter (where conflito = 'duas_ganhas'),
  count(*) filter (where conflito = 'ganha_e_aberta'),
  count(*) filter (where conflito = 'abertas_em_funis_diferentes'),
  count(*) filter (where conflito = 'abertas_com_donos_diferentes')
) from grupo_info;

select format(
  'repetidos a juntar: %s grupo(s); %s lead(s) somem e o que tinham passa para o que fica',
  (select count(*) from vencedores), (select count(*) from perdedor)
);

select 'repetidos por funil (dos que somem): ' || coalesce(string_agg(format('%s %s', funil, n), ', ' order by funil), 'nenhum')
from (
  select coalesce(l.pipeline, 'sem funil') as funil, count(*) as n
  from perdedor p join public.leads l on l.id = p.id group by 1
) f;

-- O seguimento do RD (a cada hora, com CRM_RD_FOLLOW_ENABLED) traz de novo os negócios
-- dos últimos 3 dias que não acha no Funil pelo id do negócio.
select format(
  'aviso: %s teste(s) e %s repetido(s) que somem têm negócio do RD criado nos últimos 3 dias; com o seguimento do RD ligado, podem voltar na hora seguinte',
  count(*) filter (where x.teste), count(*) filter (where not x.teste)
)
from (
  select true as teste, l.* from public.leads l where l.id in (select id from apagar)
  union all
  select false, l.* from public.leads l where l.id in (select id from perdedor)
) x
where x.rd_deal_id is not null
  and (
    exists (select 1 from public.rd_crm_deals d where d.rd_id = x.rd_deal_id and d.created_at > now() - interval '3 days')
    or (x.source = 'rd_crm' and x.created_at > now() - interval '3 days')
  );

-- Para conferir na tela do CRM (/crm-vendas/negociacoes/<id>): só no log.
select format('  conferir teste %s: %s', suspeito, id) from plano_teste where suspeito is not null order by suspeito, id;
select format('  conflito %s: %s', i.conflito, string_agg(g.id::text, ' ' order by g.created_at))
from grupo_info i join grupo g using (raiz) where i.conflito is not null group by i.raiz, i.conflito order by 1;

select format('PLANO: apagar=%s juntar=%s', (select count(*) from apagar), (select count(*) from perdedor));

-- O plano não pode ter crescido muito desde a simulação que a pessoa leu.
do $e$
declare
  esperado_apagar text := current_setting('limpeza.esperado_apagar');
  esperado_juntar text := current_setting('limpeza.esperado_juntar');
  n int;
begin
  if esperado_apagar <> '' then
    select count(*) into n from apagar;
    if n > esperado_apagar::int + greatest(5, esperado_apagar::int / 10) then
      raise exception 'o plano mudou desde a simulação (apagar: % agora, % na simulação); simule de novo', n, esperado_apagar;
    end if;
  end if;
  if esperado_juntar <> '' then
    select count(*) into n from perdedor;
    if n > esperado_juntar::int + greatest(5, esperado_juntar::int / 10) then
      raise exception 'o plano mudou desde a simulação (juntar: % agora, % na simulação); simule de novo', n, esperado_juntar;
    end if;
  end if;
end
$e$;

-- 4. execução -----------------------------------------------------------------------------

-- Cópia do que muda, para desfazer este lote sozinho (desfazer.sql). Fica no banco, com a
-- mesma proteção dos dados de origem; o wings_ro não lê este esquema.
create schema if not exists ops;

create table if not exists ops.lead_cleanup_runs (
  batch_id text primary key,
  created_at timestamptz not null default now(),
  summary jsonb not null default '{}',
  undone_at timestamptz
);

-- step: ordem de re-inserção ao desfazer (1 empresas, 2 contatos, 3 leads, 4 filhas,
-- 5 filhas das filhas). action: delete | repoint (lead_id -> new_lead_id) | detach
-- (lead_id -> null) | winner (row_data = antes, changed = o que a junção escreveu).
create table if not exists ops.lead_cleanup_rows (
  id bigserial primary key,
  batch_id text not null references ops.lead_cleanup_runs (batch_id),
  step int not null,
  table_name text not null,
  action text not null,
  lead_id uuid,
  new_lead_id uuid,
  row_data jsonb not null,
  changed jsonb
);
create index if not exists lead_cleanup_rows_batch_idx on ops.lead_cleanup_rows (batch_id, action, step);

do $l$
begin
  if exists (select 1 from ops.lead_cleanup_runs where batch_id = current_setting('limpeza.lote')) then
    raise exception 'lote % já existe; rode de novo daqui a um segundo', current_setting('limpeza.lote');
  end if;
end
$l$;
insert into ops.lead_cleanup_runs (batch_id) values (current_setting('limpeza.lote'));

create temp table feito (chave text primary key, n bigint not null default 0) on commit drop;

create function pg_temp.somar(p_chave text, p_n bigint) returns void language sql as $f$
  insert into feito values (p_chave, p_n) on conflict (chave) do update set n = feito.n + excluded.n
$f$;

-- 4a. testes: guarda e apaga, das filhas das filhas até o lead.
do $t$
declare
  lote text := current_setting('limpeza.lote');
  f record;
  onde text;
  n bigint;
begin
  for f in select * from filhas order by passo desc, tabela loop
    if f.soltar then
      execute format(
        'insert into ops.lead_cleanup_rows (batch_id, step, table_name, action, lead_id, row_data)
         select $1, %s, %L, ''detach'', t.lead_id, to_jsonb(t) from public.%I t where t.lead_id in (select id from apagar)',
        f.passo, f.tabela, f.tabela) using lote;
      execute format('update public.%I set lead_id = null where lead_id in (select id from apagar)', f.tabela);
      get diagnostics n = row_count;
      perform pg_temp.somar('teste_soltas', n);
      continue;
    end if;
    onde := case when f.tem_lead then 't.lead_id in (select id from apagar)' else 'false' end;
    if f.via_tabela is not null then
      onde := onde || format(
        ' or t.%I in (select v.id from public.%I v where v.lead_id in (select id from apagar))',
        f.via_coluna, f.via_tabela);
    end if;
    execute format(
      'insert into ops.lead_cleanup_rows (batch_id, step, table_name, action, lead_id, row_data)
       select $1, %s, %L, ''delete'', %s, to_jsonb(t) from public.%I t where %s',
      f.passo, f.tabela, case when f.tem_lead then 't.lead_id' else 'null' end, f.tabela, onde) using lote;
    execute format('delete from public.%I t where %s', f.tabela, onde);
    get diagnostics n = row_count;
    perform pg_temp.somar('teste_filhas', n);
  end loop;

  insert into ops.lead_cleanup_rows (batch_id, step, table_name, action, lead_id, row_data)
  select lote, 3, 'leads', 'delete', l.id, to_jsonb(l) from public.leads l where l.id in (select id from apagar);
  delete from public.leads where id in (select id from apagar);
  get diagnostics n = row_count;
  perform pg_temp.somar('teste_leads', n);
end
$t$;

-- Contatos e empresas que só existiam para os testes: sem outro lead, sem outro contato
-- apontando para eles e com "teste" no próprio nome ou e-mail.
create temp table contato_teste on commit drop as
select c.id
from public.crm_contacts c
where c.id in (
    select (b.row_data ->> 'contact_id')::uuid from ops.lead_cleanup_rows b
    where b.batch_id = current_setting('limpeza.lote') and b.table_name = 'lead_contacts' and b.action = 'delete'
  )
  and (pg_temp.tem_teste(c.name) or pg_temp.tem_teste(c.email))
  and not exists (select 1 from public.lead_contacts lc where lc.contact_id = c.id)
  and not exists (select 1 from public.crm_contacts o where o.merged_into_id = c.id);

insert into ops.lead_cleanup_rows (batch_id, step, table_name, action, row_data)
select current_setting('limpeza.lote'), 2, 'crm_contacts', 'delete', to_jsonb(c)
from public.crm_contacts c where c.id in (select id from contato_teste);
delete from public.crm_contacts where id in (select id from contato_teste);
insert into feito select 'teste_contatos', count(*) from contato_teste;

create temp table empresa_teste on commit drop as
select e.id
from public.crm_companies e
where e.id in (select company_id from plano_teste where apagar and company_id is not null)
  and pg_temp.tem_teste(e.name)
  and not exists (select 1 from public.leads l where l.company_id = e.id)
  and not exists (select 1 from public.crm_contacts c where c.company_id = e.id)
  and not exists (select 1 from public.crm_companies o where o.merged_into_id = e.id);

insert into ops.lead_cleanup_rows (batch_id, step, table_name, action, row_data)
select current_setting('limpeza.lote'), 1, 'crm_companies', 'delete', to_jsonb(e)
from public.crm_companies e where e.id in (select id from empresa_teste);
delete from public.crm_companies where id in (select id from empresa_teste);
insert into feito select 'teste_empresas', count(*) from empresa_teste;

-- 4b. repetidos: as filhas passam para o lead que fica.
do $j$
declare
  lote text := current_setting('limpeza.lote');
  f record;
  u record;
  outras text;
  n bigint;
begin
  for f in select * from filhas where tem_lead order by tabela loop
    -- Um vínculo que o lead que fica já tem (o mesmo contato, o mesmo arquivo) não é duplicado.
    for u in
      select i.indexrelid, (
          select string_agg(format('t.%I', a.attname), ', ')
          from pg_attribute a
          where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname <> 'lead_id'
        ) as colunas
      from pg_index i
      where i.indisunique and i.indrelid = format('public.%I', f.tabela)::regclass
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname = 'lead_id'
        )
        and i.indnatts = 2
    loop
      outras := u.colunas;
      execute format(
        'create temp table repetida on commit drop as
         select ctid as linha from (
           select t.ctid, row_number() over (partition by j.vencedor, %s order by j.ordem) as rn
           from public.%I t join juncao j on j.id = t.lead_id
           where j.vencedor in (select id from vencedores)
         ) x where rn > 1',
        outras, f.tabela);
      execute format(
        'insert into ops.lead_cleanup_rows (batch_id, step, table_name, action, lead_id, row_data)
         select $1, %s, %L, ''delete'', t.lead_id, to_jsonb(t) from public.%I t where t.ctid in (select linha from repetida)',
        f.passo, f.tabela, f.tabela) using lote;
      execute format('delete from public.%I t where t.ctid in (select linha from repetida)', f.tabela);
      get diagnostics n = row_count;
      perform pg_temp.somar('juncao_vinculos_repetidos', n);
      drop table repetida;
    end loop;

    execute format(
      'insert into ops.lead_cleanup_rows (batch_id, step, table_name, action, lead_id, new_lead_id, row_data)
       select $1, %s, %L, ''repoint'', t.lead_id, p.vencedor, to_jsonb(t)
       from public.%I t join perdedor p on p.id = t.lead_id',
      f.passo, f.tabela, f.tabela) using lote;
    execute format(
      'update public.%I t set lead_id = p.vencedor from perdedor p where p.id = t.lead_id', f.tabela);
    get diagnostics n = row_count;
    perform pg_temp.somar('juncao_filhas', n);
  end loop;
end
$j$;

-- 4c. o lead que fica guarda o que tem e herda só o que está vazio (como uma chegada
-- repetida faz hoje): contato, origem, empresa, valor, dono. Etapa e resultado são dele.
insert into ops.lead_cleanup_rows (batch_id, step, table_name, action, lead_id, row_data)
select current_setting('limpeza.lote'), 3, 'leads', 'winner', l.id, to_jsonb(l)
from public.leads l where l.id in (select id from vencedores);

create temp table doador on commit drop as
select p.vencedor, p.ordem, l.*
from perdedor p join public.leads l on l.id = p.id;

update public.leads l set
  name = coalesce(l.name, (select d.name from doador d where d.vencedor = l.id and d.name is not null order by d.ordem limit 1)),
  email = coalesce(l.email, (select d.email from doador d where d.vencedor = l.id and d.email is not null order by d.ordem limit 1)),
  phone = coalesce(l.phone, (select d.phone from doador d where d.vencedor = l.id and d.phone is not null order by d.ordem limit 1)),
  whatsapp_profile_name = coalesce(l.whatsapp_profile_name, (select d.whatsapp_profile_name from doador d where d.vencedor = l.id and d.whatsapp_profile_name is not null order by d.ordem limit 1)),
  whatsapp_photo_url = coalesce(l.whatsapp_photo_url, (select d.whatsapp_photo_url from doador d where d.vencedor = l.id and d.whatsapp_photo_url is not null order by d.ordem limit 1)),
  first_message = coalesce(l.first_message, (select d.first_message from doador d where d.vencedor = l.id and d.first_message is not null order by d.ordem limit 1)),
  city = coalesce(l.city, (select d.city from doador d where d.vencedor = l.id and d.city is not null order by d.ordem limit 1)),
  form_answers = coalesce(l.form_answers, (select d.form_answers from doador d where d.vencedor = l.id and d.form_answers is not null order by d.ordem limit 1)),
  channel = coalesce(l.channel, (select d.channel from doador d where d.vencedor = l.id and d.channel is not null order by d.ordem limit 1)),
  tracking_link_id = coalesce(l.tracking_link_id, (select d.tracking_link_id from doador d where d.vencedor = l.id and d.tracking_link_id is not null order by d.ordem limit 1)),
  landing_page = coalesce(l.landing_page, (select d.landing_page from doador d where d.vencedor = l.id and d.landing_page is not null order by d.ordem limit 1)),
  form_id = coalesce(l.form_id, (select d.form_id from doador d where d.vencedor = l.id and d.form_id is not null order by d.ordem limit 1)),
  brand = coalesce(l.brand, (select d.brand from doador d where d.vencedor = l.id and d.brand is not null order by d.ordem limit 1)),
  company_id = coalesce(l.company_id, (select d.company_id from doador d where d.vencedor = l.id and d.company_id is not null order by d.ordem limit 1)),
  value_cents = coalesce(l.value_cents, (select d.value_cents from doador d where d.vencedor = l.id and d.value_cents is not null order by d.ordem limit 1)),
  expected_close_at = coalesce(l.expected_close_at, (select d.expected_close_at from doador d where d.vencedor = l.id and d.expected_close_at is not null order by d.ordem limit 1)),
  owner_employee_id = coalesce(l.owner_employee_id, (select d.owner_employee_id from doador d where d.vencedor = l.id and d.owner_employee_id is not null order by d.ordem limit 1)),
  -- O funil só vem junto quando o lead que fica não tem etapa (a etapa diz o funil).
  pipeline = case when l.pipeline is null and l.stage_id is null
    then (select d.pipeline from doador d where d.vencedor = l.id and d.pipeline is not null order by d.ordem limit 1)
    else l.pipeline end,
  -- Base legal e consentimento andam juntos.
  legal_basis = coalesce(l.legal_basis, lb.legal_basis),
  consented_at = case when l.legal_basis is null and lb.legal_basis is not null then lb.consented_at else l.consented_at end,
  consent_source = case when l.legal_basis is null and lb.legal_basis is not null then lb.consent_source else l.consent_source end,
  consent_text = case when l.legal_basis is null and lb.legal_basis is not null then lb.consent_text else l.consent_text end,
  -- Campanha: id e nome juntos.
  campaign_id = coalesce(l.campaign_id, cp.campaign_id),
  campaign_name = case when l.campaign_id is null and cp.campaign_id is not null then cp.campaign_name else l.campaign_name end,
  -- Cliente: um lead sem cliente definido pega o de um repetido que tem.
  client_id = case when not l.client_mapped and cl.id is not null then cl.client_id else l.client_id end,
  client_mapped = l.client_mapped or cl.id is not null,
  -- Atribuição (primeiro toque): inteira, e só se o lead que fica não tem nenhuma.
  utm_source = case when sem_atrib then atr.utm_source else l.utm_source end,
  utm_medium = case when sem_atrib then atr.utm_medium else l.utm_medium end,
  utm_campaign = case when sem_atrib then atr.utm_campaign else l.utm_campaign end,
  utm_content = case when sem_atrib then atr.utm_content else l.utm_content end,
  utm_term = case when sem_atrib then atr.utm_term else l.utm_term end,
  gclid = case when sem_atrib then atr.gclid else l.gclid end,
  fbclid = case when sem_atrib then atr.fbclid else l.fbclid end,
  gbraid = case when sem_atrib then atr.gbraid else l.gbraid end,
  wbraid = case when sem_atrib then atr.wbraid else l.wbraid end,
  ad_platform = case when sem_atrib then atr.ad_platform else l.ad_platform end,
  ad_campaign_external_id = case when sem_atrib then atr.ad_campaign_external_id else l.ad_campaign_external_id end,
  ad_set_external_id = case when sem_atrib then atr.ad_set_external_id else l.ad_set_external_id end,
  ad_external_id = case when sem_atrib then atr.ad_external_id else l.ad_external_id end,
  referrer = case when sem_atrib then atr.referrer else l.referrer end,
  updated_at = now()
from public.leads w
left join lateral (
  select d.legal_basis, d.consented_at, d.consent_source, d.consent_text
  from doador d where d.vencedor = w.id and d.legal_basis is not null order by d.ordem limit 1
) lb on true
left join lateral (
  select d.campaign_id, d.campaign_name
  from doador d where d.vencedor = w.id and d.campaign_id is not null order by d.ordem limit 1
) cp on true
left join lateral (
  select d.id, d.client_id
  from doador d where d.vencedor = w.id and d.client_mapped order by d.ordem limit 1
) cl on true
left join lateral (
  select d.*
  from doador d
  where d.vencedor = w.id
    and coalesce(d.utm_source, d.utm_medium, d.utm_campaign, d.utm_content, d.utm_term, d.gclid,
      d.fbclid, d.gbraid, d.wbraid, d.ad_platform, d.ad_campaign_external_id, d.ad_set_external_id,
      d.ad_external_id, d.referrer) is not null
  order by d.ordem limit 1
) atr on true
cross join lateral (
  select atr.id is not null and coalesce(w.utm_source, w.utm_medium, w.utm_campaign, w.utm_content,
    w.utm_term, w.gclid, w.fbclid, w.gbraid, w.wbraid, w.ad_platform, w.ad_campaign_external_id,
    w.ad_set_external_id, w.ad_external_id, w.referrer) is null as sem_atrib
) sa
where l.id = w.id and w.id in (select id from vencedores);

-- O que a junção escreveu em cada lead que fica (para desfazer só isso, se ninguém mexeu depois).
update ops.lead_cleanup_rows b set changed = (
  select coalesce(jsonb_object_agg(e.key, e.value), '{}')
  from jsonb_each(to_jsonb(l)) e
  where e.value is distinct from b.row_data -> e.key
)
from public.leads l
where b.batch_id = current_setting('limpeza.lote') and b.action = 'winner' and l.id = b.lead_id;

-- A junção fica no histórico do lead (ids e rótulos, nunca dado da pessoa).
insert into public.lead_events (lead_id, kind, detail)
select
  p.vencedor,
  'lead.duplicates_merged',
  jsonb_build_object(
    'batchId', current_setting('limpeza.lote'),
    'merged', jsonb_agg(jsonb_build_object(
      'id', l.id, 'source', l.source, 'pipeline', l.pipeline, 'stage', l.stage, 'won', l.won,
      'rdDealId', l.rd_deal_id, 'createdAt', l.created_at
    ) order by p.ordem)
  )
from perdedor p join public.leads l on l.id = p.id
group by p.vencedor;

insert into ops.lead_cleanup_rows (batch_id, step, table_name, action, lead_id, new_lead_id, row_data)
select current_setting('limpeza.lote'), 3, 'leads', 'delete', l.id, p.vencedor, to_jsonb(l)
from public.leads l join perdedor p on p.id = l.id;
delete from public.leads where id in (select id from perdedor);
insert into feito select 'juncao_leads', count(*) from perdedor;

-- 5. registro e conferência -----------------------------------------------------------------

update ops.lead_cleanup_runs
set summary = (select jsonb_object_agg(chave, n) from feito)
  || jsonb_build_object(
    'testes', (select count(*) from apagar),
    'suspeitosMantidos', (select count(*) from plano_teste where not apagar),
    'gruposJuntados', (select count(*) from vencedores),
    'gruposEmConflito', (select count(*) from grupo_info where conflito is not null),
    'rdLido', current_setting('limpeza.rd_lido') = '1'
  )
where batch_id = current_setting('limpeza.lote');

insert into public.audit_log (action, entity, entity_id, metadata)
select 'leads.cleanup', 'lead_cleanup_batch', batch_id, summary
from ops.lead_cleanup_runs where batch_id = current_setting('limpeza.lote');

do $v$
declare
  lote text := current_setting('limpeza.lote');
  n bigint;
begin
  select count(*) into n from public.leads where id in (select id from apagar union all select id from perdedor);
  if n > 0 then raise exception 'conferência: % lead(s) que deviam sumir continuam', n; end if;
  select count(*) into n from vencedores v where not exists (select 1 from public.leads l where l.id = v.id);
  if n > 0 then raise exception 'conferência: % lead(s) que ficam sumiram', n; end if;
  select count(*) into n from ops.lead_cleanup_rows
  where batch_id = lote and table_name = 'leads' and action = 'delete';
  if n <> (select count(*) from apagar) + (select count(*) from perdedor) then
    raise exception 'conferência: a cópia dos leads apagados não bate (% guardados)', n;
  end if;
  select count(*) into n from public.leads;
  if n <> (select leads from antes) - (select count(*) from apagar) - (select count(*) from perdedor) then
    raise exception 'conferência: leads agora %, esperado %', n,
      (select leads from antes) - (select count(*) from apagar) - (select count(*) from perdedor);
  end if;
end
$v$;

select format(
  'feito: %s lead(s) de teste apagados com %s linha(s) ligadas; %s linha(s) soltas do lead (marca da Meta, contrato); %s contato(s) e %s empresa(s) de teste',
  coalesce((select n from feito where chave = 'teste_leads'), 0),
  coalesce((select n from feito where chave = 'teste_filhas'), 0),
  coalesce((select n from feito where chave = 'teste_soltas'), 0),
  coalesce((select n from feito where chave = 'teste_contatos'), 0),
  coalesce((select n from feito where chave = 'teste_empresas'), 0)
);
select format(
  'feito: %s lead(s) repetidos juntados em %s; %s linha(s) passaram para o lead que fica; %s vínculo(s) repetido(s) removidos',
  coalesce((select n from feito where chave = 'juncao_leads'), 0),
  (select count(*) from vencedores),
  coalesce((select n from feito where chave = 'juncao_filhas'), 0),
  coalesce((select n from feito where chave = 'juncao_vinculos_repetidos'), 0)
);
select format('cópia para desfazer: %s linha(s) guardadas', count(*))
from ops.lead_cleanup_rows where batch_id = current_setting('limpeza.lote');
select format('leads: %s antes, %s agora', (select leads from antes), count(*)) from public.leads;
select format('lote: %s', current_setting('limpeza.lote'));
