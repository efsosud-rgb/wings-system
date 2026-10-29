# Anexo 5 — Painel por fonte (modelo dimensional)

Parte da [especificação do Wings Prospect AI](../ESPECIFICACAO.md), seção 7. Código de referência: commit `c4168cb` da develop. Abreviações: `api` = `apps/api/src`, `shared` = `packages/shared/src`.

## 7.0 Onde entra e por quê

- O Wings System **já tem** um modelo dimensional Kimball no schema `dw` (`docs/bi/README.md`, `docs/bi/ddl.sql`), aplicado pela migration `0060_bi_dw_dimensional_model.sql` e testado em `api/db/bi-dw.test.ts`. **Nada carrega o `dw` hoje** (divergência V2 da especificação). O painel por fonte entra nesse schema e traz a **primeira carga** dele.
- Valem as regras do `dw` (`docs/bi/README.md:7-12`): medida nula = a fonte não informou e a tela mostra "—" com o motivo, **nunca zero**; nenhum dado pessoal (só ids); toda tabela de fato tem `tenant_sk` com RLS por `dw.pode_ver_tenant` (`docs/bi/ddl.sql:520-528`); chave 0 = "sem informação"; usuário e campanha em SCD tipo 2; taxas só nas visões; nomes em português (`dim_*`, `fato_*`, `vw_*`).
- Reaproveita sem mudar: `dw.dim_data` (já preenchida de 2024-01-01 a 2030-12-31, migration 0060:246-259; `data_sk` = AAAAMMDD, 0 = sem data), `dw.dim_tenant` (chave natural `tenant_id`) e `dw.dim_usuario` (SCD2, aqui no papel de **vendedor**).

## 7.1 Processo, grão, dimensões e fatos

**Processo de negócio:** prospecção e qualificação comercial, da primeira descoberta ao contrato, por fonte.

**Dois fatos, porque os grãos são diferentes** (o gasto de mídia não tem vendedor nem categoria; misturar os dois num fato só obrigaria a inventar uma divisão na carga):

| Fato | Tipo | Grão |
|---|---|---|
| `dw.fato_funil_fonte_diario` | agregado diário de eventos | uma linha por **dia × tenant × fonte × campanha × vendedor × categoria × funil** |
| `dw.fato_custo_fonte_diario` | snapshot periódico de custo | uma linha por **dia × tenant × fonte × campanha × tipo de custo** |

As duas se juntam por "drill-across" nas dimensões conformadas (data, tenant, fonte, campanha) dentro das visões e da consulta da API.

**Matriz de barramento (acréscimo à de `docs/bi/README.md`):**

| Fato | Data | Tenant | Fonte | Campanha (resumo) | Vendedor | Categoria | Funil (degenerada) | Tipo de custo (degenerada) |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Funil por fonte diário | ● | ● | ● | ● | ● | ● | ● | |
| Custo por fonte diário | ● | ● | ● | ● | | | | ● |

**Por que o funil é dimensão degenerada:** são três valores fixos do código (`LEAD_PIPELINES`, `shared/leads.ts:56`), mais `''` para "sem funil". Uma tabela de dimensão só repetiria a lista. Entra na chave do fato porque o filtro "Funil" da tela precisa dele.

## 7.2 Dimensões novas

### `dw.dim_fonte` (SCD tipo 1, carregada pela migration)

Uma linha por fonte de aquisição. Chave natural `fonte_codigo`. Linha 0 = "sem informação".

| `fonte_codigo` | `fonte_nome` | `tipo` | `grupo_custo` | Vem de |
|---|---|---|---|---|
| `google_maps` | Prospecção Google | prospecção ativa | `google_places` | `prospects`; `leads.source = 'google_places'` |
| `instagram_comentario` | Instagram (comentário) | orgânico | — | `leads.source = 'instagram_comment'`; evidência `instagram_comment`, `instagram_mention` |
| `instagram_direct` | Instagram (Direct) | orgânico | — | `instagram_dm`; evidência `instagram_dm` |
| `instagram_anuncio` | Instagram (anúncio) | pago | `meta_ads` | `instagram_ad`; evidência `instagram_ad_comment`, `instagram_ad_referral` |
| `radar_concorrentes` | Radar de concorrentes | prospecção ativa | — | `competitor_radar`; evidência `competitor_radar` |
| `meta_lead_ads` | Formulário da Meta | pago | `meta_ads` | `meta_lead_ads` |
| `google_lead_form` | Formulário do Google Ads | pago | `google_ads` | `google_lead_form` |
| `tiktok_lead_ads` | Formulário do TikTok | pago | `tiktok_ads` | `tiktok_lead_ads` |
| `site_form` | Site e landing pages | orgânico ou pago (pela campanha) | — | `site_form` |
| `rd_station` | RD Station | orgânico ou pago (pela campanha) | — | `rd_station` |
| `whatsapp` | WhatsApp | direto | — | `whatsapp`, `whatsapp_link` |
| `manual` | Cadastro manual | direto | — | `manual` |
| `csv_import` | Importação | direto | — | `csv_import` |
| `rd_crm` | RD CRM (espelho) | direto | — | `rd_crm` |

Colunas: `fonte_sk` (identity), `fonte_codigo` (unique), `fonte_nome`, `tipo` (`pago`, `orgânico`, `prospecção ativa`, `direto`), `grupo_custo` (nulo quando a fonte não tem custo de mídia). O mapa origem do lead → `fonte_codigo` mora numa função pura em `shared/prospect-ai.ts` (`fonteOf(source)`), testada contra `LEAD_SOURCES` inteiro: origem nova sem mapa quebra o teste. Origem desconhecida cai na linha 0 e aparece no painel como "Outras (sem mapa)".

### `dw.dim_categoria_servico` (SCD tipo 1)

Uma linha por serviço de `prospect_ai_settings.settings.services` (anexo 1 §2.6). Chave natural `categoria_codigo` (o slug). Colunas: `categoria_sk`, `categoria_codigo` (unique), `categoria_nome`, `funil_destino`, `vendido` (boolean), `ativo` (false quando o serviço sai da lista; a linha não é apagada para não perder a história). Linha 0 = "Sem categoria" (lead que não passou pela fila, como formulário e anúncio).

### `dw.dim_campanha_resumo` (dimensão encolhida de `dw.dim_campanha`, SCD tipo 2)

A `dw.dim_campanha` que já existe tem grão de **anúncio** (`anuncio_id NOT NULL`, `docs/bi/ddl.sql:90-120`), e o gasto usado aqui é por **campanha** (`ad_metrics_daily` no nível `campaign`). Pelo método de Kimball isso pede uma dimensão encolhida ("shrunken rollup dimension"): os mesmos atributos de campanha, com os mesmos nomes e valores, num grão maior. Assim ela continua conformada com a `dim_campanha`.

Colunas: `campanha_resumo_sk`, `plataforma` (`meta`, `google`, `tiktok`), `conta_id`, `campanha_id`, `campanha_nome`, `objetivo`, `valido_de`, `valido_ate` (padrão `9999-12-31`), `atual`; unique `(plataforma, campanha_id, valido_de)`. Linha 0 = "Sem campanha" (orgânico, prospecção ou lead sem id de campanha). Fonte: `ad_campaigns` (`external_id`, `name`; `api/db/schema/ads.ts:240-290`) com `ad_accounts` (`platform` :121, `external_id` :123).

## 7.3 `dw.fato_funil_fonte_diario` — medidas

Cada evento é contado **no dia em que aconteceu** (fuso de São Paulo) e uma vez só por lead ou oportunidade (o "primeiro" de cada marco). Todas as medidas são aditivas. Atributos da linha:

- **Fonte:** pela origem do lead (`leads.source`, `api/db/schema/leads.ts:51`), da oportunidade (`prospect_opportunities.source`) ou `google_maps` para `prospects`.
- **Campanha:** `leads.ad_platform` + `leads.ad_campaign_external_id` (`api/db/schema/leads.ts:151-152`) → `dim_campanha_resumo`. Sem id, mas com `utm_campaign`: a mesma regra de casamento de `api/modules/ads/dashboard/funnel-crm.ts:111-119` (UTM de rascunho, nome ou id). Sem nada: 0.
- **Vendedor:** dono atual (`leads.owner_employee_id` :49, `prospect_opportunities.owner_employee_id`, `prospects.owner_employee_id` em `api/db/schema/prospecting.ts:39`; na ligação, `prospect_call_logs.employee_id`), na versão de `dim_usuario` vigente no dia do evento. Sem dono: 0. `shortcut:` usa o dono **na hora da carga**, não o da data do evento; trocar por `lead_events` `lead.owner_changed` se a troca de dono atrapalhar a leitura.
- **Categoria:** `prospect_opportunities.category` da oportunidade ligada ao lead (`lead_id`); senão 0.
- **Funil:** `leads.pipeline` (:101); oportunidade sem lead: o `funil` do serviço; prospect: `formatacao` (a prospecção Google sempre cria lead no funil Formatação).

| Medida | Definição exata | Tabelas |
|---|---|---|
| `encontrados` | Google: prospect reservado (`prospects.created_at`, `api/db/schema/prospecting.ts:48`). Instagram e radar: oportunidade criada (`prospect_opportunities.created_at`). Fontes sem etapa de descoberta (formulários, site, RD, WhatsApp, manual): igual a `leads_criados` | `prospects`, `prospect_opportunities`, `leads` |
| `aprovados` | Oportunidade que passou a `aprovada`, no dia de `decided_at`. **Nulo** para fontes sem fila (motivo `sem_fila`) | `prospect_opportunities` |
| `rejeitados` | Oportunidade `rejeitada` no dia de `decided_at`. Nulo para fontes sem fila | `prospect_opportunities` |
| `qualificados` | **Decisão do Eric (E7).** Recomendação: (a) fontes com fila = `aprovados`; (b) demais = lead cuja **primeira** saída da etapa de entrada (`entryStageOf`, `api/modules/leads/crm.ts:201`) foi para uma etapa aberta, no dia de `lead_stage_history.at` (`api/db/schema/crm.ts:72-93`, com `won` nulo). Prospect Google conta pelo lead que gerou, na mesma regra (b) | `prospect_opportunities`, `lead_stage_history`, `crm_stages` |
| `leads_criados` | Lead novo (`leads.created_at`, `api/db/schema/leads.ts:215`). Junção com lead existente **não** conta (conta em `aprovados`) | `leads` |
| `contatados` | Primeira data, por lead ou prospect, entre: ligação com resultado `interessado`, `retornar`, `sem_interesse` ou `pediu_nao_contatar` (`prospect_call_logs.called_at`); `prospect_opportunities.responded_at`; tarefa `first_contact` concluída (`lead_tasks.done_at`, `api/db/schema/crm.ts:131`). Não atender, caixa postal e número errado **não** contam | `prospect_call_logs`, `prospect_opportunities`, `lead_tasks` |
| `reunioes` | Primeira data, por lead, entre: `crm_meetings.starts_at` com `status` diferente de `cancelada` (`api/db/schema/meetings.ts:22,27`) e já passada; e a primeira entrada (`lead_stage_history.at`) numa etapa de posição maior ou igual à primeira etapa de reunião do funil | `crm_meetings`, `lead_stage_history`, `crm_stages` |
| `propostas` | Primeira entrada numa etapa de posição maior ou igual à primeira etapa de proposta do funil | `lead_stage_history`, `crm_stages` |
| `contratos` | Lead ganho (`leads.won = true`, :133) no dia de `closed_at` (:134) | `leads` |
| `valor_contratos_cents` | Soma de `client_contracts.value_cents` (`api/db/schema/clients.ts:178-198`, `lead_id` em :193, sem chave estrangeira de propósito) dos contratos do lead assinados no dia (`signed_on`). **Nulo** quando o lead ganho não tem contrato registrado (motivo `contrato_sem_valor`) | `client_contracts` |

**Reunião e proposta pelo nome da etapa.** `crm_stages` não tem tipo (`api/db/schema/crm.ts:41-65`). Usa a mesma regra do funil de anúncios: a primeira etapa do funil, por posição, cujo nome casa com `/reuni/i` ou `/proposta/i` (`api/modules/ads/dashboard/funnel-crm.ts:25-26`, regra em :98-109). A regra é importada desse arquivo, não copiada. **Risco:** renomear uma etapa muda o painel. Funil sem etapa que case → `reunioes` e `propostas` nulos para ele (motivo `funil_sem_etapa`).

## 7.4 `dw.fato_custo_fonte_diario` — medidas

| `tipo_custo` | Linha | Medida | Fonte dos dados |
|---|---|---|---|
| `midia` | dia × campanha; `fonte_sk = 0` ("a alocar pela campanha") | `investimento_cents` = `ad_metrics_daily.spend_cents` no nível `campaign` (`api/db/schema/ads.ts:843-911`; `spend_cents` :858; `entity_external_id` :853; unique :900-905), com `ad_accounts.platform` (:121) para não misturar ids de plataformas | `ad_metrics_daily`, `ad_accounts`, `ad_campaigns` |
| `google_places` | dia × `google_maps`; campanha 0 | `chamadas` = linhas de `prospect_calls` do dia (livro da cota, `api/modules/prospecting/quota.ts:240-267`); `custo_cents` **nulo** com motivo `preco_google_nao_conferido` até o faturamento do Google Cloud ser conferido. Com o preço conferido: 0 enquanto o mês estiver dentro da franquia grátis | `prospect_calls` |
| `ia` | dia; fonte 0, campanha 0 | `custo_micro_usd` = soma de `coalesce(cost_micro_usd, reserved_micro_usd)` de `prospect_classifier_runs` | `prospect_classifier_runs` |

Outras colunas: `moeda` (char(3)). Conta em moeda diferente de BRL (`ad_accounts.currency`, :125) → `investimento_cents` nulo com motivo `moeda_nao_brl` (não há conversão de câmbio no MVP).

**Alocação do gasto de mídia por fonte** (feita na visão, nunca gravada): uma campanha da Meta pode gerar leads de formulário e de comentário. Para cada período e campanha, `gasto alocado à fonte = gasto da campanha × qualificados da fonte na campanha ÷ qualificados da campanha`. Campanha com gasto e nenhum qualificado no período fica numa linha própria, "Gasto sem lead qualificado", para o gasto nunca sumir do total.

**Custo de IA não é alocado por fonte:** `prospect_classifier_runs` não guarda a fonte (anexo 1 §2.7). O painel mostra "Custo de IA do período" no total. É centavos por mês; se precisar por fonte, acrescentar a coluna em `prospect_classifier_runs` (não está no contrato atual).

## 7.5 Custo por lead qualificado

Fórmula do plano:

```
custo por lead qualificado = (gasto da fonte no período + custos variáveis da fonte) ÷ leads qualificados da fonte no período
```

- No plano o denominador é "leads aprovados". Aqui é `qualificados`, que para as fontes com fila **é** `aprovados` (§7.3) e para as demais segue a decisão E7. Registrado como ajuste de nomenclatura, sem mudar a conta do plano.
- Gasto da fonte = mídia alocada (§7.4). Custos variáveis = Google Places para `google_maps`; nenhum para as outras no MVP.
- Divisão por zero → nulo com motivo `sem_qualificados`. Fonte sem custo nenhum (orgânico, radar, WhatsApp) → nulo com motivo `sem_custo_midia`: **não** é R$ 0, porque o tempo da equipe não está medido.
- A taxa é calculada **depois** de somar o período inteiro, nunca pela média das taxas diárias.

## 7.6 Catálogo dos motivos de "—"

| Código | Texto na tela |
|---|---|
| `carga_pendente` | "Ainda não carregado: a carga roda toda madrugada." |
| `instagram_desligado` | "Instagram ainda não ligado neste ambiente." |
| `radar_desligado` | "Radar de concorrentes ainda não ligado." |
| `sem_fila` | "Esta fonte não passa pela fila de oportunidades." |
| `sem_custo_midia` | "Fonte sem custo de mídia (prospecção ativa ou orgânico)." |
| `gasto_nao_informado` | "A plataforma não informou o gasto deste dia." |
| `moeda_nao_brl` | "Conta de anúncio em outra moeda; o painel só soma reais." |
| `preco_google_nao_conferido` | "Preço do Google não conferido no faturamento da Wings." |
| `sem_qualificados` | "Sem lead qualificado no período: não dá para dividir." |
| `funil_sem_etapa` | "Este funil não tem etapa com 'reunião' ou 'proposta' no nome." |
| `contrato_sem_valor` | "Contrato ganho sem valor registrado." |
| `fonte_com_erro` | "A fonte teve erro no período: o número pode estar incompleto." (aviso; o número aparece) |

## 7.7 Carga (`api/modules/prospect-ai/dw-load.ts`, PR F2)

1. **Quando:** agendador `dw:funil-fonte` uma vez por dia às 03:00 (São Paulo), no padrão `setInterval` + `pg_try_advisory_xact_lock` iniciado em `api/server.ts` (molde: `api/modules/leads/automations-scheduler.ts:22,47-60`); e pelo botão "Recalcular" (`POST /prospect-ai/dashboard/refresh`). Sem a trava → 409 `carga_em_andamento`. Chave de ambiente própria (anexo 3), desligada por padrão.
2. **Janela:** reprocessa os **últimos 35 dias** a cada carga (etapas mudam depois; a mídia é ajustada para trás, `docs/bi/README.md:359`). O botão aceita um intervalo de até 400 dias.
3. **Sessão:** a conexão define `app.ver_todos_tenants = on` (`docs/bi/README.md:9`).
4. **Dimensões antes dos fatos, pela chave natural** (`docs/bi/README.md:357-362`): `dim_tenant` (de `tenants`), `dim_usuario` (de `employees`, nova versão SCD2 quando nome, equipe, papel ou ativo mudam), `dim_campanha_resumo` (nova versão quando nome ou objetivo mudam), `dim_categoria_servico` (dos `settings`). `dim_fonte` vem da migration; código fora do mapa → 0.
5. **Fatos:** numa transação, `DELETE` das linhas do tenant no intervalo e `INSERT ... SELECT` de cada medida. Rodar duas vezes dá o mesmo resultado (idempotente).
6. Cada linha grava `fonte` (sistema de origem: `crm`, `ad_metrics_daily`, `prospect_calls`, `prospect_classifier_runs`) e `carregado_em`.
7. **Nunca zero no lugar de nulo:** medida sem dado de origem é gravada nula. Linha sem nenhuma medida não é gravada.
8. Registra a execução no `audit_log` (`dw.funil_fonte_loaded`, metadados: intervalo, linhas, duração; sem dado pessoal).

## 7.8 API (PR F3; detalhe das rotas no anexo 3)

`GET /prospect-ai/dashboard?from=AAAA-MM-DD&to=AAAA-MM-DD&source=&pipeline=&sellerId=` com `prospect_ai.dashboard`:

```json
{
  "periodo": { "de": "2026-11-01", "ate": "2026-11-30" },
  "atualizadoEm": "2026-12-01T06:00:12Z",
  "mostraCusto": true,
  "fontes": [
    {
      "fonte": { "codigo": "instagram_comentario", "nome": "Instagram (comentário)" },
      "comErro": false,
      "encontrados":  { "valor": 40,   "motivo": null },
      "qualificados": { "valor": 12,   "motivo": null },
      "aprovados":    { "valor": 12,   "motivo": null },
      "contatados":   { "valor": 11,   "motivo": null },
      "reunioes":     { "valor": 4,    "motivo": null },
      "propostas":    { "valor": null, "motivo": "funil_sem_etapa" },
      "contratos":    { "valor": 1,    "motivo": null },
      "custoPorQualificadoCents": { "valor": null, "motivo": "sem_custo_midia" }
    }
  ],
  "campanhas": [ { "campanha": { "plataforma": "meta", "id": "…", "nome": "…" }, "gastoCents": { "valor": 437672, "motivo": null }, "qualificados": { "valor": 23, "motivo": null }, "custoPorQualificadoCents": { "valor": 19029, "motivo": null } } ],
  "categorias": [ { "categoria": { "codigo": "formatacao_franquias", "nome": "Formatação de franquias" }, "leads": { "valor": 9, "motivo": null } } ],
  "custoIaMicroUsd": { "valor": 812, "motivo": null }
}
```

(Os números do exemplo são ilustrativos, só para mostrar o formato.)

- **Escopo `own`:** a API força `vendedor = ator`, ignora o filtro e **não devolve custo** (`mostraCusto: false`, e os campos de custo nem vêm). Motivo: o custo é da fonte inteira e não se divide por vendedor. Recomendação ligada à decisão E8.
- **Escopo `all`:** tudo, com filtro de vendedor.
- Erros: 400 `invalid` (data inválida, intervalo maior que 400 dias); 503 `dw_desligado` quando a carga nunca rodou ("O painel ainda não foi carregado neste ambiente").
- A consulta lê só do `dw` (não varre `leads` em tempo real), por isso o painel é barato e não atrapalha o CRM.

## 7.9 DDL proposto (migration `0104_dw_funil_fonte.sql`, `drizzle-kit generate --custom`)

Esboço no estilo de `docs/bi/ddl.sql`; o PR F1 completa os `COMMENT ON` de todas as colunas e acrescenta as tabelas em `docs/bi/ddl.sql` e `docs/bi/README.md` (matriz de barramento e fatos).

```sql
CREATE TABLE dw.dim_fonte (
  fonte_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fonte_codigo text NOT NULL UNIQUE,
  fonte_nome text NOT NULL,
  tipo text NOT NULL,          -- pago, orgânico, prospecção ativa, direto
  grupo_custo text             -- meta_ads, google_ads, tiktok_ads, google_places; nulo = sem custo de mídia
);
COMMENT ON TABLE dw.dim_fonte IS 'Fonte de aquisição do lead ou da oportunidade (Prospect AI). SCD tipo 1.';

CREATE TABLE dw.dim_categoria_servico (
  categoria_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  categoria_codigo text NOT NULL UNIQUE,
  categoria_nome text NOT NULL,
  funil_destino text,
  vendido boolean,
  ativo boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE dw.dim_categoria_servico IS 'Serviço da Wings configurado nos Ajustes do Prospect AI. SCD tipo 1; 0 = sem categoria.';

CREATE TABLE dw.dim_campanha_resumo (
  campanha_resumo_sk integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plataforma text NOT NULL,
  conta_id text NOT NULL,
  campanha_id text NOT NULL,
  campanha_nome text,
  objetivo text,
  valido_de date NOT NULL,
  valido_ate date NOT NULL DEFAULT '9999-12-31',
  atual boolean NOT NULL DEFAULT true,
  UNIQUE (plataforma, campanha_id, valido_de)
);
COMMENT ON TABLE dw.dim_campanha_resumo IS 'Dimensão encolhida de dw.dim_campanha no grão de campanha (conformada). SCD tipo 2.';

CREATE TABLE dw.fato_funil_fonte_diario (
  data_sk integer NOT NULL REFERENCES dw.dim_data,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  fonte_sk integer NOT NULL REFERENCES dw.dim_fonte,
  campanha_resumo_sk integer NOT NULL REFERENCES dw.dim_campanha_resumo,
  vendedor_sk integer NOT NULL REFERENCES dw.dim_usuario,
  categoria_sk integer NOT NULL REFERENCES dw.dim_categoria_servico,
  funil text NOT NULL,         -- degenerada: expansao, formatacao, consultoria ou '' (sem funil)
  encontrados integer,
  qualificados integer,
  aprovados integer,
  rejeitados integer,
  leads_criados integer,
  contatados integer,
  reunioes integer,
  propostas integer,
  contratos integer,
  valor_contratos_cents bigint,
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (data_sk, tenant_sk, fonte_sk, campanha_resumo_sk, vendedor_sk, categoria_sk, funil)
);
COMMENT ON TABLE dw.fato_funil_fonte_diario IS 'Funil por fonte. Grão: dia × tenant × fonte × campanha × vendedor × categoria × funil. Medidas aditivas; nulo = a origem não informou.';

CREATE TABLE dw.fato_custo_fonte_diario (
  data_sk integer NOT NULL REFERENCES dw.dim_data,
  tenant_sk integer NOT NULL REFERENCES dw.dim_tenant,
  fonte_sk integer NOT NULL REFERENCES dw.dim_fonte,
  campanha_resumo_sk integer NOT NULL REFERENCES dw.dim_campanha_resumo,
  tipo_custo text NOT NULL CHECK (tipo_custo IN ('midia', 'google_places', 'ia')),
  investimento_cents bigint,
  chamadas integer,
  custo_cents bigint,
  custo_micro_usd bigint,
  moeda char(3),
  fonte text NOT NULL,
  carregado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (data_sk, tenant_sk, fonte_sk, campanha_resumo_sk, tipo_custo)
);
COMMENT ON TABLE dw.fato_custo_fonte_diario IS 'Custo por fonte. Grão: dia × tenant × fonte × campanha × tipo de custo. Mídia entra com fonte 0 e é alocada na visão.';

-- linhas 0 ("sem informação"), RLS e índices no padrão de docs/bi/ddl.sql:486-528
ALTER TABLE dw.fato_funil_fonte_diario ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_funil_fonte_diario USING (dw.pode_ver_tenant(tenant_sk));
ALTER TABLE dw.fato_custo_fonte_diario ENABLE ROW LEVEL SECURITY;
CREATE POLICY isolamento_tenant ON dw.fato_custo_fonte_diario USING (dw.pode_ver_tenant(tenant_sk));
CREATE INDEX ON dw.fato_funil_fonte_diario (tenant_sk, data_sk);
CREATE INDEX ON dw.fato_funil_fonte_diario (fonte_sk);
CREATE INDEX ON dw.fato_funil_fonte_diario (vendedor_sk);
CREATE INDEX ON dw.fato_custo_fonte_diario (tenant_sk, data_sk);
```

**Visão mensal** (no padrão de `dw.vw_funil_marcos`; a API usa a mesma soma para períodos livres):

```sql
CREATE VIEW dw.vw_funil_fonte_mensal AS
WITH funil AS (
  SELECT d.ano, d.mes, f.tenant_sk, f.fonte_sk, f.campanha_resumo_sk,
         sum(f.encontrados) AS encontrados, sum(f.qualificados) AS qualificados,
         sum(f.aprovados) AS aprovados, sum(f.contatados) AS contatados,
         sum(f.reunioes) AS reunioes, sum(f.propostas) AS propostas, sum(f.contratos) AS contratos
  FROM dw.fato_funil_fonte_diario f JOIN dw.dim_data d USING (data_sk)
  GROUP BY 1, 2, 3, 4, 5
), midia AS (
  SELECT d.ano, d.mes, c.tenant_sk, c.campanha_resumo_sk, sum(c.investimento_cents) AS gasto
  FROM dw.fato_custo_fonte_diario c JOIN dw.dim_data d USING (data_sk)
  WHERE c.tipo_custo = 'midia'
  GROUP BY 1, 2, 3, 4
), qual_campanha AS (
  SELECT ano, mes, tenant_sk, campanha_resumo_sk, sum(qualificados) AS q
  FROM funil GROUP BY 1, 2, 3, 4
)
SELECT f.*,
       m.gasto * f.qualificados / NULLIF(qc.q, 0) AS gasto_alocado_cents,
       (m.gasto * f.qualificados / NULLIF(qc.q, 0)) / NULLIF(f.qualificados, 0) AS custo_por_qualificado_cents
FROM funil f
LEFT JOIN midia m USING (ano, mes, tenant_sk, campanha_resumo_sk)
LEFT JOIN qual_campanha qc USING (ano, mes, tenant_sk, campanha_resumo_sk);
-- shortcut: a linha "Gasto sem lead qualificado" (campanha com gasto e q = 0) sai de outra consulta na API.
```

## 7.10 Validação (testes do PR F2, ampliando `api/db/bi-dw.test.ts`)

- **Contagem bate com o CRM:** num banco de teste com leads, oportunidades, etapas e reuniões feitos à mão, `sum(leads_criados)` do mês = `count(*)` de `leads` criados no mês; `sum(aprovados)` = oportunidades aprovadas; `sum(contratos)` = leads ganhos.
- **Gasto bate com a origem:** `sum(investimento_cents)` do mês = `sum(spend_cents)` de `ad_metrics_daily` no nível `campaign` do mesmo mês, por conta.
- **Nenhum zero inventado:** dia sem dado de mídia gera nulo; fonte sem fila tem `aprovados` nulo; o teste falha se aparecer 0 onde a origem não tinha linha.
- **Idempotência:** rodar a carga duas vezes no mesmo intervalo dá as mesmas linhas.
- **RLS:** com `app.tenant_sk` de outro tenant, nenhuma linha aparece.
- **Mapa completo:** `fonteOf` cobre todo valor de `LEAD_SOURCES`.
- **Escopo:** vendedor (`own`) recebe só os próprios números e nenhum campo de custo; `all` recebe tudo.
- **Taxa depois da soma:** um caso com dois dias de taxas diferentes prova que o custo por qualificado do período não é a média das taxas diárias.
