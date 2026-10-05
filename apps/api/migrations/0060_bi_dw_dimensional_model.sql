-- BI dimensional model (schema dw), copied unchanged from docs/bi/ddl.sql. Nothing outside the dw schema is touched.
-- Modelo dimensional de vendas e marketing do Wings System
-- Gerado a partir de model.js. PostgreSQL 15+. Schema: dw
-- Regras: nada de dado inventado (nulo = a fonte não informou); sem dados pessoais;
-- tenant em toda tabela de fato, com isolamento por RLS; chave 0 = "sem informação".

CREATE SCHEMA IF NOT EXISTS dw;

-- ===================== DIMENSÕES =====================
CREATE TABLE dw.dim_data (
  data_sk integer PRIMARY KEY,
  data date,
  dia smallint,
  dia_semana smallint,
  nome_dia text,
  semana_iso smallint,
  mes smallint,
  nome_mes text,
  trimestre smallint,
  ano smallint,
  fim_de_semana boolean,
  feriado_nacional boolean
);
COMMENT ON TABLE dw.dim_data IS 'Calendário, um registro por dia. data_sk no formato AAAAMMDD; 0 = sem data.';
COMMENT ON COLUMN dw.dim_data.data_sk IS 'chave AAAAMMDD; 0 = sem data ou ainda não aconteceu';
COMMENT ON COLUMN dw.dim_data.data IS 'a data';
COMMENT ON COLUMN dw.dim_data.dia IS 'dia do mês';
COMMENT ON COLUMN dw.dim_data.dia_semana IS '1 = segunda … 7 = domingo (ISO)';
COMMENT ON COLUMN dw.dim_data.nome_dia IS 'nome do dia da semana';
COMMENT ON COLUMN dw.dim_data.semana_iso IS 'semana ISO do ano';
COMMENT ON COLUMN dw.dim_data.mes IS 'mês (1–12)';
COMMENT ON COLUMN dw.dim_data.nome_mes IS 'nome do mês';
COMMENT ON COLUMN dw.dim_data.trimestre IS 'trimestre (1–4)';
COMMENT ON COLUMN dw.dim_data.ano IS 'ano';
COMMENT ON COLUMN dw.dim_data.fim_de_semana IS 'sábado ou domingo';
COMMENT ON COLUMN dw.dim_data.feriado_nacional IS 'preenchido a partir de fonte oficial; nulo até lá';

CREATE TABLE dw.dim_tenant (
  tenant_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL UNIQUE,
  nome text NOT NULL,
  tipo text NOT NULL,
  ativo boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE dw.dim_tenant IS 'Cliente do sistema multi-tenant (a Wings ou cada franqueadora). Toda tabela de fato carrega o tenant.';
COMMENT ON COLUMN dw.dim_tenant.tenant_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_tenant.tenant_id IS 'id do tenant no Wings System';
COMMENT ON COLUMN dw.dim_tenant.nome IS 'nome do tenant';
COMMENT ON COLUMN dw.dim_tenant.tipo IS 'wings ou franqueadora';
COMMENT ON COLUMN dw.dim_tenant.ativo IS 'tenant ativo';

CREATE TABLE dw.dim_marca (
  marca_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  marca_id text NOT NULL,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  nome text NOT NULL,
  segmento text,
  status_comercial text,
  uf_sede char(2),
  cidade_sede text,
  valido_de date NOT NULL,
  valido_ate date NOT NULL DEFAULT '9999-12-31',
  atual boolean NOT NULL DEFAULT true,
  UNIQUE (marca_id, valido_de)
);
COMMENT ON TABLE dw.dim_marca IS 'Marca franqueadora trabalhada pela Wings (formatação ou expansão).';
COMMENT ON COLUMN dw.dim_marca.marca_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_marca.marca_id IS 'id da marca no CRM';
COMMENT ON COLUMN dw.dim_marca.tenant_sk IS 'tenant dono da marca';
COMMENT ON COLUMN dw.dim_marca.nome IS 'nome da marca';
COMMENT ON COLUMN dw.dim_marca.segmento IS 'segmento de mercado';
COMMENT ON COLUMN dw.dim_marca.status_comercial IS 'situação comercial (ex.: em formatação, à venda)';
COMMENT ON COLUMN dw.dim_marca.uf_sede IS 'UF da sede';
COMMENT ON COLUMN dw.dim_marca.cidade_sede IS 'cidade da sede';
COMMENT ON COLUMN dw.dim_marca.valido_de IS 'início da validade desta versão';
COMMENT ON COLUMN dw.dim_marca.valido_ate IS 'fim da validade (9999-12-31 = versão atual)';
COMMENT ON COLUMN dw.dim_marca.atual IS 'true na versão vigente';

CREATE TABLE dw.dim_canal (
  canal_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canal_codigo text NOT NULL UNIQUE,
  canal_nome text NOT NULL,
  tipo text NOT NULL
);
COMMENT ON TABLE dw.dim_canal IS 'Canal de aquisição: plataformas de mídia paga, orgânico, indicação, WhatsApp, direto.';
COMMENT ON COLUMN dw.dim_canal.canal_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_canal.canal_codigo IS 'código estável do canal';
COMMENT ON COLUMN dw.dim_canal.canal_nome IS 'nome exibido';
COMMENT ON COLUMN dw.dim_canal.tipo IS 'pago, orgânico ou direto';

CREATE TABLE dw.dim_campanha (
  campanha_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plataforma text NOT NULL,
  conta_id text NOT NULL,
  campanha_id text NOT NULL,
  campanha_nome text,
  objetivo text,
  conjunto_id text,
  conjunto_nome text,
  anuncio_id text NOT NULL,
  anuncio_nome text,
  formato text,
  valido_de date NOT NULL,
  valido_ate date NOT NULL DEFAULT '9999-12-31',
  atual boolean NOT NULL DEFAULT true,
  UNIQUE (plataforma, anuncio_id, valido_de)
);
COMMENT ON TABLE dw.dim_campanha IS 'Hierarquia de mídia paga achatada até o anúncio: conta → campanha → conjunto → anúncio.';
COMMENT ON COLUMN dw.dim_campanha.campanha_sk IS 'chave substituta (versão do anúncio)';
COMMENT ON COLUMN dw.dim_campanha.plataforma IS 'meta, google, tiktok ou linkedin';
COMMENT ON COLUMN dw.dim_campanha.conta_id IS 'conta de anúncio';
COMMENT ON COLUMN dw.dim_campanha.campanha_id IS 'id da campanha na plataforma';
COMMENT ON COLUMN dw.dim_campanha.campanha_nome IS 'nome da campanha';
COMMENT ON COLUMN dw.dim_campanha.objetivo IS 'objetivo da campanha (ex.: leads)';
COMMENT ON COLUMN dw.dim_campanha.conjunto_id IS 'conjunto ou grupo de anúncios';
COMMENT ON COLUMN dw.dim_campanha.conjunto_nome IS 'nome do conjunto';
COMMENT ON COLUMN dw.dim_campanha.anuncio_id IS 'id do anúncio';
COMMENT ON COLUMN dw.dim_campanha.anuncio_nome IS 'nome do anúncio';
COMMENT ON COLUMN dw.dim_campanha.formato IS 'imagem, vídeo, carrossel ou formulário instantâneo';
COMMENT ON COLUMN dw.dim_campanha.valido_de IS 'início da validade desta versão';
COMMENT ON COLUMN dw.dim_campanha.valido_ate IS 'fim da validade (9999-12-31 = versão atual)';
COMMENT ON COLUMN dw.dim_campanha.atual IS 'true na versão vigente';

CREATE TABLE dw.dim_origem (
  origem_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origem_chave text NOT NULL UNIQUE,
  tipo_origem text NOT NULL,
  identificador_conversao text,
  pagina_url text,
  formulario text,
  utm_source text,
  utm_medium text,
  utm_campaign text
);
COMMENT ON TABLE dw.dim_origem IS 'Onde o lead converteu: landing page, formulário instantâneo, site, quiz ou WhatsApp, com identificador de conversão e UTMs.';
COMMENT ON COLUMN dw.dim_origem.origem_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_origem.origem_chave IS 'hash dos campos que definem a origem (gerado na carga)';
COMMENT ON COLUMN dw.dim_origem.tipo_origem IS 'landing page, formulário instantâneo, site, quiz ou WhatsApp';
COMMENT ON COLUMN dw.dim_origem.identificador_conversao IS 'identificador de conversão do RD Station';
COMMENT ON COLUMN dw.dim_origem.pagina_url IS 'URL da página, quando houver';
COMMENT ON COLUMN dw.dim_origem.formulario IS 'nome do formulário';
COMMENT ON COLUMN dw.dim_origem.utm_source IS 'utm_source';
COMMENT ON COLUMN dw.dim_origem.utm_medium IS 'utm_medium';
COMMENT ON COLUMN dw.dim_origem.utm_campaign IS 'utm_campaign';

CREATE TABLE dw.dim_lead (
  lead_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id text NOT NULL UNIQUE,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  uf char(2),
  cidade text,
  primeiro_contato_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_data,
  primeiro_canal_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_canal
);
COMMENT ON TABLE dw.dim_lead IS 'Contato sem dados pessoais: nome, telefone, e-mail e CPF ficam só no CRM.';
COMMENT ON COLUMN dw.dim_lead.lead_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_lead.lead_id IS 'id do contato no CRM';
COMMENT ON COLUMN dw.dim_lead.tenant_sk IS 'tenant do contato';
COMMENT ON COLUMN dw.dim_lead.uf IS 'UF informada';
COMMENT ON COLUMN dw.dim_lead.cidade IS 'cidade informada';
COMMENT ON COLUMN dw.dim_lead.primeiro_contato_sk IS 'data do primeiro contato';
COMMENT ON COLUMN dw.dim_lead.primeiro_canal_sk IS 'canal do primeiro contato';

CREATE TABLE dw.dim_usuario (
  usuario_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id text NOT NULL,
  nome text NOT NULL,
  equipe text,
  papel text,
  ativo boolean NOT NULL DEFAULT true,
  valido_de date NOT NULL,
  valido_ate date NOT NULL DEFAULT '9999-12-31',
  atual boolean NOT NULL DEFAULT true,
  UNIQUE (usuario_id, valido_de)
);
COMMENT ON TABLE dw.dim_usuario IS 'Usuário do sistema. Usada em vários papéis: vendedor na negociação, aprovador na verba.';
COMMENT ON COLUMN dw.dim_usuario.usuario_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_usuario.usuario_id IS 'id do usuário no Wings System';
COMMENT ON COLUMN dw.dim_usuario.nome IS 'nome do usuário';
COMMENT ON COLUMN dw.dim_usuario.equipe IS 'equipe (ex.: Expansão, Diretoria)';
COMMENT ON COLUMN dw.dim_usuario.papel IS 'nível de acesso no RBAC';
COMMENT ON COLUMN dw.dim_usuario.ativo IS 'usuário ativo';
COMMENT ON COLUMN dw.dim_usuario.valido_de IS 'início da validade desta versão';
COMMENT ON COLUMN dw.dim_usuario.valido_ate IS 'fim da validade (9999-12-31 = versão atual)';
COMMENT ON COLUMN dw.dim_usuario.atual IS 'true na versão vigente';

CREATE TABLE dw.dim_etapa (
  etapa_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  funil text NOT NULL,
  etapa_codigo text NOT NULL,
  etapa_nome text NOT NULL,
  ordem smallint NOT NULL,
  tipo text NOT NULL,
  UNIQUE (funil, etapa_codigo)
);
COMMENT ON TABLE dw.dim_etapa IS 'Etapas dos funis do CRM, carregadas do próprio CRM, com a ordem e o tipo de cada uma.';
COMMENT ON COLUMN dw.dim_etapa.etapa_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_etapa.funil IS 'nome do funil (ex.: Expansão)';
COMMENT ON COLUMN dw.dim_etapa.etapa_codigo IS 'código da etapa no CRM';
COMMENT ON COLUMN dw.dim_etapa.etapa_nome IS 'nome da etapa';
COMMENT ON COLUMN dw.dim_etapa.ordem IS 'posição no funil';
COMMENT ON COLUMN dw.dim_etapa.tipo IS 'aberta, ganha ou perdida';

CREATE TABLE dw.dim_motivo_perda (
  motivo_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  motivo_codigo text NOT NULL UNIQUE,
  motivo_nome text NOT NULL,
  categoria text
);
COMMENT ON TABLE dw.dim_motivo_perda IS 'Motivos de perda cadastrados no CRM.';
COMMENT ON COLUMN dw.dim_motivo_perda.motivo_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_motivo_perda.motivo_codigo IS 'código do motivo';
COMMENT ON COLUMN dw.dim_motivo_perda.motivo_nome IS 'motivo';
COMMENT ON COLUMN dw.dim_motivo_perda.categoria IS 'agrupamento do motivo';

CREATE TABLE dw.dim_faixa_quiz (
  faixa_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  faixa_codigo text NOT NULL UNIQUE,
  faixa_nome text NOT NULL,
  nota_min smallint,
  nota_max smallint,
  ordem smallint
);
COMMENT ON TABLE dw.dim_faixa_quiz IS 'Faixas de resultado do Quiz de Franqueabilidade, carregadas da configuração do quiz.';
COMMENT ON COLUMN dw.dim_faixa_quiz.faixa_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_faixa_quiz.faixa_codigo IS 'código da faixa';
COMMENT ON COLUMN dw.dim_faixa_quiz.faixa_nome IS 'nome exibido';
COMMENT ON COLUMN dw.dim_faixa_quiz.nota_min IS 'nota mínima da faixa';
COMMENT ON COLUMN dw.dim_faixa_quiz.nota_max IS 'nota máxima da faixa';
COMMENT ON COLUMN dw.dim_faixa_quiz.ordem IS 'ordem de exibição';

-- Membro "sem informação" (chave 0) de cada dimensão
INSERT INTO dw.dim_data (data_sk) VALUES (0);
INSERT INTO dw.dim_tenant (tenant_sk, tenant_id, nome, tipo) OVERRIDING SYSTEM VALUE VALUES (0, '—', 'Sem informação', '—');
INSERT INTO dw.dim_marca (marca_sk, marca_id, tenant_sk, nome, valido_de) OVERRIDING SYSTEM VALUE VALUES (0, '—', 0, 'Sem informação', '1900-01-01');
INSERT INTO dw.dim_canal (canal_sk, canal_codigo, canal_nome, tipo) OVERRIDING SYSTEM VALUE VALUES (0, '—', 'Sem informação', '—');
INSERT INTO dw.dim_campanha (campanha_sk, plataforma, conta_id, campanha_id, anuncio_id, valido_de) OVERRIDING SYSTEM VALUE VALUES (0, '—', '—', '—', '—', '1900-01-01');
INSERT INTO dw.dim_origem (origem_sk, origem_chave, tipo_origem) OVERRIDING SYSTEM VALUE VALUES (0, '—', '—');
INSERT INTO dw.dim_lead (lead_sk, lead_id, tenant_sk) OVERRIDING SYSTEM VALUE VALUES (0, '—', 0);
INSERT INTO dw.dim_usuario (usuario_sk, usuario_id, nome, valido_de) OVERRIDING SYSTEM VALUE VALUES (0, '—', 'Sem informação', '1900-01-01');
INSERT INTO dw.dim_etapa (etapa_sk, funil, etapa_codigo, etapa_nome, ordem, tipo) OVERRIDING SYSTEM VALUE VALUES (0, '—', '—', 'Sem informação', 0, '—');
INSERT INTO dw.dim_motivo_perda (motivo_sk, motivo_codigo, motivo_nome) OVERRIDING SYSTEM VALUE VALUES (0, '—', 'Sem informação');
INSERT INTO dw.dim_faixa_quiz (faixa_sk, faixa_codigo, faixa_nome) OVERRIDING SYSTEM VALUE VALUES (0, '—', 'Sem informação');

-- Calendário de 2024 a 2030 (feriados ficam nulos até virem de fonte oficial)
INSERT INTO dw.dim_data (data_sk, data, dia, dia_semana, nome_dia, semana_iso, mes, nome_mes, trimestre, ano, fim_de_semana, feriado_nacional)
SELECT to_char(g.d, 'YYYYMMDD')::int,
       g.d::date,
       extract(day FROM g.d)::smallint,
       extract(isodow FROM g.d)::smallint,
       (ARRAY['segunda','terça','quarta','quinta','sexta','sábado','domingo'])[extract(isodow FROM g.d)::int],
       extract(week FROM g.d)::smallint,
       extract(month FROM g.d)::smallint,
       (ARRAY['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'])[extract(month FROM g.d)::int],
       extract(quarter FROM g.d)::smallint,
       extract(year FROM g.d)::smallint,
       extract(isodow FROM g.d) IN (6, 7),
       NULL
FROM generate_series('2024-01-01'::date, '2030-12-31'::date, interval '1 day') AS g(d);

-- Canais padrão (categorias, não dados de negócio)
INSERT INTO dw.dim_canal (canal_codigo, canal_nome, tipo) VALUES
  ('meta_ads', 'Meta Ads', 'pago'),
  ('google_ads', 'Google Ads', 'pago'),
  ('tiktok_ads', 'TikTok Ads', 'pago'),
  ('linkedin_ads', 'LinkedIn Ads', 'pago'),
  ('organico', 'Orgânico', 'orgânico'),
  ('indicacao', 'Indicação', 'orgânico'),
  ('whatsapp', 'WhatsApp', 'direto'),
  ('direto', 'Direto', 'direto')
ON CONFLICT (canal_codigo) DO NOTHING;

-- ===================== FATOS =====================
CREATE TABLE dw.fato_midia_diaria (
  data_sk integer NOT NULL REFERENCES dw.dim_data,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  canal_sk integer NOT NULL REFERENCES dw.dim_canal,
  campanha_sk integer NOT NULL REFERENCES dw.dim_campanha,
  marca_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_marca,
  investimento numeric(14,2),
  impressoes bigint,
  cliques bigint,
  leads_plataforma integer,
  conversoes_plataforma integer,
  moeda char(3) NOT NULL DEFAULT 'BRL',
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (data_sk, campanha_sk)
);
COMMENT ON TABLE dw.fato_midia_diaria IS 'Mídia paga diária. Grão: Uma linha por anúncio por dia. Fontes: Meta Marketing API, Google Ads API (TikTok e LinkedIn quando ligados).';
COMMENT ON COLUMN dw.fato_midia_diaria.data_sk IS 'dia';
COMMENT ON COLUMN dw.fato_midia_diaria.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.fato_midia_diaria.canal_sk IS 'plataforma como canal';
COMMENT ON COLUMN dw.fato_midia_diaria.campanha_sk IS 'anúncio (versão vigente no dia)';
COMMENT ON COLUMN dw.fato_midia_diaria.marca_sk IS 'marca anunciada; 0 = institucional';
COMMENT ON COLUMN dw.fato_midia_diaria.investimento IS 'valor investido no dia (aditiva); nulo = a fonte não informou';
COMMENT ON COLUMN dw.fato_midia_diaria.impressoes IS 'impressões (aditiva)';
COMMENT ON COLUMN dw.fato_midia_diaria.cliques IS 'cliques (aditiva)';
COMMENT ON COLUMN dw.fato_midia_diaria.leads_plataforma IS 'leads contados pela plataforma (aditiva)';
COMMENT ON COLUMN dw.fato_midia_diaria.conversoes_plataforma IS 'conversões contadas pela plataforma (aditiva)';
COMMENT ON COLUMN dw.fato_midia_diaria.moeda IS 'moeda do investimento';
COMMENT ON COLUMN dw.fato_midia_diaria.fonte IS 'sistema de origem (API ou módulo do Wings System)';
COMMENT ON COLUMN dw.fato_midia_diaria.carregado_em IS 'quando a linha foi carregada';

CREATE TABLE dw.fato_conversao (
  conversao_id text PRIMARY KEY,
  data_sk integer NOT NULL REFERENCES dw.dim_data,
  hora smallint CHECK (hora BETWEEN 0 AND 23),
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  lead_sk integer NOT NULL REFERENCES dw.dim_lead,
  marca_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_marca,
  canal_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_canal,
  campanha_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_campanha,
  origem_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_origem,
  primeira_conversao boolean NOT NULL,
  quantidade smallint NOT NULL DEFAULT 1,
  evento_em timestamptz NOT NULL,
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE dw.fato_conversao IS 'Conversão de lead. Grão: Uma linha por conversão registrada (formulário, landing page, quiz ou WhatsApp). Fontes: RD Station Marketing, Meta Lead Ads, formulários do TikTok, site e quiz.';
COMMENT ON COLUMN dw.fato_conversao.conversao_id IS 'id do evento na fonte (dimensão degenerada)';
COMMENT ON COLUMN dw.fato_conversao.data_sk IS 'dia da conversão';
COMMENT ON COLUMN dw.fato_conversao.hora IS 'hora da conversão';
COMMENT ON COLUMN dw.fato_conversao.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.fato_conversao.lead_sk IS 'contato';
COMMENT ON COLUMN dw.fato_conversao.marca_sk IS 'marca de interesse; 0 = não informada';
COMMENT ON COLUMN dw.fato_conversao.canal_sk IS 'canal';
COMMENT ON COLUMN dw.fato_conversao.campanha_sk IS 'anúncio; 0 = sem anúncio';
COMMENT ON COLUMN dw.fato_conversao.origem_sk IS 'onde converteu';
COMMENT ON COLUMN dw.fato_conversao.primeira_conversao IS 'primeira conversão do contato';
COMMENT ON COLUMN dw.fato_conversao.quantidade IS 'sempre 1, para somar contagens';
COMMENT ON COLUMN dw.fato_conversao.evento_em IS 'momento exato do evento';
COMMENT ON COLUMN dw.fato_conversao.fonte IS 'sistema de origem (API ou módulo do Wings System)';
COMMENT ON COLUMN dw.fato_conversao.carregado_em IS 'quando a linha foi carregada';

CREATE TABLE dw.fato_negociacao (
  negociacao_id text PRIMARY KEY,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  lead_sk integer NOT NULL REFERENCES dw.dim_lead,
  marca_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_marca,
  vendedor_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_usuario,
  canal_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_canal,
  origem_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_origem,
  etapa_atual_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_etapa,
  motivo_perda_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_motivo_perda,
  criada_sk integer NOT NULL REFERENCES dw.dim_data,
  qualificada_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_data,
  reuniao_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_data,
  proposta_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_data,
  cof_enviada_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_data,
  ganha_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_data,
  perdida_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_data,
  valor_estimado numeric(14,2),
  valor_fechado numeric(14,2),
  dias_ate_qualificar integer,
  dias_ate_fechar integer,
  atualizado_em timestamptz NOT NULL,
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE dw.fato_negociacao IS 'Negociação. Grão: Uma linha por negociação, atualizada a cada marco do funil. Fontes: CRM do Wings System (e RD Station CRM até a migração).';
COMMENT ON COLUMN dw.fato_negociacao.negociacao_id IS 'id da negociação (dimensão degenerada)';
COMMENT ON COLUMN dw.fato_negociacao.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.fato_negociacao.lead_sk IS 'contato';
COMMENT ON COLUMN dw.fato_negociacao.marca_sk IS 'marca negociada';
COMMENT ON COLUMN dw.fato_negociacao.vendedor_sk IS 'vendedor responsável (papel de dim_usuario)';
COMMENT ON COLUMN dw.fato_negociacao.canal_sk IS 'canal de origem';
COMMENT ON COLUMN dw.fato_negociacao.origem_sk IS 'origem da primeira conversão';
COMMENT ON COLUMN dw.fato_negociacao.etapa_atual_sk IS 'etapa atual';
COMMENT ON COLUMN dw.fato_negociacao.motivo_perda_sk IS 'motivo, se perdida';
COMMENT ON COLUMN dw.fato_negociacao.criada_sk IS 'marco: criada';
COMMENT ON COLUMN dw.fato_negociacao.qualificada_sk IS 'marco: qualificada (0 = ainda não)';
COMMENT ON COLUMN dw.fato_negociacao.reuniao_sk IS 'marco: primeira reunião';
COMMENT ON COLUMN dw.fato_negociacao.proposta_sk IS 'marco: proposta enviada';
COMMENT ON COLUMN dw.fato_negociacao.cof_enviada_sk IS 'marco: Circular de Oferta de Franquia enviada';
COMMENT ON COLUMN dw.fato_negociacao.ganha_sk IS 'marco: ganha';
COMMENT ON COLUMN dw.fato_negociacao.perdida_sk IS 'marco: perdida';
COMMENT ON COLUMN dw.fato_negociacao.valor_estimado IS 'valor estimado; nulo = não informado';
COMMENT ON COLUMN dw.fato_negociacao.valor_fechado IS 'valor fechado, quando ganha';
COMMENT ON COLUMN dw.fato_negociacao.dias_ate_qualificar IS 'dias entre criada e qualificada';
COMMENT ON COLUMN dw.fato_negociacao.dias_ate_fechar IS 'dias entre criada e ganha ou perdida';
COMMENT ON COLUMN dw.fato_negociacao.atualizado_em IS 'última atualização na fonte';
COMMENT ON COLUMN dw.fato_negociacao.fonte IS 'sistema de origem (API ou módulo do Wings System)';
COMMENT ON COLUMN dw.fato_negociacao.carregado_em IS 'quando a linha foi carregada';

CREATE TABLE dw.fato_funil_diario (
  data_sk integer NOT NULL REFERENCES dw.dim_data,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  marca_sk integer NOT NULL REFERENCES dw.dim_marca,
  etapa_sk integer NOT NULL REFERENCES dw.dim_etapa,
  vendedor_sk integer NOT NULL REFERENCES dw.dim_usuario,
  negociacoes_abertas integer NOT NULL,
  valor_em_aberto numeric(14,2),
  entradas integer NOT NULL,
  saidas integer NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (data_sk, marca_sk, etapa_sk, vendedor_sk)
);
COMMENT ON TABLE dw.fato_funil_diario IS 'Funil diário. Grão: Uma linha por dia, marca, etapa e vendedor. Fontes: calculado a partir do CRM.';
COMMENT ON COLUMN dw.fato_funil_diario.data_sk IS 'dia da fotografia';
COMMENT ON COLUMN dw.fato_funil_diario.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.fato_funil_diario.marca_sk IS 'marca';
COMMENT ON COLUMN dw.fato_funil_diario.etapa_sk IS 'etapa';
COMMENT ON COLUMN dw.fato_funil_diario.vendedor_sk IS 'vendedor';
COMMENT ON COLUMN dw.fato_funil_diario.negociacoes_abertas IS 'em aberto no fim do dia (semiaditiva: não somar entre dias)';
COMMENT ON COLUMN dw.fato_funil_diario.valor_em_aberto IS 'valor em aberto no fim do dia (semiaditiva)';
COMMENT ON COLUMN dw.fato_funil_diario.entradas IS 'entraram na etapa no dia (aditiva)';
COMMENT ON COLUMN dw.fato_funil_diario.saidas IS 'saíram da etapa no dia (aditiva)';
COMMENT ON COLUMN dw.fato_funil_diario.carregado_em IS 'quando a linha foi carregada';

CREATE TABLE dw.fato_aprovacao_verba (
  pedido_id text PRIMARY KEY,
  data_pedido_sk integer NOT NULL REFERENCES dw.dim_data,
  data_decisao_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_data,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  canal_sk integer NOT NULL REFERENCES dw.dim_canal,
  campanha_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_campanha,
  aprovador_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_usuario,
  decisao text NOT NULL CHECK (decisao IN ('pendente','aprovado','recusado','expirado')),
  escalonado boolean NOT NULL DEFAULT false,
  verba_atual numeric(14,2) NOT NULL,
  verba_proposta numeric(14,2) NOT NULL,
  variacao numeric(14,2) GENERATED ALWAYS AS (verba_proposta - verba_atual) STORED,
  minutos_ate_decisao integer,
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE dw.fato_aprovacao_verba IS 'Aprovação de verba. Grão: Uma linha por pedido de mudança de verba feito pelo agente de tráfego. Fontes: livro-razão e gate de aprovação do Agente de Tráfego Pago.';
COMMENT ON COLUMN dw.fato_aprovacao_verba.pedido_id IS 'id do pedido (dimensão degenerada)';
COMMENT ON COLUMN dw.fato_aprovacao_verba.data_pedido_sk IS 'dia do pedido';
COMMENT ON COLUMN dw.fato_aprovacao_verba.data_decisao_sk IS 'dia da decisão (0 = pendente)';
COMMENT ON COLUMN dw.fato_aprovacao_verba.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.fato_aprovacao_verba.canal_sk IS 'plataforma';
COMMENT ON COLUMN dw.fato_aprovacao_verba.campanha_sk IS 'campanha afetada';
COMMENT ON COLUMN dw.fato_aprovacao_verba.aprovador_sk IS 'quem decidiu (papel de dim_usuario)';
COMMENT ON COLUMN dw.fato_aprovacao_verba.decisao IS 'resultado do pedido';
COMMENT ON COLUMN dw.fato_aprovacao_verba.escalonado IS 'se o pedido foi escalonado';
COMMENT ON COLUMN dw.fato_aprovacao_verba.verba_atual IS 'verba antes do pedido';
COMMENT ON COLUMN dw.fato_aprovacao_verba.verba_proposta IS 'verba pedida pelo agente';
COMMENT ON COLUMN dw.fato_aprovacao_verba.variacao IS 'diferença pedida';
COMMENT ON COLUMN dw.fato_aprovacao_verba.minutos_ate_decisao IS 'minutos entre pedido e decisão';
COMMENT ON COLUMN dw.fato_aprovacao_verba.fonte IS 'sistema de origem (API ou módulo do Wings System)';
COMMENT ON COLUMN dw.fato_aprovacao_verba.carregado_em IS 'quando a linha foi carregada';

CREATE TABLE dw.fato_diagnostico_quiz (
  diagnostico_id text PRIMARY KEY,
  data_sk integer NOT NULL REFERENCES dw.dim_data,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  lead_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_lead,
  canal_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_canal,
  origem_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_origem,
  faixa_sk integer NOT NULL REFERENCES dw.dim_faixa_quiz,
  nota smallint NOT NULL CHECK (nota BETWEEN 0 AND 100),
  pontos_provado smallint,
  pontos_financeiro smallint,
  pontos_replicar smallint,
  pontos_marca_mercado smallint,
  pontos_estrutura smallint,
  travas_ativas smallint NOT NULL DEFAULT 0,
  cadastro_concluido boolean NOT NULL,
  concluido_em timestamptz NOT NULL,
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE dw.fato_diagnostico_quiz IS 'Diagnóstico do quiz. Grão: Uma linha por quiz concluído. Fontes: Quiz de Franqueabilidade (site).';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.diagnostico_id IS 'id do diagnóstico (dimensão degenerada)';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.data_sk IS 'dia';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.lead_sk IS 'contato; 0 = anônimo até o cadastro';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.canal_sk IS 'canal';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.origem_sk IS 'origem';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.faixa_sk IS 'faixa do resultado';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.nota IS 'nota final de 0 a 100 (não somar; usar média)';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.pontos_provado IS 'pontos na dimensão negócio provado';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.pontos_financeiro IS 'pontos na dimensão financeiro';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.pontos_replicar IS 'pontos na dimensão capacidade de replicar';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.pontos_marca_mercado IS 'pontos na dimensão marca e mercado';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.pontos_estrutura IS 'pontos na dimensão estrutura';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.travas_ativas IS 'travas que limitaram a faixa';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.cadastro_concluido IS 'se o lead preencheu o cadastro';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.concluido_em IS 'momento da conclusão';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.fonte IS 'sistema de origem (API ou módulo do Wings System)';
COMMENT ON COLUMN dw.fato_diagnostico_quiz.carregado_em IS 'quando a linha foi carregada';

-- Índices nas chaves usadas em filtros e junções
CREATE INDEX ON dw.fato_midia_diaria (tenant_sk, data_sk);
CREATE INDEX ON dw.fato_midia_diaria (canal_sk);
CREATE INDEX ON dw.fato_midia_diaria (campanha_sk);
CREATE INDEX ON dw.fato_midia_diaria (marca_sk);
CREATE INDEX ON dw.fato_conversao (tenant_sk, data_sk);
CREATE INDEX ON dw.fato_conversao (lead_sk);
CREATE INDEX ON dw.fato_conversao (marca_sk);
CREATE INDEX ON dw.fato_conversao (canal_sk);
CREATE INDEX ON dw.fato_conversao (campanha_sk);
CREATE INDEX ON dw.fato_conversao (origem_sk);
CREATE INDEX ON dw.fato_negociacao (tenant_sk, criada_sk);
CREATE INDEX ON dw.fato_negociacao (lead_sk);
CREATE INDEX ON dw.fato_negociacao (marca_sk);
CREATE INDEX ON dw.fato_negociacao (vendedor_sk);
CREATE INDEX ON dw.fato_negociacao (canal_sk);
CREATE INDEX ON dw.fato_negociacao (origem_sk);
CREATE INDEX ON dw.fato_negociacao (etapa_atual_sk);
CREATE INDEX ON dw.fato_negociacao (motivo_perda_sk);
CREATE INDEX ON dw.fato_funil_diario (tenant_sk, data_sk);
CREATE INDEX ON dw.fato_funil_diario (marca_sk);
CREATE INDEX ON dw.fato_funil_diario (etapa_sk);
CREATE INDEX ON dw.fato_funil_diario (vendedor_sk);
CREATE INDEX ON dw.fato_aprovacao_verba (tenant_sk, data_pedido_sk);
CREATE INDEX ON dw.fato_aprovacao_verba (canal_sk);
CREATE INDEX ON dw.fato_aprovacao_verba (campanha_sk);
CREATE INDEX ON dw.fato_aprovacao_verba (aprovador_sk);
CREATE INDEX ON dw.fato_diagnostico_quiz (tenant_sk, data_sk);
CREATE INDEX ON dw.fato_diagnostico_quiz (lead_sk);
CREATE INDEX ON dw.fato_diagnostico_quiz (canal_sk);
CREATE INDEX ON dw.fato_diagnostico_quiz (origem_sk);
CREATE INDEX ON dw.fato_diagnostico_quiz (faixa_sk);

-- ===================== ISOLAMENTO POR TENANT (RLS) =====================
-- A aplicação define, por conexão: SET app.tenant_sk = '<id>'; ou SET app.ver_todos_tenants = 'on' (Wings).
CREATE FUNCTION dw.pode_ver_tenant(sk integer) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.ver_todos_tenants', true), '') = 'on'
      OR sk = nullif(current_setting('app.tenant_sk', true), '')::integer
$$;
ALTER TABLE dw.fato_midia_diaria ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_midia_diaria USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.fato_conversao ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_conversao USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.fato_negociacao ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_negociacao USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.fato_funil_diario ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_funil_diario USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.fato_aprovacao_verba ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_aprovacao_verba USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.fato_diagnostico_quiz ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_diagnostico_quiz USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.dim_marca ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.dim_marca USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.dim_lead ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.dim_lead USING (dw.pode_ver_tenant(tenant_sk));

-- ===================== VISÕES PARA OS PAINÉIS =====================
-- Taxas calculadas na consulta; divisão por zero vira nulo, e o painel mostra "—".
CREATE VIEW dw.vw_midia_mensal WITH (security_invoker = true) AS
SELECT d.ano, d.mes, f.tenant_sk, c.canal_nome, k.plataforma, k.campanha_id,
       max(k.campanha_nome) AS campanha_nome, f.marca_sk,
       sum(f.investimento) AS investimento,
       sum(f.impressoes) AS impressoes,
       sum(f.cliques) AS cliques,
       sum(f.leads_plataforma) AS leads_plataforma,
       round(sum(f.cliques)::numeric / nullif(sum(f.impressoes), 0), 4) AS ctr,
       round(sum(f.investimento) / nullif(sum(f.cliques), 0), 2) AS cpc,
       round(sum(f.investimento) / nullif(sum(f.leads_plataforma), 0), 2) AS cpl,
       count(*) FILTER (WHERE f.investimento IS NULL) AS dias_sem_investimento_informado
FROM dw.fato_midia_diaria f
JOIN dw.dim_data d USING (data_sk)
JOIN dw.dim_canal c USING (canal_sk)
JOIN dw.dim_campanha k USING (campanha_sk)
GROUP BY d.ano, d.mes, f.tenant_sk, c.canal_nome, k.plataforma, k.campanha_id, f.marca_sk;

CREATE VIEW dw.vw_funil_marcos WITH (security_invoker = true) AS
SELECT d.ano, d.mes, n.tenant_sk, n.marca_sk, n.canal_sk,
       count(*) AS criadas,
       count(*) FILTER (WHERE n.qualificada_sk <> 0) AS qualificadas,
       count(*) FILTER (WHERE n.reuniao_sk <> 0) AS reunioes,
       count(*) FILTER (WHERE n.proposta_sk <> 0) AS propostas,
       count(*) FILTER (WHERE n.cof_enviada_sk <> 0) AS cof_enviadas,
       count(*) FILTER (WHERE n.ganha_sk <> 0) AS ganhas,
       count(*) FILTER (WHERE n.perdida_sk <> 0) AS perdidas,
       round(avg(n.dias_ate_fechar) FILTER (WHERE n.ganha_sk <> 0), 1) AS media_dias_ate_ganhar
FROM dw.fato_negociacao n
JOIN dw.dim_data d ON d.data_sk = n.criada_sk
GROUP BY d.ano, d.mes, n.tenant_sk, n.marca_sk, n.canal_sk;
