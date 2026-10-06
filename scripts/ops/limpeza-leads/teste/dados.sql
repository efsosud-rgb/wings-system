-- Dados fictícios para testar a limpeza (rodar-testes.sh). Nada aqui é de pessoa real:
-- e-mails em .example, telefones inventados. Serve aos dois esquemas (produção 0501fcf e develop).
\set ON_ERROR_STOP on
begin;

insert into sectors (id, slug, name) values ('5ec70000-0000-4000-8000-000000000001', 'comercial-t', 'Comercial (teste)');
insert into roles (id, key, name, rank) values ('701e0000-0000-4000-8000-000000000001', 'vendedor_t', 'Vendedor (teste)', 10);
insert into employees (id, full_name, cpf_encrypted, cpf_index, birth_date, phone, email, cargo, sector_id, role_id, admission_date)
values
  ('eeeeeeee-0000-4000-8000-000000000001', 'Vendedor Um', 'x', 'idx1', '1990-01-01', '5511900000001', 'um@wings.example', 'Vendedor', '5ec70000-0000-4000-8000-000000000001', '701e0000-0000-4000-8000-000000000001', '2024-01-01'),
  ('eeeeeeee-0000-4000-8000-000000000002', 'Vendedor Dois', 'x', 'idx2', '1990-01-01', '5511900000002', 'dois@wings.example', 'Vendedor', '5ec70000-0000-4000-8000-000000000001', '701e0000-0000-4000-8000-000000000001', '2024-01-01');

insert into clients (id, name, slug, whatsapp) values ('c11e0000-0000-4000-8000-000000000002', 'Marca X', 'marca-x', '5511955550000');
insert into lead_tracking_links (client_id, channel, code, phone) values ('c11e0000-0000-4000-8000-000000000002', 'instagram', 'ABCDEF', '5511955551111');

insert into crm_companies (id, name, name_key) values
  ('c0c0c0c0-0000-4000-8000-000000000001', 'Empresa Teste Ltda', 'empresa teste ltda'),
  ('c0c0c0c0-0000-4000-8000-000000000002', 'Padaria Real', 'padaria real');

insert into crm_contacts (id, name, email, phone) values
  ('cccccccc-0000-4000-8000-000000000001', 'Teste Contato', 'teste@x.example', null),
  ('cccccccc-0000-4000-8000-000000000002', 'Maria', 'maria@x.example', null),
  ('cccccccc-0000-4000-8000-000000000003', 'Duplo', null, '5511922220001');

-- leads: (id, name, email, phone, pipeline, won, stage_order, created_at, extras)
insert into leads (id, source, name, email, phone, pipeline, won, stage_order, created_at, import_batch_id, company_id, owner_employee_id, managed_by, lost_reason, rd_deal_id, utm_source, utm_campaign, value_cents)
values
  -- testes
  ('aaaaaaaa-0000-4000-8000-000000000001', 'rd_crm', 'Teste Silva', 't1@x.example', '5511911110001', 'expansao', null, 1, '2026-02-01', 'rd-crm-20261006T1840Z', 'c0c0c0c0-0000-4000-8000-000000000001', null, 'rd', null, 'rdT1', null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000002', 'meta_lead_ads', 'Ana', 'ana.TESTE@x.example', '5511911110002', 'formatacao', false, null, '2026-02-02', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'rd_crm', 'João', 'j3@x.example', '5511911110003', 'expansao', false, null, '2026-02-03', 'rd-crm-20261006T1840Z', 'c0c0c0c0-0000-4000-8000-000000000001', null, 'rd', null, 'rdT3', null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000004', 'manual', 'TÉSTE acentuado', null, null, null, null, null, '2026-02-04', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000005', 'rd_crm', 'Carlos', 'c5@x.example', '5511911110005', 'expansao', false, null, now() - interval '1 day', 'rd-crm-20261006T1840Z', null, null, 'rd', null, 'rdT5', null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000006', 'rd_crm', 'Bia', 'b6@x.example', '5511911110006', 'formatacao', false, null, '2026-02-06', 'rd-crm-20261006T1840Z', null, null, 'rd', 'Teste interno', 'rdT6', null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000007', 'manual', 'Teste Ganho', 'g7@x.example', '5511911110007', 'expansao', true, 5, '2026-02-07', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000008', 'manual', 'teste1 avançado', 'a8@x.example', '5511911110008', 'expansao', null, 4, '2026-02-08', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000009', 'manual', 'Teste contrato', 'k9@x.example', '5511911110009', 'formatacao', null, 1, '2026-02-09', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'manual', 'Contestado', 'cont@x.example', '5511911110010', 'expansao', null, 1, '2026-02-10', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-00000000000b', 'rd_crm', 'Lu', 'l11@x.example', '5511911110011', 'formatacao', false, null, '2026-02-11', 'rd-crm-20261006T1840Z', null, null, 'rd', null, 'rdP11', null, null, null),
  ('aaaaaaaa-0000-4000-8000-00000000000c', 'manual', 'Teste', null, '5511944440001', null, null, null, '2026-02-12', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-00000000000d', 'manual', 'Testa Nome', 'n13@x.example', '5511911110013', 'expansao', null, 1, '2026-02-13', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-00000000000e', 'manual', 'Real Doze', null, '5511944440001', 'expansao', null, 1, '2026-02-14', null, null, null, 'wings', null, null, null, null, null),
  -- D1: mesmo telefone, abertas, sem dono; fica a mais antiga (11), que herda e-mail e atribuição
  ('aaaaaaaa-0000-4000-8000-000000000011', 'rd_crm', 'Dup Um', null, '5511922220001', 'expansao', null, 1, '2026-01-01', 'rd-crm-20261006T1840Z', null, null, 'rd', null, 'rdD1a', null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000012', 'meta_lead_ads', 'Dup Um B', 'd1@x.example', '+55 (11) 92222-0001', 'expansao', null, 1, '2026-03-01', null, null, null, 'rd', null, null, 'facebook', 'camp-1', 150000),
  -- D2: mesmo e-mail; fica a aberta com dono (22), que herda a empresa da perdida
  ('aaaaaaaa-0000-4000-8000-000000000021', 'rd_crm', 'Dup Dois', 'DUP2@x.example ', '5511922220002', 'formatacao', false, null, '2025-06-01', null, 'c0c0c0c0-0000-4000-8000-000000000002', null, 'rd', 'Sem interesse', 'rdD2a', null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000022', 'meta_lead_ads', 'Dup Dois B', 'dup2@x.example', null, 'formatacao', null, 2, '2026-03-02', null, null, 'eeeeeeee-0000-4000-8000-000000000001', 'wings', null, null, null, null, null),
  -- D3: cadeia telefone -> e-mail, todas perdidas; fica a mais antiga (31)
  ('aaaaaaaa-0000-4000-8000-000000000031', 'rd_crm', 'Tres A', null, '5511933330001', 'expansao', false, null, '2025-01-01', null, null, null, 'rd', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000032', 'rd_crm', 'Tres B', 'd3@x.example', '5511933330001', 'expansao', false, null, '2025-02-01', null, null, null, 'rd', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000033', 'rd_crm', 'Tres C', 'd3@x.example', '5511933339999', 'expansao', false, null, '2025-03-01', null, null, null, 'rd', null, null, null, null, null),
  -- D4: o mesmo celular com e sem o 9
  ('aaaaaaaa-0000-4000-8000-000000000041', 'rd_crm', 'Quatro A', null, '551187650001', 'formatacao', false, null, '2025-04-01', null, null, null, 'rd', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000042', 'meta_lead_ads', 'Quatro B', null, '5511987650001', 'formatacao', null, 1, '2026-04-01', null, null, null, 'wings', null, null, null, null, null),
  -- D5: ganha e aberta -> conflito, ficam separadas
  ('aaaaaaaa-0000-4000-8000-000000000051', 'manual', 'Cinco A', null, '5511955550001', 'expansao', true, 6, '2025-05-01', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000052', 'manual', 'Cinco B', null, '5511955550001', 'expansao', null, 1, '2026-05-01', null, null, null, 'wings', null, null, null, null, null),
  -- D6: abertas em funis diferentes -> conflito
  ('aaaaaaaa-0000-4000-8000-000000000061', 'manual', 'Seis A', 'd6@x.example', null, 'expansao', null, 1, '2025-06-01', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000062', 'manual', 'Seis B', 'd6@x.example', null, 'formatacao', null, 1, '2026-06-01', null, null, null, 'wings', null, null, null, null, null),
  -- D7: abertas com donos diferentes -> conflito
  ('aaaaaaaa-0000-4000-8000-000000000071', 'manual', 'Sete A', null, '5511977770001', 'expansao', null, 2, '2025-07-01', null, null, 'eeeeeeee-0000-4000-8000-000000000001', 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000072', 'manual', 'Sete B', null, '5511977770001', 'expansao', null, 2, '2026-07-01', null, null, 'eeeeeeee-0000-4000-8000-000000000002', 'wings', null, null, null, null, null),
  -- D8: e-mail de enfeite em 6 leads -> ignorado (limite 5)
  ('aaaaaaaa-0000-4000-8000-000000000081', 'manual', 'Oito 1', 'naotem@x.example', null, 'expansao', false, null, '2025-08-01', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000082', 'manual', 'Oito 2', 'naotem@x.example', null, 'expansao', false, null, '2025-08-02', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000083', 'manual', 'Oito 3', 'naotem@x.example', null, 'expansao', false, null, '2025-08-03', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000084', 'manual', 'Oito 4', 'naotem@x.example', null, 'expansao', false, null, '2025-08-04', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000085', 'manual', 'Oito 5', 'naotem@x.example', null, 'expansao', false, null, '2025-08-05', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000086', 'manual', 'Oito 6', 'naotem@x.example', null, 'expansao', false, null, '2025-08-06', null, null, null, 'wings', null, null, null, null, null),
  -- D9: telefone de um vendedor digitado em dois leads -> ignorado (da casa)
  ('aaaaaaaa-0000-4000-8000-000000000091', 'manual', 'Nove A', null, '5511900000001', 'expansao', false, null, '2025-09-01', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-000000000092', 'manual', 'Nove B', null, '5511900000001', 'expansao', false, null, '2025-09-02', null, null, null, 'wings', null, null, null, null, null),
  -- D10: duas ganhas -> conflito
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'manual', 'Dez A', 'd10@x.example', null, 'expansao', true, 6, '2025-10-01', null, null, null, 'wings', null, null, null, null, null),
  ('aaaaaaaa-0000-4000-8000-0000000000a2', 'manual', 'Dez B', 'd10@x.example', null, 'formatacao', true, 6, '2025-10-02', null, null, null, 'wings', null, null, null, null, null),
  -- D12: abertas sem dono; fica a tocada no Wings System (c2) mesmo em etapa anterior
  ('aaaaaaaa-0000-4000-8000-0000000000c1', 'rd_crm', 'Doze A', 'd12@x.example', null, 'expansao', null, 3, now() - interval '2 days', null, null, null, 'rd', null, 'rdD12a', null, null, null),
  ('aaaaaaaa-0000-4000-8000-0000000000c2', 'meta_lead_ads', 'Doze B', 'd12@x.example', null, 'expansao', null, 1, '2026-01-02', null, null, null, 'wings', null, null, null, null, null);

-- O que o painel do RD marcou como teste.
insert into rd_crm_deals (rd_id, pipeline, stage, stage_order, created_at, is_test)
values ('rdP11', 'formatacao', 'Perdido', 1, '2026-02-11', true), ('rdD1a', 'expansao', 'Novo', 1, '2026-01-01', false);

-- Filhas do teste T1 em todas as tabelas, e do repetido D1b/D2a.
insert into lead_events (lead_id, kind, detail) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'lead.imported.rd_crm', '{}'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'lead.stage_changed', '{}'),
  ('aaaaaaaa-0000-4000-8000-000000000012', 'lead.received.meta_lead_ads', '{}'),
  ('aaaaaaaa-0000-4000-8000-000000000011', 'lead.imported.rd_crm', '{}');
insert into lead_notes (lead_id, body) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'nota do teste'),
  ('aaaaaaaa-0000-4000-8000-000000000012', 'nota do repetido');
insert into lead_tasks (lead_id, title, due_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'tarefa do teste', '2026-10-10'),
  ('aaaaaaaa-0000-4000-8000-000000000012', 'tarefa do repetido', '2026-10-10');
insert into lead_activities (lead_id, kind, at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'call', '2026-10-01'),
  ('aaaaaaaa-0000-4000-8000-000000000033', 'call', '2026-10-01');
insert into lead_stage_history (lead_id, source) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'rd'),
  ('aaaaaaaa-0000-4000-8000-000000000021', 'rd');
insert into crm_notifications (recipient_employee_id, kind, message, lead_id) values
  ('eeeeeeee-0000-4000-8000-000000000001', 'new_lead', 'aviso', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('eeeeeeee-0000-4000-8000-000000000001', 'new_lead', 'aviso', 'aaaaaaaa-0000-4000-8000-000000000012');
insert into crm_automation_runs (id, lead_id, kind, run_at, dedupe_key) values
  ('a0700000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'email', '2026-10-01', 'k1'),
  ('a0700000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000012', 'email', '2026-10-01', 'k2');
insert into crm_email_outbox (lead_id, subject, body, mode, status, run_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'assunto', 'corpo', 'auto', 'sent', 'a0700000-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-000000000012', 'assunto', 'corpo', 'auto', 'sent', 'a0700000-0000-4000-8000-000000000002');
insert into lead_enrichment_ledger (lead_id, step, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'ddd', 'done');
insert into meta_leadgen_events (leadgen_id, lead_id, status) values
  ('lg-t1', 'aaaaaaaa-0000-4000-8000-000000000001', 'done'),
  ('lg-d2a', 'aaaaaaaa-0000-4000-8000-000000000021', 'done');
insert into lead_contacts (lead_id, contact_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-00000000000e', 'cccccccc-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-000000000011', 'cccccccc-0000-4000-8000-000000000003'),
  ('aaaaaaaa-0000-4000-8000-000000000012', 'cccccccc-0000-4000-8000-000000000003');
insert into client_contracts (client_id, position, service, lead_id) values
  ('c11e0000-0000-4000-8000-000000000002', 1, 'formatacao', 'aaaaaaaa-0000-4000-8000-000000000009'),
  ('c11e0000-0000-4000-8000-000000000002', 2, 'formatacao', 'aaaaaaaa-0000-4000-8000-000000000021');

commit;
