-- Rodadas de ingestão (ingest_runs) que falharam, por motivo. SÓ LEITURA: a transação é read only e termina em rollback.
-- Saem contagens, datas e códigos de erro (a coluna error guarda "códigos e nomes, nunca dado pessoal"); nenhuma pessoa.
-- Rodar (staging ou produção; trocar o contêiner do banco):
--   docker exec -i <contêiner-do-banco> psql -X -q -U wings -d wings_system -v ON_ERROR_STOP=1 < scripts/ingest-falhas.sql
-- Opcional: -v desde=AAAA-MM-DD limita a janela (padrão: tudo que existe).

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset footer off
\pset pager off
\if :{?desde}
\else
  \set desde '1970-01-01'
\endif

begin;
set transaction read only;

\echo == 1. Rodadas por estado (janela desde :desde)
select format('  %s: %s', status, count(*)) from ingest_runs
where started_at >= (:'desde' || ' 00:00:00-03')::timestamptz group by status order by status;

\echo == 2. As com falha, por tipo de rodada e por mês
select format('  %s · %s: %s', mes, trigger, n) from (
  select to_char(started_at at time zone 'America/Sao_Paulo', 'YYYY-MM') as mes, trigger, count(*) as n
  from ingest_runs where status = 'failed' and started_at >= (:'desde' || ' 00:00:00-03')::timestamptz
  group by 1, 2
) x order by mes desc, trigger;

\echo == 3. As com falha, por motivo (coluna error; senão a conta/passo/erro que falhou; senão o blog)
with falhas as (
  select r.id, r.started_at,
         coalesce(
           nullif(left(r.error, 120), ''),
           (select string_agg(distinct (a ->> 'platform') || ' / passo ' || coalesce(a ->> 'step', '?') || ' / ' || left(coalesce(a ->> 'error', '?'), 80), '; ')
              from jsonb_array_elements(r.accounts) a where a ->> 'status' = 'failed'),
           case when r.site ->> 'status' = 'failed' then 'blog / ' || left(coalesce(r.site ->> 'error', '?'), 80) end,
           '(sem motivo gravado)'
         ) as motivo
  from ingest_runs r
  where r.status = 'failed' and r.started_at >= (:'desde' || ' 00:00:00-03')::timestamptz
)
select format('  %s rodada(s) · de %s a %s · %s', count(*), to_char(min(started_at) at time zone 'America/Sao_Paulo', 'DD/MM'),
              to_char(max(started_at) at time zone 'America/Sao_Paulo', 'DD/MM'), motivo)
from falhas group by motivo order by count(*) desc, motivo;

\echo == 4. Contas que falharam dentro das rodadas com falha (uma linha por conta e passo; a mesma rodada pode ter várias)
select format('  %s · passo %s · %s: %s', plataforma, passo, erro, n) from (
  select a ->> 'platform' as plataforma, coalesce(a ->> 'step', '?') as passo, left(coalesce(a ->> 'error', '?'), 80) as erro, count(*) as n
  from ingest_runs r, jsonb_array_elements(r.accounts) a
  where r.status = 'failed' and a ->> 'status' = 'failed' and r.started_at >= (:'desde' || ' 00:00:00-03')::timestamptz
  group by 1, 2, 3
) x order by n desc, plataforma, passo, erro;

\echo == 5. A última rodada com falha e a última boa, por tipo
select format('  %s: última com falha %s · última ok %s', trigger,
              coalesce(to_char(max(started_at) filter (where status = 'failed') at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), '—'),
              coalesce(to_char(max(started_at) filter (where status = 'ok') at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'), '—'))
from ingest_runs group by trigger order by trigger;

rollback;
