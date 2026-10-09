# Dashboard → Marketing

A tela que substitui o cockpit de tráfego. Lê gastos, saldos e desempenho de
tudo o que a empresa paga em marketing: Meta, Google/YouTube, créditos do
Kairogen, a IA do agente (OpenRouter) e os provedores de mídia.

**Nada aqui altera uma conta.** Abrir a tela não chama plataforma nenhuma: os
números vêm das nossas tabelas, espelhadas pelo job de ingestão, e a tela diz
quando foram atualizados. A parte 2 acrescentou a aba de insights e sugestões
da IA (`docs/ads/insights.md`), vereditos por campanha, saúde da conta, canais
próprios e dispositivo/dia × hora; toda sugestão acionável vira pedido pelo
portão de aprovação, como toda alteração.

## O que a ingestão passou a gravar

O job (`ingest-cli`) continua somente leitura. Cada conta ganhou dois passos
depois das métricas por entidade, cada um com o próprio nome em
`AccountCycleResult` para o erro dizer onde parou:

| Passo                | Tabela                       | O que grava                                                                                                                                                                                                                         |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `breakdown:<quebra>` | `ad_metrics_breakdown_daily` | Por campanha e dia, gasto, impressões, cliques, alcance e leads divididos por posicionamento, idade e gênero, região e hora. `key`/`sub_key` são os nomes da plataforma (`instagram`/`reels`, `25-34`/`female`, `São Paulo`, `14`). |
| `account_day`        | `ad_account_daily`           | Uma linha por conta e dia: teto e gasto na plataforma, saldo pré-pago quando ela informa, tipo de pagamento e a soma dos orçamentos diários em vigor nas campanhas ativas.                                                          |

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

| Rota                                 | Aba              |
| ------------------------------------ | ---------------- |
| `GET /ads/dashboard/overview`        | Visão geral      |
| `GET /ads/dashboard/platforms?days=` | Por plataforma   |
| `GET /ads/dashboard/campaigns?days=` | Campanhas        |
| `GET /ads/dashboard/creatives?days=` | Criativos        |
| `GET /ads/dashboard/audience?days=`  | Público e região |

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
sem credencial diz "não configurado" em vez de mostrar zeros. Com a trava de
segurança acionada, a faixa diz quando (o evento `kill_switch_engaged` do
guardião), o motivo que ele escreveu, qual regra disparou
(`killSwitchRuleOf`, em `packages/shared`) e como uma pessoa libera
(`ops-cli release-kill-switch`, recusado enquanto houver alteração com
resultado desconhecido; ver `docs/ads/travas.md`).

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
  numérico para ele. `device_platform` confirmado em 2026-09-23: `mobile_app`
  veio certo em toda linha vista até agora (`desktop` e `mobile_web` ainda
  não apareceram nesta conta).
- **Google:** todas as consultas de quebra (`segments.ad_network_type`,
  `segments.hour`, `age_range_view`, `gender_view`, `geographic_view` com
  `segments.geo_target_region`). O YouTube não tem ThruPlay: a coluna usa a
  visualização até o fim. `segments.device` confirmado em 2026-09-23: `MOBILE`
  e `DESKTOP` vieram certos, já em minúsculas (`TABLET`/`CONNECTED_TV`/`OTHER`
  ainda não apareceram nesta conta). As métricas de vídeo
  (`metrics.video_views`, `video_quartile_p*_rate`) são recusadas por esta
  versão da API (`57140df`): o campo vira "não disponível" com aviso, e o
  ciclo segue.

Os testes cobrem tudo isso contra `FakeMetaClient`, `fakeGoogleApi` e um
banco descartável; nenhum chama plataforma alguma.

### Primeira rodada real (22/09/2026): decimais, timeout e campos de vídeo

Três coisas que só a Meta e o Google de verdade mostraram, corrigidas em
`fix/ingest-live-2`:

- **Gasto das quebras com mais de dois decimais** ("1.67832"): o parser só
  aceitava centavos e derrubava a conta em `breakdown:placement`. Agora aceita
  qualquer decimal e arredonda para o centavo (`centsFromDecimalCurrencyString`).
- **Passo `ads` com timeout**: a listagem de anúncios expande o criativo (com
  `object_story_spec`) e usava o timeout padrão de 15 s com páginas de 25. Passou
  a 45 s (o mesmo dos insights) e páginas de 50 (`ADS_LIST_TIMEOUT_MS`,
  `ADS_PAGE_SIZE`).
- **Google: "Unrecognized field in the query: 'metrics.video_views'"** em
  `campaign`. A leitura diária tenta os campos de vídeo uma vez; se a API
  responder campo desconhecido, o cliente marca vídeo como não disponível para
  a conta (plays e quartis zerados), registra um aviso (`drainWarnings`, impresso
  pelo job como `AVISO:` e devolvido em `IngestResult.warnings`) e refaz a
  leitura só com os campos de dinheiro. Nenhuma outra falha é engolida. Qual
  campo de vídeo esta versão aceita em `campaign` continua **não verificado**;
  o log da próxima rodada diz.

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

## As abas da parte 2

- **Insights e sugestões** (`?aba=insights`): cartões gerados pela IA toda
  segunda às 7h e por "Gerar agora", cada um com título, o que os números
  mostram, sugestão, impacto estimado, confiança e "O que consultei"; ação
  acionável ganha "Criar pedido" (portão de aprovação, "sugerido pela IA"),
  as demais "Marcar como visto"; histórico com data e o que foi feito. Abaixo,
  "Sugestões de novas campanhas" com "Abrir no construtor" (preenche o
  construtor do studio pela `sessionStorage`; nada é lançado). Ver
  `docs/ads/insights.md`.
- **Canais próprios** (`?aba=canais-proprios`): posts do blog no período, do
  espelho `site_blog_posts`; lugar reservado para a publicação social.
- **Configurações** (`?aba=configuracoes`): meta de CPL (leads) e CPC
  (tráfego), proposta a partir do histórico e confirmada por uma pessoa, e a
  legenda de como o veredito é calculado.
- **Campanhas** ganhou a coluna Veredito; **Visão geral**, a saúde da conta e
  o estado da ingestão no cabeçalho; **Público e região**, o painel de
  dispositivo e o mapa dia × hora.

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

| Item                       | De onde vem                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
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

**Meta por conta (28/09/2026, migração 0039).** `marketing_account_cpl_targets`
guarda a meta de CPL de leads de cada conta, e ela vale antes da meta por
objetivo: CPL de Meta e de Google não se comparam. Configurações mostra uma
linha por conta com a sugestão já no campo: R$ 85,90 na Meta e nenhuma no
Google, até ele ter conversões confiáveis (`ACCOUNT_CPL_SUGGESTION`). A
sugestão não conta para nada até alguém clicar em "Confirmar" (`PUT
/ads/dashboard/settings/account-cpl-target`, `ads.request`, auditoria
`ads.account_cpl_target_set`). A campanha traz `targetCplCents`, a meta que o
veredito usou.

### Campanhas criadas pelo sistema: pedidos pela aba Campanhas

Cada campanha traz `systemCreated` (um rascunho executado aponta para ela), o
período do rascunho (`startDate`/`endDate`) e `accountExternalId`. Nas criadas
pelo sistema, quem tem `ads.request` vê "Pausar" (se está ativa), "Retomar" (se
está pausada) e "Mudar verba diária" (se a verba é da campanha). Cada botão
pede motivo e registra um pedido em `POST /ads/change-requests`, o mesmo da
tela de aprovação: nada vai à plataforma daqui. O pedido passa pela aprovação
e pelo clique em Executar como qualquer outro. Campanha feita à mão não tem
botão: muda-se na plataforma.

### Correções de 28/09/2026: previsto, ordem, Google em Criativos, "dados até"

- **Previsto para o mês (Meta e Google)**: deixou de ser o ritmo passado
  projetado em linha reta. Agora é o gasto real (o da reconciliação), mais o
  que falta da verba de hoje, mais a verba diária de cada campanha ativa
  (a da campanha, ou a soma dos conjuntos ativos no ABO) em cada dia que
  resta no mês, parando na data de fim da campanha. A regra aparece escrita
  embaixo do número (`forecastRule`). A sobreentrega da plataforma não entra.
  Kairogen, IA e provedores continuam em linha reta.
- **Datas das campanhas** (migração 0040): `ad_campaigns.start_date` e
  `end_date`, lidas da Meta (`start_time`/`stop_time`, ou `created_time` na
  falta de início) e do Google (`campaign.start_date`/`end_date` na v22; o
  2037-12-30 do Google vira "sem fim"). A aba Campanhas vem da mais recente
  para a mais antiga pelo início, com a opção de inverter ou ordenar por
  gasto. A campanha Search de 28/09 sumia porque a ordem era por gasto e ela
  tinha R$ 0 entre mais de 90 campanhas.
- **Google em Criativos**: `listAds` do Google lê os anúncios responsivos de
  pesquisa (títulos, descrições, status de aprovação) e `getInsights('ad')`
  traz o dia de cada anúncio. O formato novo é "Texto (pesquisa)". São duas
  leituras a mais por ingestão completa: 17 por hora mais 5 por reconciliação,
  cerca de 890 operações por dia contra o limite de 2.880 do acesso Exploração.
- **Dados até / Atualizar agora**: o topo de todas as abas diz até quando vão
  os dados (fim da última ingestão completa que terminou bem) e, para quem tem
  `ads.reconcile.manual`, oferece "Atualizar agora": a mesma reconciliação
  manual do Construtor, conta por conta, com a mesma espera mínima do
  servidor. Atualiza gasto, saldo e status; métricas e criativos chegam na
  coleta de hora em hora.

### Bloco B (28/09/2026): vídeo por anúncio, Site (GA4) e Funil

- **Vídeo (migração 0041)**: a Meta passa a enviar `video_play_actions` e
  `video_avg_time_watched_actions` na mesma leitura. O dia fica guardado como
  inícios (`video_starts`) e milissegundos assistidos no total (média × inícios,
  `video_watch_ms`), então a média de um período é total ÷ inícios, nunca média
  de médias. Criativos mostra Tempo médio, ThruPlays e 25 · 50 · 75 · 100% dos
  inícios. Não verificado ao vivo: o campo de tempo médio por anúncio nesta conta.
- **Site (GA4) (migração 0042, `ga4_traffic_daily`)**: a coleta de hora em hora
  lê a Data API (`lib/ga4.ts`, escopo analytics.readonly) e guarda sessões,
  sessões engajadas, tempo de engajamento, páginas e eventos-chave por dia,
  origem, mídia e campanha. Precisa de `GA4_PROPERTY_ID` (o número da
  propriedade, não o G-…; a da Wings é **395271354**, "GA4 - Wings Company
  2k23") e `GA4_REFRESH_TOKEN`. A organização wingscompany.com.br bloqueia
  chaves de conta de serviço (`iam.disableServiceAccountKeyCreation`), então a
  leitura usa OAuth de usuário como o Google Ads: o mesmo client
  (`GOOGLE_ADS_CLIENT_ID`/`SECRET`) e um refresh token que uma conta com acesso
  à propriedade concede uma vez no navegador, só com o escopo
  analytics.readonly. Se a coleta disser `auth_failed (400 invalid_grant)`, o
  consentimento foi revogado ou expirou e precisa ser dado de novo. O site hoje só carrega **G-C10F4NPBF0** (pelo
  GTM-MXJLC5HH, em todas as páginas conferidas em 28/09); G-Q0TCG8R502 não
  aparece mais no HTML nem nos scripts. Nada foi verificado contra o GA4 real.
- **Funil (`rd_crm_deals`)**: a coleta copia do RD Station CRM as negociações
  dos últimos 90 dias com etapa, ganho, datas e as etiquetas de origem e
  campanha do RD, sem nome, e-mail ou telefone. Cada campanha vai de
  impressão a clique, sessão (GA4, casada pela utm_campaign do rascunho ou pelo
  nome da campanha) e lead da plataforma; cada plataforma vai até leads no CRM,
  reuniões e vendas, com o custo de cada etapa. O CRM para na plataforma porque
  as negociações do RD não trazem a campanha de anúncio, só as etiquetas do RD
  ("Busca Paga | Facebook Ads", "META ADS"); uma etiqueta que não diz a
  plataforma fica de fora e é contada à parte. Reunião = etapa "Reunião
  realizada" ou depois, ou venda; o RD não guarda histórico, então uma perdida
  depois da reunião não conta.

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

- Leitura do pixel (`last_fired_time` com este token) e de
  `conversion_action` no Google.
- Listagem de posts do WordPress com `_fields` e `date_gmt`/`modified_gmt`.

Quebra por dispositivo confirmada em staging em 2026-09-23:
`device_platform` (Meta) devolveu `mobile_app`; `segments.device` (Google)
devolveu `MOBILE` e `DESKTOP`, já minúsculos pelo código. Os demais valores
possíveis de cada enum ainda não apareceram nesta conta (sem gasto nesses
posicionamentos na janela olhada).

Os testes cobrem tudo contra `FakeMetaClient`, `fakeGoogleApi`, `fetch`
roteirizado para o WordPress e banco descartável
(`dashboard/routes.test.ts`, `dashboard/setup.test.ts`, `breakdowns.test.ts`,
`site/blog-sync.test.ts`, `lib/cron.test.ts`).

## Bloco C (28/09/2026): Cockpit e Leads das Campanhas

### Cockpit: só o que está entregando

- Uma campanha conta quando está entregando de fato: Meta `effective_status`
  ACTIVE; Google `status` ENABLED **e** `serving_status` SERVING; e a data de
  fim ainda não passou (`campaignDelivering`, em `packages/shared`). O status
  de entrega vem de cada reconciliação (`ad_campaigns.delivery_status`,
  migração 0043). Antes da primeira leitura, vale o status ligado.
  O aviso do filtro diz as duas contas: "2 de 4 com status ativo; 2 encerradas
  em 05/10" (`statusSummary`): o status ativo que uma pessoa pôs contra o que
  entrega de fato. Ao lado dos dois "Investimento" sai a hora da última
  leitura das plataformas (`spendReadAt`, o maior `ad_metrics_daily.fetched_at`
  das campanhas somadas); o gasto de hoje cresce a cada leitura.
- Anúncios ligados que não rodam (em análise, em processamento, reprovados)
  aparecem só como aviso, fora de todos os números e do ranking.
- Alertas: só os da conta ou das campanhas ativas (e dos conjuntos e anúncios
  delas).
- Negócios de teste (motivo de perda ou título com "teste") não contam em
  nenhum número: `rd_crm_deals.is_test` e `campaign_leads.is_test` (0044).
- **Performance ativa desde 28/09**: gasto das campanhas ativas desde
  28/09 e os leads do RD delas (os mesmos de Leads das Campanhas): CPL, custo
  por lead qualificado (ganho, ou no pipeline Formatação em "Identificação de
  interesse" ou depois), CAC e ROAS só com venda "Ganho". Menos de 10 leads:
  selo "Amostra pequena".

### Leads das Campanhas (`/dashboard/leads-campanhas`)

- **Quem vê**: `campaign_leads.read`/`campaign_leads.reveal`. Diretoria,
  Gerente Comercial e Admin Master veem todos; Vendedor Formatação só os que o
  RD atribui a ele (dono do negócio no RD com o mesmo e-mail do cadastro);
  Vendedor Expansão e Marketing não veem.
- **Escopo**: negócios do Funil Formatação (e dos pipelines "perdidos" /
  "vendidos" de Formatação) criados desde 28/09/2026 00:00 (Brasília).
- **Conferência a cada 15 min**: roda junto de `ingest-cli --reconcile-only`,
  depois da reconciliação. Só lê o RD CRM e o RD Marketing. O log mostra só
  contagens.
- **Atribuição**, nesta ordem (`attribute`, em `campaign-leads-sync.ts`):
  (0) quem chegou **antes de 28/09** (`leads.entered_at`, a chegada real, e não
  o dia em que o negócio nasceu no RD) fica **fora da conta**: motivo
  `arrived_before_cutoff` ("Chegou antes de 28/09"), listado em "Sem atribuição,
  por motivo", mas em nenhum total nem porcentagem (como o teste); são os leads
  antigos da Meta copiados ao RD em 05 e 06/10; (1) o **lead do Wings** atrás do
  negócio (`leads.rd_deal_id`) diz a campanha e o anúncio
  (`ad_campaign_external_id`, `ad_external_id`): é o caminho do formulário
  instantâneo da Meta, que não tem UTM; método `lead_ads`; sem a campanha no
  cadastro, motivo `lead_ads_campaign_unknown`; (2) UTMs da conversão do contato
  no RD Marketing (`traffic_source` é `encoded_` + base64 com a URL de entrada),
  consultadas uma vez por lead; `utm_campaign` casa com o id, o nome, a UTM do
  rascunho, a UTM estática das `url_tags` dos anúncios ou um **trecho do nome**
  (`formatacao_videos_thais_out26` dentro de "META | IG | Formatação | Vídeos
  Thais | Out26", com 12 letras ou mais e uma só campanha); se o texto não casa,
  `utm_content` com o id ou o nome longo (10 caracteres ou mais) de um anúncio
  de uma só campanha; (3) a origem do RD ("Busca Paga | Facebook" / "| Google")
  quando a plataforma tem uma única campanha; (4) senão, sem atribuição, com o
  motivo (`UNATTRIBUTED_REASONS`).
  **"Em vigor" é julgado no dia da entrada do negócio**, e não no dia da
  conferência: a campanha vale se estava dentro das datas de início e fim e
  entregava (ou gastou no dia ou na véspera, por `ad_metrics_daily`). Um lead
  atribuído guarda a campanha mesmo depois que ela termina; um sem atribuição é
  julgado de novo a cada conferência.
- **Plataforma do negócio** (`platformOfRdLabels`): a **origem** do RD manda
  ("Busca Paga | Google"); a campanha do RD é texto livre e só decide quando a
  origem não diz a plataforma (havia negócios do Google com campanha "Meta -
  Formatação").
- **Primeiro contato**: a primeira anotação ou tarefa concluída no RD; sem
  isso, a saída de "Sem contato" como a conferência viu (precisão de 15 min).
- **Temperatura**: estrelas do RD (1–2 Frio, 3 Morno, 4–5 Quente).
- **Dados pessoais**: nome em texto; telefone e e-mail só cifrados
  (AES-256-GCM sob `CPF_ENCRYPTION_KEY`) mais a máscara. "Revelar" é POST e
  grava `campaign_lead.revealed` na auditoria (quem, qual lead, qual campo).
  Nada pessoal vai para log. **Não dar `select` em `campaign_leads` ao
  `wings_ro`**: a tabela tem dados pessoais.
- **Webhook de conversão do RD**: ainda não. Por enquanto só a conferência de
  15 min.

Não verificado ao vivo: o formato de `traffic_source` com UTMs de um lead
real de campanha (só o de uma conversão orgânica foi visto), `/tasks` com
tarefa concluída e `organization` preenchido em um negócio.

### Cockpit: visual grafite (aprovado pelo Eric em 28/09/2026)

Substitui a proposta neon, que foi revertida (b1e244b). Mesma estrutura da
aba, outro estilo: fundo grafite (#2b2f36 → #1f2227), cartões #343942 com
borda sutil e cantos de 10 px, texto branco e rótulos cinza-claro.

- "Performance ativa" no topo (8 cartões em uma linha, ou 4, ou 2 conforme a
  largura) e os KPIs do período abaixo, com os mesmos cálculos.
- Evolução diária: áreas com linha laranja #ff5a1f e degradê para
  transparente; o período anterior em cinza tracejado. Um gráfico sem nenhum
  valor nos dois períodos vira "—" com o motivo.
- Funil: barras do vinho ao laranja (#7a1f1f → #ff5a1f), número à direita e,
  em cinza abaixo, o custo por etapa (gasto ÷ quantidade).
- Onde o dinheiro foi: mapa do Brasil com os contornos das UFs da malha
  pública do IBGE (`apps/web/src/components/dashboard/brazil-map.ts`, baixada
  uma vez; a tela não chama o IBGE). Estados sem gasto em cinza-claro, com
  gasto em laranja a vermelho com brilho, e um balão no estado de maior gasto
  ("RJ R$ 75,82 · 0 lead(s)").
- Criativos e alertas no mesmo estilo; alerta com borda esquerda âmbar.
- **Seletor "Campanhas: Só ativas | Todas"** ao lado do período, só na aba
  Cockpit, guardado na URL (`?campanhas=ativas|todas`, padrão ativas). Em
  "Todas" o Cockpit soma também as campanhas pausadas ou encerradas que
  entregaram na janela atual ou na anterior, e as marca na faixa do topo; os
  criativos passam a ser todos os anúncios delas que entregaram. "Performance
  ativa" fica sempre nas campanhas ativas.

## Cockpit: seletor de campanha

Ao lado de "Campanhas: Só ativas | Todas", o seletor **Campanha** escolhe uma ou mais
campanhas do modo em vigor. Sem escolha vale o modo inteiro ("Todas as ativas" ou
"Todas"). A escolha vai no endereço, `?campanha=id1,id2` (ids das nossas campanhas,
os mesmos de `campaignOptions` na resposta), então o link pode ser compartilhado.

`GET /ads/dashboard/cockpit?days=&campanhas=&campanha=` estreita **todos** os blocos: cartões,
evolução diária, funil, mapa, criativos, anúncios que não rodam, alertas e a Performance
ativa. O que o RD não separa por campanha aparece como "—" com o motivo em
`selection.why`, nunca com o número do site inteiro:

| Cartão | Com campanhas escolhidas |
| --- | --- |
| Sessões no site | "—": o GA4 não separa por campanha |
| Leads no CRM e Vendas | leads atribuídos às campanhas (`campaign_leads`, desde 28/09); "—" se a janela toda é anterior a 28/09 |
| Reuniões | "—": o RD não atribui reuniões a uma campanha |
| Alertas | só os de campanha, conjunto ou anúncio escolhidos (os da conta somem) |

Um id que não é campanha do modo é ignorado e contado em `selection.unknown`.
