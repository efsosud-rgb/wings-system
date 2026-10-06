-- Um retrato do banco (hash por tabela) para comparar antes/depois: a simulação não pode
-- mudar nada, e desfazer tem de voltar ao retrato de antes. Os eventos e a auditoria que a
-- limpeza e o desfazer acrescentam de propósito ficam de fora.
\pset tuples_only on
\pset format unaligned
select t, md5(coalesce(string_agg(linha, '|' order by linha), '')) from (
  select 'leads' as t, to_jsonb(x)::text as linha from leads x
  union all select 'lead_events', to_jsonb(x)::text from lead_events x
    where kind not in ('lead.duplicates_merged', 'lead.duplicates_merge_undone')
  union all select 'lead_notes', to_jsonb(x)::text from lead_notes x
  union all select 'lead_tasks', to_jsonb(x)::text from lead_tasks x
  union all select 'lead_activities', to_jsonb(x)::text from lead_activities x
  union all select 'lead_stage_history', to_jsonb(x)::text from lead_stage_history x
  union all select 'lead_contacts', to_jsonb(x)::text from lead_contacts x
  union all select 'lead_enrichment_ledger', to_jsonb(x)::text from lead_enrichment_ledger x
  union all select 'crm_notifications', to_jsonb(x)::text from crm_notifications x
  union all select 'crm_automation_runs', to_jsonb(x)::text from crm_automation_runs x
  union all select 'crm_email_outbox', to_jsonb(x)::text from crm_email_outbox x
  union all select 'meta_leadgen_events', to_jsonb(x)::text from meta_leadgen_events x
  union all select 'client_contracts', to_jsonb(x)::text from client_contracts x
  union all select 'crm_contacts', to_jsonb(x)::text from crm_contacts x
  union all select 'crm_companies', to_jsonb(x)::text from crm_companies x
) a group by t order by t;
select 'audit_log', count(*) from audit_log where action not like 'leads.cleanup%';
select 'ops', count(*) from pg_namespace where nspname = 'ops';
