-- Desfaz um lote da limpeza dos leads (limpar.sql), a partir da cópia em ops.lead_cleanup_rows:
-- devolve os leads apagados (testes e repetidos) com tudo o que tinham, devolve as linhas
-- que passaram para o lead que ficou e, no lead que ficou, volta só os campos que a junção
-- escreveu e que ninguém mudou depois. Os eventos "lead.duplicates_merged" ficam (histórico
-- não se apaga); cada lead que ficou ganha um "lead.duplicates_merge_undone".
--
-- Tudo numa transação; o script de fora acrescenta COMMIT (aplicar) ou ROLLBACK (simular).
-- Parâmetro: limpeza.lote (set_config antes deste arquivo).

\set ON_ERROR_STOP on
\set VERBOSITY terse
\pset tuples_only on
\pset format unaligned
\pset footer off
\pset pager off

begin;
set local lock_timeout = '15s';
set local client_min_messages = warning;

lock table public.leads in exclusive mode;

do $c$
begin
  if to_regclass('ops.lead_cleanup_runs') is null then
    raise exception 'nenhuma limpeza registrada neste banco';
  end if;
end
$c$;

do $c$
declare
  r record;
  mais_novo text;
begin
  select * into r from ops.lead_cleanup_runs where batch_id = current_setting('limpeza.lote') for update;
  if not found then
    raise exception 'lote % não encontrado', current_setting('limpeza.lote');
  end if;
  if r.undone_at is not null then
    raise exception 'lote % já foi desfeito em %', r.batch_id, r.undone_at;
  end if;
  -- Lotes se desfazem do mais novo para o mais antigo quando mexeram nos mesmos leads.
  select r2.batch_id into mais_novo
  from ops.lead_cleanup_runs r2
  join ops.lead_cleanup_rows b2 on b2.batch_id = r2.batch_id
  where r2.created_at > r.created_at and r2.undone_at is null
    and exists (
      select 1 from ops.lead_cleanup_rows b
      where b.batch_id = r.batch_id
        and (b.lead_id in (b2.lead_id, b2.new_lead_id) or b.new_lead_id in (b2.lead_id, b2.new_lead_id))
    )
  order by r2.created_at desc
  limit 1;
  if mais_novo is not null then
    raise exception 'lote % mexeu nos mesmos leads depois deste: desfaça antes o lote %', mais_novo, mais_novo;
  end if;
end
$c$;

create temp table feito (chave text primary key, n bigint not null default 0) on commit drop;

create function pg_temp.somar(p_chave text, p_n bigint) returns void language sql as $f$
  insert into feito values (p_chave, p_n) on conflict (chave) do update set n = feito.n + excluded.n
$f$;

do $u$
declare
  lote text := current_setting('limpeza.lote');
  t record;
  w record;
  colunas text;
  valores text;
  cond text;
  qtd bigint;
begin
  -- 1. o que foi apagado volta, dos pais para as filhas (empresas, contatos, leads, filhas, netas).
  for t in
    select table_name, step from ops.lead_cleanup_rows
    where batch_id = lote and action = 'delete'
    group by table_name, step
    order by step, table_name
  loop
    select string_agg(format('%I', a.attname), ', ' order by a.attnum),
           string_agg(format('x.%I', a.attname), ', ' order by a.attnum)
      into colunas, valores
    from pg_attribute a
    where a.attrelid = format('public.%I', t.table_name)::regclass
      and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
      and a.attname in (
        select jsonb_object_keys((
          select b.row_data from ops.lead_cleanup_rows b
          where b.batch_id = lote and b.table_name = t.table_name and b.action = 'delete' and b.step = t.step
          limit 1
        ))
      );
    execute format(
      'insert into public.%I (%s) overriding system value
       select %s from ops.lead_cleanup_rows b
       cross join lateral jsonb_populate_record(null::public.%I, b.row_data) x
       where b.batch_id = $1 and b.table_name = $2 and b.action = ''delete'' and b.step = $3',
      t.table_name, colunas, valores, t.table_name) using lote, t.table_name, t.step;
    get diagnostics qtd = row_count;
    perform pg_temp.somar(case when t.table_name = 'leads' then 'leads' else 'linhas' end, qtd);
  end loop;

  -- 2. linhas que passaram para o lead que ficou voltam para o lead de antes (se ainda estão lá).
  for t in
    select distinct table_name, action from ops.lead_cleanup_rows
    where batch_id = lote and action in ('repoint', 'detach')
  loop
    select string_agg(format('t.%1$I = x.%1$I', a.attname), ' and ') into cond
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = format('public.%I', t.table_name)::regclass and c.contype = 'p'
      and a.attname <> 'lead_id';
    if cond is null then
      raise exception 'sem chave primária para devolver as linhas de %', t.table_name;
    end if;
    execute format(
      'update public.%I t set lead_id = b.lead_id%s
       from ops.lead_cleanup_rows b
       cross join lateral jsonb_populate_record(null::public.%I, b.row_data) x
       where b.batch_id = $1 and b.table_name = $2 and b.action = $3 and %s and %s',
      t.table_name,
      case
        -- a marca de contato principal que a junção tirou
        when t.table_name = 'lead_contacts' then ', "primary" = x."primary"'
        -- a marca da Meta que a limpeza fechou volta a ficar pendente
        when t.table_name = 'meta_leadgen_events' then
          ', status = case when t.last_error = ''limpeza_teste'' then x.status else t.status end,'
          ' last_error = case when t.last_error = ''limpeza_teste'' then x.last_error else t.last_error end'
        else ''
      end,
      t.table_name, cond,
      case when t.action = 'repoint' then 't.lead_id = b.new_lead_id' else 't.lead_id is null' end)
      using lote, t.table_name, t.action;
    get diagnostics qtd = row_count;
    perform pg_temp.somar(t.action, qtd);
  end loop;

  -- Linhas que tinham ido para o lead que ficou e já não existem (o desfazer do lote do RD
  -- apaga o lead que ficou com tudo o que é dele): voltam da cópia, no lead de antes.
  for t in
    select table_name, step from ops.lead_cleanup_rows
    where batch_id = lote and action = 'repoint'
    group by table_name, step
    order by step, table_name
  loop
    select string_agg(format('t.%1$I = x.%1$I', a.attname), ' and ') into cond
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.conrelid = format('public.%I', t.table_name)::regclass and c.contype = 'p';
    select string_agg(format('%I', a.attname), ', ' order by a.attnum),
           string_agg(format('x.%I', a.attname), ', ' order by a.attnum)
      into colunas, valores
    from pg_attribute a
    where a.attrelid = format('public.%I', t.table_name)::regclass
      and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
      and a.attname in (
        select jsonb_object_keys((
          select b.row_data from ops.lead_cleanup_rows b
          where b.batch_id = lote and b.table_name = t.table_name and b.action = 'repoint' and b.step = t.step
          limit 1
        ))
      );
    execute format(
      'insert into public.%I (%s) overriding system value
       select %s from ops.lead_cleanup_rows b
       cross join lateral jsonb_populate_record(null::public.%I, b.row_data) x
       where b.batch_id = $1 and b.table_name = $2 and b.action = ''repoint'' and b.step = $3
         and not exists (select 1 from public.%I t where %s)',
      t.table_name, colunas, valores, t.table_name, t.table_name, cond) using lote, t.table_name, t.step;
    get diagnostics qtd = row_count;
    perform pg_temp.somar('recriadas', qtd);
  end loop;

  -- 3. no lead que ficou, volta o que a junção escreveu, se ninguém mudou depois. Campos que
  -- andam juntos (cliente, campanha, base legal, atribuição) voltam juntos ou ficam juntos.
  for w in
    select lead_id, row_data, changed from ops.lead_cleanup_rows
    where batch_id = lote and action = 'winner'
  loop
    for t in
      select
        string_agg(format('%1$I = a.%1$I', k), ', ') as sets,
        string_agg(format('l.%1$I is not distinct from d.%1$I', k), ' and ') as iguais
      from (
        select k, case
            when k in ('client_id', 'client_mapped') then 'cliente'
            when k in ('campaign_id', 'campaign_name') then 'campanha'
            when k in ('legal_basis', 'consented_at', 'consent_source', 'consent_text') then 'base_legal'
            when k in ('utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid',
              'fbclid', 'gbraid', 'wbraid', 'ad_platform', 'ad_campaign_external_id',
              'ad_set_external_id', 'ad_external_id', 'referrer') then 'atribuicao'
            else k
          end as unidade
        from jsonb_object_keys(coalesce(w.changed, '{}')) k
      ) u
      group by unidade
    loop
      execute format(
        'update public.leads l set %s
         from jsonb_populate_record(null::public.leads, $1) a, jsonb_populate_record(null::public.leads, $2) d
         where l.id = $3 and %s',
        t.sets, t.iguais) using w.row_data, w.changed, w.lead_id;
      get diagnostics qtd = row_count;
      perform pg_temp.somar(case when qtd > 0 then 'campos_devolvidos' else 'campos_mantidos' end, 1);
    end loop;
  end loop;

  insert into public.lead_events (lead_id, kind, detail)
  select distinct b.lead_id, 'lead.duplicates_merge_undone', jsonb_build_object('batchId', lote)
  from ops.lead_cleanup_rows b
  where b.batch_id = lote and b.action = 'winner'
    and exists (select 1 from public.leads l where l.id = b.lead_id);

  update ops.lead_cleanup_runs set undone_at = now() where batch_id = lote;

  insert into public.audit_log (action, entity, entity_id, metadata)
  select 'leads.cleanup_undone', 'lead_cleanup_batch', lote, coalesce(jsonb_object_agg(chave, n), '{}') from feito;
end
$u$;

select format(
  'desfeito: %s lead(s) de volta; %s outra(s) linha(s) re-inseridas; %s linha(s) devolvidas ao lead de antes (%s recriadas da cópia); %s religada(s) ao lead (marca da Meta, contrato)',
  coalesce((select n from feito where chave = 'leads'), 0),
  coalesce((select n from feito where chave = 'linhas'), 0),
  coalesce((select n from feito where chave = 'repoint'), 0),
  coalesce((select n from feito where chave = 'recriadas'), 0),
  coalesce((select n from feito where chave = 'detach'), 0)
);
select format(
  'desfeito: nos leads que ficaram, %s campo(s) ou grupo(s) de campos voltaram ao que eram; %s mantido(s) porque mudaram depois da limpeza',
  coalesce((select n from feito where chave = 'campos_devolvidos'), 0),
  coalesce((select n from feito where chave = 'campos_mantidos'), 0)
);
select format('leads agora: %s', count(*)) from public.leads;
select format('lote: %s', current_setting('limpeza.lote'));
