# Dashboard → Marketing (parte 1)

A tela que substitui o cockpit de tráfego. Lê gastos, saldos e desempenho de
tudo o que a empresa paga em marketing: Meta, Google/YouTube, créditos do
Kairogen, a IA do agente (OpenRouter) e os provedores de mídia.

**Nada aqui altera uma conta.** Abrir a tela não chama plataforma nenhuma: os
números vêm das nossas tabelas, espelhadas pelo job de ingestão, e a tela diz
quando foram atualizados. A parte 2 (insights e sugestões da IA, canais
próprios) vai criar pedidos pelo portão de aprovação, como toda alteração.

## O que a ingestão passou a gravar

O job (`ingest-cli`) continua somente leitura. Cada conta ganhou dois passos
depois das métricas por entidade, cada um com o próprio nome em
`AccountCycleResult` para o erro dizer onde parou:

| Passo                 | Tabela                       | O que grava                                                                                                                                                                            |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `breakdown:<quebra>`  | `ad_metrics_breakdown_daily` | Por campanha e dia, gasto, impressões, cliques, alcance e leads divididos por posicionamento, idade e gênero, região e hora. `key`/`sub_key` são os nomes da plataforma (`instagram`/`reels`, `25-34`/`female`, `São Paulo`, `14`). |
| `account_day`         | `ad_account_daily`           | Uma linha por conta e dia: teto e gasto na plataforma, saldo pré-pago quando ela informa, tipo de pagamento e a soma dos orçamentos diários em vigor nas campanhas ativas.               |

E as linhas de `ad_metrics_daily` ganharam vídeo: plays de 3 s (a ação
`video_view` da Meta), ThruPlays e os quatro quartis. `ad_creatives` ganhou
`format` (`image`, `video`, `carousel`, `unknown`), lido do `object_type` e do
`object_story_spec` do criativo, nunca adivinhado pelo nome.

As quebras ficam no nível de campanha, de propósito. Na Meta, cada quebra é
uma agregação separada sobre todas as campanhas, e o nível de anúncio já
precisa de janelas de um dia para responder (`INSIGHT_WINDOW_DAYS`). Quatro
quebras por anúncio seriam quatro vezes o custo que já quase estoura o tempo.

### O orçamento vigente de cada dia

A plataforma só informa o orçamento e o saldo **de agora**. Por isso cada dia
guarda o que estava em vigor quando o job rodou: `daily_budget_cents` em cada
linha de métrica (já existia) e `active_daily_budget_cents` em
`ad_account_daily` (novo). Um dia fechado nunca é reescrito; só o dia corrente
é corrigido a cada ciclo. Sem isso, "quanto tinha na conta no dia 10?" não
tem resposta a partir do dia 11.

## Modelo e consultas

Não há tabela agregada: as somas são calculadas na leitura, a partir das
linhas diárias, para que uma janela seja sempre coerente consigo mesma. O que
mantém isso barato é o índice `ad_metrics_daily_account_level_day_idx`
(conta, nível, dia), que é exatamente o que cada soma percorre, mais
`ad_metrics_breakdown_daily_account_kind_day_idx` para as quebras. Com 84
campanhas e 660 anúncios são algumas centenas de milhares de linhas por ano,
longe de precisar de materialização.

Razões (CTR, CPC, CPM, CPL, frequência, gancho, retenção) são derivadas em
`ratiosOf` (`packages/shared`) e nunca gravadas. Denominador zero é `null`,
que a tela mostra como "—": **um CPL vazio quer dizer "sem leads", e nunca
R$ 0,00**. Alcance e frequência somam dias e campanhas, então a frequência
de um período é um piso, não o número da plataforma; a tela avisa.

## As rotas

Todas exigem `ads.read` e só leem.

| Rota                                  | Aba                 |
| ------------------------------------- | ------------------- |
| `GET /ads/dashboard/overview`         | Visão geral         |
| `GET /ads/dashboard/platforms?days=`  | Por plataforma      |
| `GET /ads/dashboard/campaigns?days=`  | Campanhas           |
| `GET /ads/dashboard/creatives?days=`  | Criativos           |
| `GET /ads/dashboard/audience?days=`   | Público e região    |

`days` aceita 7, 14, 30 ou 90; outro valor é 400. A janela termina hoje em
São Paulo e o período anterior tem o mesmo tamanho, imediatamente antes.

## A tela

A aba e o período ficam no endereço (`?aba=criativos&dias=30`), então uma
visão pode ser mandada como link.

**Visão geral.** Uma faixa por fonte de gasto, todas no mesmo eixo de dias:
gasto no mês, previsto (projeção linear do gasto até o fim do mês; vazio no
dia 1), disponível (a menor folga entre teto interno, parcela utilizável e o
que a plataforma permite, do `budget-guard`), saldo na conta, teto do mês,
barra do mês com marcador de previsão e colunas diárias com a linha do
orçamento diário ativo. Meta e Google nunca se somam: cada conta é o próprio
teto. Kairogen conta em créditos contra `KAIROGEN_MONTHLY_CREDITS`, com o
último `get_credits` registrado como saldo. A IA soma `agent_messages.
cost_micro_usd` convertido por `BRL_PER_USD`; não tem teto mensal, só o
diário por pessoa (`AGENT_DAILY_USD`), mostrado como linha. Provedores de
mídia somam `brl_cents_delta` do ledger contra `MEDIA_MONTHLY_BRL`. Uma fonte
sem credencial diz "não configurado" em vez de mostrar zeros.

**Por plataforma.** Gasto por dia das duas plataformas numa linha e a tabela
com as dez métricas, cada uma com a variação contra o período anterior. A
tabela é a gêmea do gráfico: todo número da linha está numa célula.

**Campanhas.** Uma tabela, três níveis: a campanha abre nos conjuntos, o
conjunto nos anúncios, todos nas mesmas colunas. Filtro pelo nome. No Google
não há conjuntos espelhados, então a campanha é a folha.

**Criativos.** Ranking por formato e a lista de anúncios que entregaram, com
o funil de vídeo (gancho = plays de 3 s por impressão; retenção = ThruPlays
por play; até o fim = p100 por play) e o sinal de desgaste: CTR da segunda
metade do período caiu 20% ou mais em relação à primeira, com frequência
acima de 2 (`fatigueOf`, em `packages/shared`, a mesma regra na API e na
tela). Gancho e retenção ficam vazios em anúncio sem play.

**Público e região.** Cada quebra como lista ordenada por gasto com o CPL ao
lado (ou o CTR, quando não houve lead), e as horas como colunas. Idade e
gênero são lidos um lado por vez, porque o Google os informa separados e a
Meta cruzados: as linhas do Google vêm com `all` do lado que ele não dividiu.

Todas as abas exportam CSV (ponto e vírgula, vírgula decimal, BOM para o
Excel abrir os acentos), com dinheiro em reais e "—" como célula vazia.

## Gráficos

SVG desenhado em `components/dashboard/charts.tsx`, sem biblioteca. Colunas de
no máximo 24 px com a ponta arredondada, linhas de 2 px com lavagem de 10%,
grade em fio de cabelo, tooltip por dia e alvo de clique do tamanho do slot.
A cor segue a fonte de gasto, nunca a posição: Meta azul, Google verde-água,
Kairogen amarelo, IA magenta, mídia violeta (`--viz-*` no `index.css`),
paleta validada para daltonismo sobre a superfície `#121212`. O laranja da
Wings fica para ações e seleção.

## Não verificado contra as plataformas reais

Marcado no código com "NOT verified live". O primeiro ciclo de ingestão em
staging diz o que a API respondeu; o job para na etapa com nome
(`breakdown:region`, `account_day`) e as outras contas seguem.

- **Meta:** que `object_story_spec` seja legível em todo criativo com o token
  de leitura; que os cinco campos de vídeo venham no nível de anúncio; os
  nomes exatos que a Meta devolve em `publisher_platform`,
  `platform_position` e `region` nesta conta; `funding_source_details.type`
  (a tabela de códigos em `fundingKindOf` é a documentada) e a leitura do
  saldo pré-pago a partir do `display_string`, porque a Meta não tem campo
  numérico para ele.
- **Google:** todas as consultas de quebra (`segments.ad_network_type`,
  `segments.hour`, `age_range_view`, `gender_view`, `geographic_view` com
  `segments.geo_target_region`) e as métricas de vídeo
  (`metrics.video_views`, `video_quartile_p*_rate`). O YouTube não tem
  ThruPlay: a coluna usa a visualização até o fim.

Os testes cobrem tudo isso contra `FakeMetaClient`, `fakeGoogleApi` e um
banco descartável; nenhum chama plataforma alguma.

### O que o token não pode ler vira "não disponível" (22/09/2026)

No staging a tarefa `ads-ingest` passou a falhar em segundos com
`meta:act_… FALHOU em reconcile: (#10) Permission Denied`: o token de leitura
não tem permissão para `funding_source_details`, e o pedido único que juntava
os campos de saldo aos de dinheiro derrubava a conta inteira, antes de
reconciliar (`tetos-reais.md` já registrava a recusa). Agora `getAccount` faz
duas leituras: primeiro `spend_cap`, `amount_spent` e moeda, de que a
reconciliação e o guardião dependem; depois os campos de pagamento. Permissão
negada nesses vira `funding_kind = 'unavailable'` em `ad_account_daily`, com
saldo vazio e um `AVISO` no log do job; a conta e o ciclo seguem. O mesmo para
qualquer quebra que responder `(#10)`: fica marcada `unavailable` no resultado
do ciclo, com aviso, e as outras quebras, o dia da conta e os alertas rodam.
Um erro que não é de permissão (timeout, token inválido) continua derrubando a
conta na etapa com nome. Testes: `meta-client-dashboard.test.ts` (fetch
roteirizado respondendo 403 `#10`) e `ingest-cycle.test.ts` (fake negando o
saldo e cada quebra).

## Fica para a parte 2

Insights e sugestões da IA (verba ideal, perfil de cliente, região, formatos,
horários) com "Criar pedido", e Canais próprios. Toda sugestão vira pedido
pelo portão de aprovação; nada muda sozinho.

## Parte 2 — ingestão, saúde e vereditos

Lado da API do que a parte 2 acrescentou fora da IA (a IA está em
`docs/ads/insights.md`). Continua valendo a regra: nada aqui chama plataforma
a partir de uma tela; tudo é lido das nossas tabelas, gravadas pelo job.

### O que os prints do staging mostraram, e o que mudou

- **Google "não configurado" com a conta conectada.** Em `ad_accounts` do
  staging só há as duas contas da Meta; a conta do Google **nunca foi semeada**
  na ingestão, e a faixa dizia "não configurado" porque olhava para linhas de
  conta, não para credenciais. Agora `configured` segue as credenciais do
  ambiente (`hasPlatformCredentials`, em `platform/factory.ts`) e a faixa
  ganhou `setupNote`, que diz o que falta: "Credenciais configuradas, mas a
  conta ainda não foi semeada na ingestão: `ingest-cli --seed --platform
  google --account <GOOGLE_ADS_CUSTOMER_ID> --name "…" --cap <centavos>
  --usable 70`" e, depois de semear, "Conta semeada; a primeira ingestão ainda
  não gravou o dia da conta." Semear é uma decisão de quem administra o teto
  (R$ 4.000 por conta, por padrão), então o sistema não semeia sozinho.
- **"Atualizados há 2 dias".** A última ingestão registrada no staging foi em
  19/09 às 15:00 (São Paulo); antes dela, 18/09 às 11:03, 11:33 e 20:00.
  Horários irregulares e nada depois: **a tarefa agendada do Coolify não está
  disparando**, e as rodadas vistas foram manuais. O Coolify não é lido por
  esta API, então quem administra confere lá a tarefa e o cron dela.
  Para a tela nunca mais ficar em dúvida: o job grava cada rodada em
  `ingest_runs` (`ingest-runs.ts`: início, fim, `ok`/`failed`, cada conta com
  o passo em que falhou, e o passo do blog), e a API lê `ADS_INGEST_CRON`, o
  cron com que a tarefa foi agendada (5 campos, horário de São Paulo, só
  informa; `lib/cron.ts` calcula a próxima e a anterior). O `overview` devolve
  `ingestion`: última rodada e estado, falhas por conta e passo, próxima
  rodada e `overdue` quando o horário agendado passou há mais de 15 minutos
  sem rodada registrada. Sem `ingest_runs` ainda (primeiro deploy), vale o
  `max(fetched_at)` de `ad_metrics_daily`. Um `ingest-cli --manual` registra
  a rodada como manual.

### Saúde da conta (`dashboard/health.ts`)

Quatro perguntas por conta paga, cada uma com estado (`ok`, `attention`,
`problem`, `unknown`), o que os números mostram e o que fazer:

| Item                       | De onde vem                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Conversões medindo         | `ad_account_daily.conversion_sources` (pixel da Meta, ações de conversão do Google) + leads dos últimos 3 dias |
| Criativos desgastados      | `fatigueOf` em 14 dias + alertas `creative_fatigue` abertos                                                    |
| Ritmo de gasto             | `pacingFacts`: desvio contra a linha do mês (< 20% ok, < 40% atenção, acima problema)                          |
| Ativas sem resultado (7 d) | campanhas ACTIVE de leads com gasto e zero leads nos últimos 7 dias                                            |

`conversion_sources` é um passo novo de `recordAccountDay`, **não fatal**: a
leitura que falha grava `null` e a linha do dia sai do mesmo jeito. Meta lê
`GET /{META_PIXEL_ID}?fields=id,name,last_fired_time,is_unavailable` (ativo se
disparou em 7 dias); Google lê `conversion_action` (ativo se `ENABLED`; o
relatório não diz quando disparou).

### Vereditos e metas

`campaigns()` devolve `verdict` em cada campanha, calculado por
`dashboard/verdicts.ts` com a regra de `packages/shared/src/ads/verdicts.ts`:
CPL contra a meta, CTR contra a mediana da conta em 90 dias, tendência de 7
dias contra os 7 anteriores, frequência e ritmo contra 7 × o orçamento diário.
Campanha de leads sem meta confirmada é "Sem meta". As metas ficam em
`marketing_cpl_targets` (`GET /ads/dashboard/settings`, `PUT
/ads/dashboard/settings/cpl-target` com `ads.request`, auditoria
`ads.cpl_target_set`); o histórico de 90 dias propõe um valor com a base
escrita, e só a confirmação de uma pessoa o grava.

### Dispositivo e dia × hora

`ad_breakdown_kind` ganhou `device` (Meta: `device_platform`; Google:
`segments.device`). O mapa dia da semana × hora (`audience().heatmap`) não
precisa de ingestão nova: é o `extract(dow from day)` das linhas por hora.

### Canais próprios: o blog espelhado

O job passou a espelhar os posts publicados do WordPress em `site_blog_posts`
(`site/blog-sync.ts`, só `GET /wp/v2/posts` e `/categories`), passo não fatal
da mesma rodada. `GET /marketing/site/blog-posts?days=` lê o espelho e nunca o
site. (`GET /marketing/site/posts` continua sendo a lista de rascunhos que o
studio enviou.)

### Leitura no staging

As tabelas novas não herdam o grant do usuário somente-leitura:

```sql
grant select on ingest_runs, marketing_insight_runs, marketing_insights,
  marketing_campaign_suggestions, marketing_cpl_targets, site_blog_posts to wings_ro;
```

### Não verificado contra os serviços reais

- Quebra por dispositivo nas duas plataformas (`device_platform`,
  `segments.device`): nomes exatos que voltam.
- Leitura do pixel (`last_fired_time` com este token) e de
  `conversion_action` no Google.
- Listagem de posts do WordPress com `_fields` e `date_gmt`/`modified_gmt`.

Os testes cobrem tudo contra `FakeMetaClient`, `fakeGoogleApi`, `fetch`
roteirizado para o WordPress e banco descartável
(`dashboard/routes.test.ts`, `dashboard/setup.test.ts`, `breakdowns.test.ts`,
`site/blog-sync.test.ts`, `lib/cron.test.ts`).
