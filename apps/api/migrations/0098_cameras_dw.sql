-- Câmeras (docs/cameras.md, docs/bi/README.md): fluxo de pessoas por área das lojas dos clientes e
-- do escritório da Wings, só em números agregados. O vídeo nunca sai do local: nenhuma imagem,
-- rosto ou identificação de pessoa chega ao servidor; nada de reconhecimento facial.

CREATE TABLE "camera_devices" (
	"tenant_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_batch_at" timestamp with time zone,
	CONSTRAINT "camera_devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "camera_devices" ADD CONSTRAINT "camera_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camera_devices" ADD CONSTRAINT "camera_devices_created_by_employees_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
COMMENT ON TABLE camera_devices IS 'Dispositivos de câmera cadastrados pelo Admin Master: só o SHA-256 do token; o token sai uma vez, no cadastro.';
COMMENT ON COLUMN camera_devices.test IS 'dispositivo de teste: os lotes dele ficam fora do painel (fonte = teste)';

-- ===================== DIMENSÕES =====================
CREATE TABLE dw.dim_unidade (
  unidade_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unidade_id text NOT NULL UNIQUE,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  marca_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_marca,
  nome text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('escritorio', 'loja')),
  cidade text,
  uf char(2),
  ativo boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE dw.dim_unidade IS 'Unidade observada: o escritório da Wings ou a loja de um cliente.';
COMMENT ON COLUMN dw.dim_unidade.unidade_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_unidade.unidade_id IS 'id da unidade no Wings System';
COMMENT ON COLUMN dw.dim_unidade.tenant_sk IS 'tenant dono da unidade';
COMMENT ON COLUMN dw.dim_unidade.marca_sk IS 'rede a que a loja pertence; 0 = o escritório ou sem rede';
COMMENT ON COLUMN dw.dim_unidade.nome IS 'nome da unidade';
COMMENT ON COLUMN dw.dim_unidade.tipo IS 'escritorio ou loja';
COMMENT ON COLUMN dw.dim_unidade.cidade IS 'cidade';
COMMENT ON COLUMN dw.dim_unidade.uf IS 'UF';
COMMENT ON COLUMN dw.dim_unidade.ativo IS 'unidade ativa';

CREATE TABLE dw.dim_area (
  area_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  unidade_sk integer NOT NULL REFERENCES dw.dim_unidade,
  area_codigo text NOT NULL,
  nome text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('porta', 'recepcao', 'sala_reuniao', 'salao', 'caixa', 'outra')),
  capacidade smallint,
  ativo boolean NOT NULL DEFAULT true,
  UNIQUE (unidade_sk, area_codigo)
);
COMMENT ON TABLE dw.dim_area IS 'Área observada dentro de uma unidade: porta, recepção, sala de reunião, salão, caixa. Nunca uma mesa de trabalho.';
COMMENT ON COLUMN dw.dim_area.area_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_area.tenant_sk IS 'tenant (o da unidade)';
COMMENT ON COLUMN dw.dim_area.unidade_sk IS 'unidade';
COMMENT ON COLUMN dw.dim_area.area_codigo IS 'código da área na unidade (ex.: porta, recepcao, sala-1)';
COMMENT ON COLUMN dw.dim_area.nome IS 'nome exibido';
COMMENT ON COLUMN dw.dim_area.tipo IS 'porta, recepcao, sala_reuniao, salao, caixa ou outra';
COMMENT ON COLUMN dw.dim_area.capacidade IS 'lugares da área, quando informado';
COMMENT ON COLUMN dw.dim_area.ativo IS 'área ativa';

CREATE TABLE dw.dim_dispositivo (
  dispositivo_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispositivo_id text NOT NULL UNIQUE,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  unidade_sk integer NOT NULL REFERENCES dw.dim_unidade,
  area_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_area,
  nome text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('camera', 'caixa')),
  fabricante text,
  modelo text,
  teste boolean NOT NULL DEFAULT false,
  ativo boolean NOT NULL DEFAULT true,
  instalado_em date
);
COMMENT ON TABLE dw.dim_dispositivo IS 'Câmera ou caixa de análise que manda os lotes de 15 minutos. O token fica em camera_devices (hash).';
COMMENT ON COLUMN dw.dim_dispositivo.dispositivo_sk IS 'chave substituta';
COMMENT ON COLUMN dw.dim_dispositivo.dispositivo_id IS 'id em camera_devices';
COMMENT ON COLUMN dw.dim_dispositivo.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.dim_dispositivo.unidade_sk IS 'unidade onde está';
COMMENT ON COLUMN dw.dim_dispositivo.area_sk IS 'área que observa; 0 = ainda não ligada a uma área';
COMMENT ON COLUMN dw.dim_dispositivo.nome IS 'nome exibido';
COMMENT ON COLUMN dw.dim_dispositivo.tipo IS 'camera (conta sozinha) ou caixa (computador local que lê as câmeras)';
COMMENT ON COLUMN dw.dim_dispositivo.fabricante IS 'fabricante, quando informado';
COMMENT ON COLUMN dw.dim_dispositivo.modelo IS 'modelo, quando informado';
COMMENT ON COLUMN dw.dim_dispositivo.teste IS 'dispositivo de teste: seus lotes ficam fora do painel';
COMMENT ON COLUMN dw.dim_dispositivo.ativo IS 'false depois de revogado';
COMMENT ON COLUMN dw.dim_dispositivo.instalado_em IS 'dia da instalação, quando informado';

CREATE TABLE dw.dim_faixa_horaria (
  faixa_sk smallint PRIMARY KEY,
  inicio time NOT NULL,
  fim time NOT NULL,
  hora smallint NOT NULL,
  minuto smallint NOT NULL,
  periodo text NOT NULL
);
COMMENT ON TABLE dw.dim_faixa_horaria IS 'As 96 faixas de 15 minutos do dia (hora local da unidade); 0 = sem informação.';
COMMENT ON COLUMN dw.dim_faixa_horaria.faixa_sk IS '1 = 00:00–00:15 … 96 = 23:45–24:00; 0 = sem informação';
COMMENT ON COLUMN dw.dim_faixa_horaria.inicio IS 'início da faixa';
COMMENT ON COLUMN dw.dim_faixa_horaria.fim IS 'fim da faixa (exclusivo)';
COMMENT ON COLUMN dw.dim_faixa_horaria.hora IS 'hora (0–23)';
COMMENT ON COLUMN dw.dim_faixa_horaria.minuto IS 'minuto de início (0, 15, 30, 45)';
COMMENT ON COLUMN dw.dim_faixa_horaria.periodo IS 'madrugada, manhã, tarde ou noite';

INSERT INTO dw.dim_unidade (unidade_sk, unidade_id, tenant_sk, nome, tipo) OVERRIDING SYSTEM VALUE VALUES (0, '—', 0, 'Sem informação', 'escritorio');
INSERT INTO dw.dim_area (area_sk, tenant_sk, unidade_sk, area_codigo, nome, tipo) OVERRIDING SYSTEM VALUE VALUES (0, 0, 0, '—', 'Sem informação', 'outra');
INSERT INTO dw.dim_dispositivo (dispositivo_sk, dispositivo_id, tenant_sk, unidade_sk, nome, tipo) OVERRIDING SYSTEM VALUE VALUES (0, '—', 0, 0, 'Sem informação', 'camera');
INSERT INTO dw.dim_faixa_horaria (faixa_sk, inicio, fim, hora, minuto, periodo) VALUES (0, '00:00', '00:00', 0, 0, '—');
INSERT INTO dw.dim_faixa_horaria (faixa_sk, inicio, fim, hora, minuto, periodo)
SELECT n, (time '00:00' + (n - 1) * interval '15 minutes')::time,
       (time '00:00' + n * interval '15 minutes')::time,
       ((n - 1) / 4)::smallint, (((n - 1) % 4) * 15)::smallint,
       CASE WHEN (n - 1) / 4 < 6 THEN 'madrugada' WHEN (n - 1) / 4 < 12 THEN 'manhã' WHEN (n - 1) / 4 < 18 THEN 'tarde' ELSE 'noite' END
FROM generate_series(1, 96) AS g(n);
-- 24:00 não existe como time: a última faixa fecha em 23:59:59.
UPDATE dw.dim_faixa_horaria SET fim = '23:59:59' WHERE faixa_sk = 96;

-- A chave AAAAMMDD de um instante, no dia de São Paulo; 0 sem instante ou fora do calendário.
-- OR REPLACE porque a migração 0097 (Produtividade) cria a mesma função: vale em qualquer ordem.
CREATE OR REPLACE FUNCTION dw.data_sk(em timestamptz) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT d.data_sk FROM dw.dim_data d WHERE d.data = (em AT TIME ZONE 'America/Sao_Paulo')::date), 0)
$$;
COMMENT ON FUNCTION dw.data_sk(timestamptz) IS 'chave AAAAMMDD do dia (São Paulo) de um instante; 0 = sem instante ou fora do calendário';

-- A faixa de 15 minutos de um instante, na hora de São Paulo.
CREATE FUNCTION dw.faixa_sk(em timestamptz) RETURNS smallint
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN em IS NULL THEN 0
         ELSE (extract(hour FROM em AT TIME ZONE 'America/Sao_Paulo')::int * 4
               + floor(extract(minute FROM em AT TIME ZONE 'America/Sao_Paulo') / 15)::int + 1)::smallint END
$$;
COMMENT ON FUNCTION dw.faixa_sk(timestamptz) IS 'faixa de 15 minutos (1–96) de um instante, hora de São Paulo; 0 = sem instante';

-- ===================== FATOS =====================
CREATE TABLE dw.fato_fluxo_area (
  data_sk integer NOT NULL REFERENCES dw.dim_data,
  faixa_sk smallint NOT NULL REFERENCES dw.dim_faixa_horaria,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  unidade_sk integer NOT NULL REFERENCES dw.dim_unidade,
  area_sk integer NOT NULL REFERENCES dw.dim_area,
  dispositivo_sk integer NOT NULL REFERENCES dw.dim_dispositivo,
  entradas integer,
  saidas integer,
  ocupacao_maxima smallint,
  permanencia_segundos bigint,
  permanencias integer,
  inicio_em timestamptz NOT NULL,
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (data_sk, faixa_sk, area_sk, dispositivo_sk)
);
COMMENT ON TABLE dw.fato_fluxo_area IS 'Fluxo por área. Grão: Uma linha por área e dispositivo a cada 15 minutos (snapshot periódico). Fontes: lotes mandados pelo dispositivo (POST /public/cameras/batches). Só contagens: nenhuma imagem.';
COMMENT ON COLUMN dw.fato_fluxo_area.data_sk IS 'dia (hora local)';
COMMENT ON COLUMN dw.fato_fluxo_area.faixa_sk IS 'faixa de 15 minutos';
COMMENT ON COLUMN dw.fato_fluxo_area.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.fato_fluxo_area.unidade_sk IS 'unidade';
COMMENT ON COLUMN dw.fato_fluxo_area.area_sk IS 'área observada';
COMMENT ON COLUMN dw.fato_fluxo_area.dispositivo_sk IS 'dispositivo que contou';
COMMENT ON COLUMN dw.fato_fluxo_area.entradas IS 'pessoas que entraram na faixa (aditiva); nulo = o dispositivo não contou';
COMMENT ON COLUMN dw.fato_fluxo_area.saidas IS 'pessoas que saíram na faixa (aditiva); nulo = não contou';
COMMENT ON COLUMN dw.fato_fluxo_area.ocupacao_maxima IS 'maior número de pessoas ao mesmo tempo na faixa (semiaditiva: não somar; usar máximo ou média)';
COMMENT ON COLUMN dw.fato_fluxo_area.permanencia_segundos IS 'soma das permanências encerradas na faixa, em segundos (aditiva)';
COMMENT ON COLUMN dw.fato_fluxo_area.permanencias IS 'permanências encerradas na faixa (aditiva); a média sai na consulta';
COMMENT ON COLUMN dw.fato_fluxo_area.inicio_em IS 'início da faixa, instante exato';
COMMENT ON COLUMN dw.fato_fluxo_area.fonte IS 'dispositivo, ou teste (lote de dispositivo de teste: fora do painel)';
COMMENT ON COLUMN dw.fato_fluxo_area.carregado_em IS 'quando a linha foi carregada';

CREATE TABLE dw.fato_alerta (
  alerta_id text PRIMARY KEY,
  data_sk integer NOT NULL REFERENCES dw.dim_data,
  faixa_sk smallint NOT NULL REFERENCES dw.dim_faixa_horaria,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  unidade_sk integer NOT NULL REFERENCES dw.dim_unidade,
  area_sk integer NOT NULL REFERENCES dw.dim_area,
  dispositivo_sk integer NOT NULL REFERENCES dw.dim_dispositivo,
  tipo text NOT NULL CHECK (tipo IN ('sala_ocupada_sem_reserva', 'sala_reservada_vazia', 'lotacao', 'permanencia_longa', 'dispositivo_offline')),
  pessoas smallint,
  iniciado_em timestamptz NOT NULL,
  encerrado_em timestamptz,
  quantidade smallint NOT NULL DEFAULT 1,
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE dw.fato_alerta IS 'Alerta. Grão: Uma linha por alerta que o dispositivo emitiu (sala ocupada sem reserva, sala reservada que ficou vazia, lotação, permanência longa, dispositivo fora do ar). Fontes: lotes do dispositivo.';
COMMENT ON COLUMN dw.fato_alerta.alerta_id IS 'dispositivo, início e tipo (dimensão degenerada)';
COMMENT ON COLUMN dw.fato_alerta.data_sk IS 'dia do início';
COMMENT ON COLUMN dw.fato_alerta.faixa_sk IS 'faixa do início';
COMMENT ON COLUMN dw.fato_alerta.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.fato_alerta.unidade_sk IS 'unidade';
COMMENT ON COLUMN dw.fato_alerta.area_sk IS 'área';
COMMENT ON COLUMN dw.fato_alerta.dispositivo_sk IS 'dispositivo';
COMMENT ON COLUMN dw.fato_alerta.tipo IS 'sala_ocupada_sem_reserva, sala_reservada_vazia, lotacao, permanencia_longa ou dispositivo_offline';
COMMENT ON COLUMN dw.fato_alerta.pessoas IS 'pessoas contadas no alerta, quando faz sentido';
COMMENT ON COLUMN dw.fato_alerta.iniciado_em IS 'quando começou';
COMMENT ON COLUMN dw.fato_alerta.encerrado_em IS 'quando terminou; nulo = ainda aberto quando o lote saiu';
COMMENT ON COLUMN dw.fato_alerta.quantidade IS 'sempre 1, para somar contagens';
COMMENT ON COLUMN dw.fato_alerta.fonte IS 'dispositivo, ou teste';
COMMENT ON COLUMN dw.fato_alerta.carregado_em IS 'quando a linha foi carregada';

CREATE INDEX ON dw.dim_area (unidade_sk);
CREATE INDEX ON dw.dim_dispositivo (unidade_sk);
CREATE INDEX ON dw.fato_fluxo_area (tenant_sk, data_sk);
CREATE INDEX ON dw.fato_fluxo_area (unidade_sk, data_sk);
CREATE INDEX ON dw.fato_fluxo_area (dispositivo_sk);
CREATE INDEX ON dw.fato_alerta (tenant_sk, data_sk);
CREATE INDEX ON dw.fato_alerta (unidade_sk, data_sk);
CREATE INDEX ON dw.fato_alerta (area_sk);

ALTER TABLE dw.dim_unidade ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.dim_unidade USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.dim_area ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.dim_area USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.dim_dispositivo ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.dim_dispositivo USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.fato_fluxo_area ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_fluxo_area USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.fato_alerta ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_alerta USING (dw.pode_ver_tenant(tenant_sk));
