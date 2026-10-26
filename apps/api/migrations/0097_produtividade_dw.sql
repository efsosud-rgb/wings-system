-- Produtividade por resultado (docs/crm/produtividade.md, docs/bi/README.md): só ids no DW, o
-- primeiro contato como marco do snapshot acumulado, dois fatos de transação novos e a conta de
-- minutos úteis no banco. Só o schema dw muda.

-- O nome fica no sistema de origem (employees); o DW guarda só o id e o painel lê o nome pelo usuario_id.
ALTER TABLE dw.dim_usuario ALTER COLUMN nome DROP NOT NULL;
COMMENT ON COLUMN dw.dim_usuario.nome IS 'nulo desde 26/10/2026: o nome fica no sistema de origem; o painel lê pelo usuario_id';

-- A chave AAAAMMDD de um instante, no dia de São Paulo; 0 quando não há instante ou o dia está fora do calendário.
CREATE FUNCTION dw.data_sk(em timestamptz) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT d.data_sk FROM dw.dim_data d WHERE d.data = (em AT TIME ZONE 'America/Sao_Paulo')::date), 0)
$$;
COMMENT ON FUNCTION dw.data_sk(timestamptz) IS 'chave AAAAMMDD do dia (São Paulo) de um instante; 0 = sem instante ou fora do calendário';

-- Minutos úteis entre dois instantes: segunda a sexta, 9h às 18h de São Paulo, sem feriados
-- (dim_data.feriado_nacional fica nulo até o calendário do Jurídico). Nulo sem um dos lados
-- ou com o fim antes do início. Sexta 17h50 até segunda 9h50 = 60.
CREATE FUNCTION dw.minutos_uteis(de timestamptz, ate timestamptz) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN de IS NULL OR ate IS NULL OR ate < de THEN NULL
         ELSE coalesce((
           SELECT floor(sum(greatest(0, extract(epoch FROM least(ate, dia.fim) - greatest(de, dia.ini)) / 60)))::integer
           FROM (
             SELECT (g.d::date + time '09:00') AT TIME ZONE 'America/Sao_Paulo' AS ini,
                    (g.d::date + time '18:00') AT TIME ZONE 'America/Sao_Paulo' AS fim
             FROM generate_series((de AT TIME ZONE 'America/Sao_Paulo')::date,
                                  (ate AT TIME ZONE 'America/Sao_Paulo')::date, interval '1 day') AS g(d)
             WHERE extract(isodow FROM g.d) < 6
           ) AS dia), 0)
         END
$$;
COMMENT ON FUNCTION dw.minutos_uteis(timestamptz, timestamptz) IS 'minutos úteis (seg–sex, 9h–18h, São Paulo, sem feriados) entre dois instantes';

-- Snapshot acumulado da negociação: o funil e o marco do primeiro contato.
ALTER TABLE dw.fato_negociacao
  ADD COLUMN funil text,
  ADD COLUMN primeiro_contato_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_data,
  ADD COLUMN minutos_uteis_ate_primeiro_contato integer,
  ADD COLUMN primeiro_contato_no_prazo boolean;
COMMENT ON COLUMN dw.fato_negociacao.funil IS 'funil do CRM (expansao, formatacao, consultoria); nulo = sem funil';
COMMENT ON COLUMN dw.fato_negociacao.primeiro_contato_sk IS 'marco: primeiro contato (0 = ainda não, ou sem registro)';
COMMENT ON COLUMN dw.fato_negociacao.minutos_uteis_ate_primeiro_contato IS 'minutos úteis entre o dono receber o lead e o primeiro contato; nulo sem contato';
COMMENT ON COLUMN dw.fato_negociacao.primeiro_contato_no_prazo IS 'contato em até 1 hora útil; nulo enquanto dentro do prazo, sem tarefa de primeiro contato, ou fechada sem contato';
CREATE INDEX ON dw.fato_negociacao (primeiro_contato_sk);

CREATE TABLE dw.fato_atividade (
  atividade_id text PRIMARY KEY,
  data_sk integer NOT NULL REFERENCES dw.dim_data,
  hora smallint CHECK (hora BETWEEN 0 AND 23),
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  usuario_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_usuario,
  lead_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_lead,
  negociacao_id text,
  funil text,
  tipo text NOT NULL CHECK (tipo IN ('ligacao', 'mensagem', 'email', 'reuniao_agendada', 'reuniao_realizada', 'nota', 'tarefa')),
  minutos_uteis_resposta integer,
  quantidade smallint NOT NULL DEFAULT 1,
  evento_em timestamptz NOT NULL,
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE dw.fato_atividade IS 'Atividade de uma pessoa. Grão: Uma linha por atividade registrada por uma pessoa numa negociação (ligação, mensagem, e-mail, reunião agendada, reunião realizada, nota ou tarefa concluída). Fontes: CRM do Wings System.';
COMMENT ON COLUMN dw.fato_atividade.atividade_id IS 'tabela e id na origem (dimensão degenerada)';
COMMENT ON COLUMN dw.fato_atividade.data_sk IS 'dia da atividade';
COMMENT ON COLUMN dw.fato_atividade.hora IS 'hora da atividade (São Paulo)';
COMMENT ON COLUMN dw.fato_atividade.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.fato_atividade.usuario_sk IS 'quem fez (papel de dim_usuario); 0 = sem pessoa';
COMMENT ON COLUMN dw.fato_atividade.lead_sk IS 'contato';
COMMENT ON COLUMN dw.fato_atividade.negociacao_id IS 'id da negociação no CRM';
COMMENT ON COLUMN dw.fato_atividade.funil IS 'funil da negociação na carga';
COMMENT ON COLUMN dw.fato_atividade.tipo IS 'ligacao, mensagem, email, reuniao_agendada, reuniao_realizada, nota ou tarefa';
COMMENT ON COLUMN dw.fato_atividade.minutos_uteis_resposta IS 'só mensagem: minutos úteis desde a primeira mensagem do lead ainda sem resposta; nulo quando não respondia a ninguém';
COMMENT ON COLUMN dw.fato_atividade.quantidade IS 'sempre 1, para somar contagens';
COMMENT ON COLUMN dw.fato_atividade.evento_em IS 'momento exato da atividade';
COMMENT ON COLUMN dw.fato_atividade.fonte IS 'sistema de origem (módulo do Wings System)';
COMMENT ON COLUMN dw.fato_atividade.carregado_em IS 'quando a linha foi carregada';

CREATE TABLE dw.fato_movimentacao_etapa (
  movimentacao_id text PRIMARY KEY,
  data_sk integer NOT NULL REFERENCES dw.dim_data,
  hora smallint CHECK (hora BETWEEN 0 AND 23),
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  usuario_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_usuario,
  lead_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_lead,
  negociacao_id text NOT NULL,
  funil text,
  etapa_origem_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_etapa,
  etapa_destino_sk integer NOT NULL DEFAULT 0 REFERENCES dw.dim_etapa,
  avanco boolean,
  quantidade smallint NOT NULL DEFAULT 1,
  evento_em timestamptz NOT NULL,
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE dw.fato_movimentacao_etapa IS 'Movimentação de etapa. Grão: Uma linha por mudança de etapa de uma negociação (sem as linhas de ganho ou perda). Fontes: histórico de etapas do CRM do Wings System.';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.movimentacao_id IS 'id da linha do histórico na origem (dimensão degenerada)';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.data_sk IS 'dia da mudança';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.hora IS 'hora da mudança (São Paulo)';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.tenant_sk IS 'tenant';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.usuario_sk IS 'quem moveu (papel de dim_usuario); 0 = automação, Sofia, triagem ou RD';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.lead_sk IS 'contato';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.negociacao_id IS 'id da negociação no CRM';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.funil IS 'funil da negociação na carga';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.etapa_origem_sk IS 'etapa de onde saiu (papel de dim_etapa); 0 = nasceu sem etapa';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.etapa_destino_sk IS 'etapa para onde foi (papel de dim_etapa); 0 = etapa fora do CRM';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.avanco IS 'true quando o destino vem depois da origem no mesmo funil; nulo sem origem ou entre funis';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.quantidade IS 'sempre 1, para somar contagens';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.evento_em IS 'momento da mudança na origem';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.fonte IS 'sistema de origem (módulo do Wings System)';
COMMENT ON COLUMN dw.fato_movimentacao_etapa.carregado_em IS 'quando a linha foi carregada';

CREATE INDEX ON dw.fato_atividade (tenant_sk, data_sk);
CREATE INDEX ON dw.fato_atividade (usuario_sk);
CREATE INDEX ON dw.fato_atividade (lead_sk);
CREATE INDEX ON dw.fato_movimentacao_etapa (tenant_sk, data_sk);
CREATE INDEX ON dw.fato_movimentacao_etapa (usuario_sk);
CREATE INDEX ON dw.fato_movimentacao_etapa (lead_sk);
CREATE INDEX ON dw.fato_movimentacao_etapa (etapa_destino_sk);

ALTER TABLE dw.fato_atividade ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_atividade USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.fato_movimentacao_etapa ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_movimentacao_etapa USING (dw.pode_ver_tenant(tenant_sk));
