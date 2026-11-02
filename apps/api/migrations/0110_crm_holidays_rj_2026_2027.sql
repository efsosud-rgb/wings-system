-- Holidays of 2026 and 2027 that the CRM's working hours skip (Eric, 31/10/2026: national, state
-- of Rio de Janeiro and city of Rio de Janeiro). Pontos facultativos stay out (Carnaval Monday,
-- Ash Wednesday, the federal and municipal decrees' extra days). One row per day (`day` is the
-- key): a day that is a holiday in two spheres keeps the widest one. A day already in the table
-- is left as it is. Sources and doubts: docs/crm/prazos-horas-uteis.md.
INSERT INTO "holidays" ("day", "name", "scope") VALUES
  -- National. Lei 662/1949 art. 1 (wording of Lei 10.607/2002): 1/1, 21/4, 1/5, 7/9, 2/11, 15/11, 25/12.
  -- Lei 6.802/1980: 12/10. Lei 14.759/2023: 20/11 (also RJ Lei 4.007/2002 and Rio Lei 5.146/2010).
  -- Paixão de Cristo: Lei 9.093/1995 art. 2, listed as "feriado nacional" by Portaria MGI 11.460/2025.
  ('2026-01-01', 'Confraternização Universal', 'national'),
  ('2026-04-03', 'Paixão de Cristo', 'national'),
  ('2026-04-21', 'Tiradentes', 'national'),
  ('2026-05-01', 'Dia do Trabalho', 'national'),
  ('2026-09-07', 'Independência do Brasil', 'national'),
  ('2026-10-12', 'Nossa Senhora Aparecida', 'national'),
  ('2026-11-02', 'Finados', 'national'),
  ('2026-11-15', 'Proclamação da República', 'national'),
  ('2026-11-20', 'Dia Nacional de Zumbi e da Consciência Negra', 'national'),
  ('2026-12-25', 'Natal', 'national'),
  ('2027-01-01', 'Confraternização Universal', 'national'),
  ('2027-03-26', 'Paixão de Cristo', 'national'),
  ('2027-04-21', 'Tiradentes', 'national'),
  ('2027-05-01', 'Dia do Trabalho', 'national'),
  ('2027-09-07', 'Independência do Brasil', 'national'),
  ('2027-10-12', 'Nossa Senhora Aparecida', 'national'),
  ('2027-11-02', 'Finados', 'national'),
  ('2027-11-15', 'Proclamação da República', 'national'),
  ('2027-11-20', 'Dia Nacional de Zumbi e da Consciência Negra', 'national'),
  ('2027-12-25', 'Natal', 'national'),
  -- State of Rio de Janeiro. Lei estadual 5.243/2008: Carnaval Tuesday. Lei estadual 5.198/2008:
  -- 23/04. Lei estadual 11.002/2025: Corpus Christi (60 days after Easter).
  ('2026-02-17', 'Carnaval (terça-feira)', 'state'),
  ('2026-04-23', 'Dia de São Jorge', 'state'),
  ('2026-06-04', 'Corpus Christi', 'state'),
  ('2027-02-09', 'Carnaval (terça-feira)', 'state'),
  ('2027-04-23', 'Dia de São Jorge', 'state'),
  ('2027-05-27', 'Corpus Christi', 'state'),
  -- City of Rio de Janeiro. Lei municipal 5.146/2010 art. 8 I: 20/01.
  ('2026-01-20', 'Dia de São Sebastião', 'city'),
  ('2027-01-20', 'Dia de São Sebastião', 'city')
ON CONFLICT ("day") DO NOTHING;
