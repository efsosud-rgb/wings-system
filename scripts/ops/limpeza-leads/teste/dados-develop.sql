-- Só no esquema do develop/staging (lead_files 0071/0072, crm_meetings 0073): filhas que a
-- produção em 0501fcf ainda não tem. Roda depois de dados.sql.
\set ON_ERROR_STOP on
begin;
insert into drive_folders (id, name, path, department)
values ('df000000-0000-4000-8000-000000000001', 'Leads', '/Leads', 'comercial');
insert into drive_files (id, folder_id, name, mime_type, byte_size, storage_key, owner_id) values
  ('dfa00000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000001', 'a.pdf', 'application/pdf', 1, 'k/a', 'eeeeeeee-0000-4000-8000-000000000001'),
  ('dfa00000-0000-4000-8000-000000000002', 'df000000-0000-4000-8000-000000000001', 'b.pdf', 'application/pdf', 1, 'k/b', 'eeeeeeee-0000-4000-8000-000000000001');
-- O mesmo arquivo no teste e nos dois repetidos de D1 (o vínculo repetido some na junção).
insert into lead_files (lead_id, drive_file_id) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'dfa00000-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-000000000011', 'dfa00000-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-000000000012', 'dfa00000-0000-4000-8000-000000000001'),
  ('aaaaaaaa-0000-4000-8000-000000000012', 'dfa00000-0000-4000-8000-000000000002');
insert into crm_meetings (id, lead_id, owner_employee_id, title, starts_at, ends_at) values
  ('3ee70000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001', 'reunião do teste', '2026-10-01 10:00', '2026-10-01 11:00'),
  ('3ee70000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000012', 'eeeeeeee-0000-4000-8000-000000000001', 'reunião do repetido', '2026-10-01 10:00', '2026-10-01 11:00');
insert into crm_meeting_analysis_runs (meeting_id, reserved_micro_usd) values
  ('3ee70000-0000-4000-8000-000000000001', 0),
  ('3ee70000-0000-4000-8000-000000000002', 0);
commit;
