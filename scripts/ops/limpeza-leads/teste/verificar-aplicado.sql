-- Depois de aplicar a limpeza sobre dados.sql: confere cada regra. Para no primeiro erro.
\set ON_ERROR_STOP on
do $v$
declare
  n bigint;
  r record;
begin
  -- testes apagados; suspeitos e controles ficam
  select count(*) into n from leads where id in (
    'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002',
    'aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000004',
    'aaaaaaaa-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000006',
    'aaaaaaaa-0000-4000-8000-00000000000b', 'aaaaaaaa-0000-4000-8000-00000000000c');
  if n <> 0 then raise exception 'testes que deviam sumir: % ficaram', n; end if;
  select count(*) into n from leads where id in (
    'aaaaaaaa-0000-4000-8000-000000000007', 'aaaaaaaa-0000-4000-8000-000000000008',
    'aaaaaaaa-0000-4000-8000-000000000009', 'aaaaaaaa-0000-4000-8000-00000000000a',
    'aaaaaaaa-0000-4000-8000-00000000000d', 'aaaaaaaa-0000-4000-8000-00000000000e',
    'aaaaaaaa-0000-4000-8000-00000000000f', 'aaaaaaaa-0000-4000-8000-000000000010');
  if n <> 8 then raise exception 'suspeitos/controles: % de 8 ficaram', n; end if;

  -- filhas do teste T1 apagadas; a marca da Meta fica, sem lead
  select count(*) into n from lead_events where lead_id = 'aaaaaaaa-0000-4000-8000-000000000001';
  if n <> 0 then raise exception 'eventos do teste ficaram'; end if;
  select count(*) into n from crm_email_outbox where run_id = 'a0700000-0000-4000-8000-000000000001';
  if n <> 0 then raise exception 'e-mail da automação do teste ficou'; end if;
  select count(*) into n from meta_leadgen_events
  where leadgen_id = 'lg-t1' and lead_id is null and status = 'failed' and last_error = 'limpeza_teste';
  if n <> 1 then raise exception 'marca da Meta do teste devia ficar, sem lead e fechada'; end if;

  -- contato e empresa só do teste somem; os compartilhados ficam
  if exists (select 1 from crm_contacts where id = 'cccccccc-0000-4000-8000-000000000001') then
    raise exception 'contato de teste ficou'; end if;
  if not exists (select 1 from crm_contacts where id = 'cccccccc-0000-4000-8000-000000000002') then
    raise exception 'contato compartilhado sumiu'; end if;
  if exists (select 1 from crm_companies where id = 'c0c0c0c0-0000-4000-8000-000000000001') then
    raise exception 'empresa de teste ficou'; end if;
  if not exists (select 1 from crm_companies where id = 'c0c0c0c0-0000-4000-8000-000000000002') then
    raise exception 'empresa real sumiu'; end if;

  -- D1: fica 11, herda e-mail, atribuição e valor; recebe as filhas de 12; um só vínculo com K3
  select * into r from leads where id = 'aaaaaaaa-0000-4000-8000-000000000011';
  if r.email is distinct from 'd1@x.example' or r.utm_source is distinct from 'facebook'
     or r.utm_campaign is distinct from 'camp-1' or r.value_cents is distinct from 150000
     or r.name is distinct from 'Dup Um' then
    raise exception 'D1: o lead que ficou não herdou o que devia';
  end if;
  if exists (select 1 from leads where id = 'aaaaaaaa-0000-4000-8000-000000000012') then
    raise exception 'D1: o repetido ficou'; end if;
  select count(*) into n from lead_notes where lead_id = 'aaaaaaaa-0000-4000-8000-000000000011';
  if n <> 1 then raise exception 'D1: nota do repetido não passou'; end if;
  select count(*) into n from crm_email_outbox where lead_id = 'aaaaaaaa-0000-4000-8000-000000000011';
  if n <> 1 then raise exception 'D1: e-mail do repetido não passou'; end if;
  select count(*) into n from lead_contacts where contact_id = 'cccccccc-0000-4000-8000-000000000003';
  if n <> 1 then raise exception 'D1: vínculo com o contato devia ser um só (%)', n; end if;
  select count(*) into n from lead_contacts where lead_id = 'aaaaaaaa-0000-4000-8000-000000000011' and "primary";
  if n <> 1 then raise exception 'D1: contatos principais: % (esperado 1)', n; end if;
  if not exists (select 1 from lead_contacts where lead_id = 'aaaaaaaa-0000-4000-8000-000000000011'
                 and contact_id = 'cccccccc-0000-4000-8000-000000000003' and "primary") then
    raise exception 'D1: o principal devia ser o do lead que ficou'; end if;
  select count(*) into n from lead_events
  where lead_id = 'aaaaaaaa-0000-4000-8000-000000000011' and kind = 'lead.duplicates_merged'
    and detail -> 'merged' -> 0 ->> 'id' = 'aaaaaaaa-0000-4000-8000-000000000012';
  if n <> 1 then raise exception 'D1: junção não ficou no histórico'; end if;

  -- D2: fica 22 (aberta com dono), herda empresa e telefone; contrato e marca da Meta passam
  select * into r from leads where id = 'aaaaaaaa-0000-4000-8000-000000000022';
  if r.company_id is distinct from 'c0c0c0c0-0000-4000-8000-000000000002'
     or r.phone is distinct from '5511922220002' or r.won is not null
     or r.owner_employee_id is distinct from 'eeeeeeee-0000-4000-8000-000000000001' then
    raise exception 'D2: o lead que ficou está errado';
  end if;
  select count(*) into n from client_contracts where lead_id = 'aaaaaaaa-0000-4000-8000-000000000022';
  if n <> 1 then raise exception 'D2: contrato não passou'; end if;
  select count(*) into n from meta_leadgen_events where leadgen_id = 'lg-d2a' and lead_id = 'aaaaaaaa-0000-4000-8000-000000000022';
  if n <> 1 then raise exception 'D2: marca da Meta não passou'; end if;
  select count(*) into n from lead_events where kind = 'rd.import_batch';
  if n <> 0 then raise exception 'D2: retrato da importação do RD foi junto para o lead que fica'; end if;

  -- D3: cadeia de três vira um (31), que herda o e-mail; a atividade de 33 passa
  select count(*) into n from leads where id in ('aaaaaaaa-0000-4000-8000-000000000031', 'aaaaaaaa-0000-4000-8000-000000000032', 'aaaaaaaa-0000-4000-8000-000000000033');
  if n <> 1 then raise exception 'D3: ficaram %', n; end if;
  if (select email from leads where id = 'aaaaaaaa-0000-4000-8000-000000000031') is distinct from 'd3@x.example' then
    raise exception 'D3: e-mail não veio'; end if;
  select count(*) into n from lead_activities where lead_id = 'aaaaaaaa-0000-4000-8000-000000000031';
  if n <> 1 then raise exception 'D3: atividade não passou'; end if;

  -- D4: com e sem o 9 -> fica a aberta (41), que passa a ter o número com o 9
  if exists (select 1 from leads where id = 'aaaaaaaa-0000-4000-8000-000000000042')
     or (select phone from leads where id = 'aaaaaaaa-0000-4000-8000-000000000041') is distinct from '5511987650001' then
    raise exception 'D4: 9º dígito'; end if;

  -- conflitos, enfeites e telefone da casa: tudo fica
  select count(*) into n from leads where id in (
    'aaaaaaaa-0000-4000-8000-000000000051', 'aaaaaaaa-0000-4000-8000-000000000052',
    'aaaaaaaa-0000-4000-8000-000000000061', 'aaaaaaaa-0000-4000-8000-000000000062',
    'aaaaaaaa-0000-4000-8000-000000000071', 'aaaaaaaa-0000-4000-8000-000000000072',
    'aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-0000000000a2',
    'aaaaaaaa-0000-4000-8000-000000000081', 'aaaaaaaa-0000-4000-8000-000000000082',
    'aaaaaaaa-0000-4000-8000-000000000083', 'aaaaaaaa-0000-4000-8000-000000000084',
    'aaaaaaaa-0000-4000-8000-000000000085', 'aaaaaaaa-0000-4000-8000-000000000086',
    'aaaaaaaa-0000-4000-8000-000000000091', 'aaaaaaaa-0000-4000-8000-000000000092');
  if n <> 16 then raise exception 'conflitos/ignorados: % de 16 ficaram', n; end if;

  -- D12: fica a tocada no Wings System (c2)
  if exists (select 1 from leads where id = 'aaaaaaaa-0000-4000-8000-0000000000c1')
     or not exists (select 1 from leads where id = 'aaaaaaaa-0000-4000-8000-0000000000c2') then
    raise exception 'D12: ficou o lead errado'; end if;

  select count(*) into n from leads;
  if n <> 29 then raise exception 'leads: % (esperado 29)', n; end if;
  select count(*) into n from lead_events where kind = 'lead.duplicates_merged';
  if n <> 5 then raise exception 'eventos de junção: % (esperado 5)', n; end if;
  select count(*) into n from audit_log where action = 'leads.cleanup';
  if n <> 1 then raise exception 'auditoria: %', n; end if;
end
$v$;
\echo verificar-aplicado: ok
