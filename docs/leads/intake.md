# Funil Sofia — parte 1: captação e enriquecimento

CRM Vendas → Funil. Todo lead que chega à Wings entra por aqui, com de onde
veio, sob qual base legal e o que a pesquisa pública encontrou sobre ele. A
Sofia (SDR) **não está ligada**: o repasse vem na parte 2. Nada nesta onda
manda mensagem a lead nenhum.

Três regras valem para tudo aqui:

1. **Dado pessoal fica na tabela e só nela.** Nome, e-mail, telefone e a
   primeira mensagem estão em `leads`. Log, auditoria, linha do tempo
   (`lead_events`), ledger e erro de job citam o lead **pelo id** e guardam
   contagens e códigos, nunca um nome. As respostas dos serviços externos são
   registradas como **forma** (nomes de chave e números, `shapeOf`), nunca
   como texto.
2. **Nenhum webhook aceita corpo sem o segredo da sua origem.** Sem a variável
   configurada, a rota responde **503**, nunca um 200 de mentira.
3. **Chamada paga só depois do ledger, e nunca repetida.** A busca web custa
   por consulta; cada consulta é reservada em `lead_enrichment_ledger` sob um
   lock contra o teto do dia (`ENRICH_DAILY_USD`) **antes** de ser feita, e o
   job é de **uma tentativa**: se falhar, a pessoa clica em "Refazer pesquisa".

## Como um lead entra

| Origem            | Rota                                        | Segredo                                   | Cliente vem de                                 | Base legal registrada                 |
| ----------------- | ------------------------------------------- | ----------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| Landing page (RD) | `POST /integrations/rd-station/webhook`     | `RD_STATION_WEBHOOK_SECRET` (header ou `?secret=`) | regra `landing_page` (slug, domínio ou identificador) | consentimento na LP (`legal_bases` do RD, senão `consent`) |
| WhatsApp (link)   | `POST /integrations/zapi/webhook`           | `ZAPI_WEBHOOK_SECRET` (header ou `?secret=`) | o link rastreável cujo código abre a mensagem | diligências pré-contratuais (art. 7º, V): a pessoa escreveu primeiro |
| Meta Lead Ads     | `GET`/`POST /integrations/meta/leadgen/webhook` | `META_APP_SECRET` (assinatura `X-Hub-Signature-256`) e `META_LEADGEN_VERIFY_TOKEN` | regra `meta_form` (id do formulário), senão `meta_campaign` | consentimento no formulário do Meta |
| TikTok Lead Ads   | `POST /integrations/tiktok/leads/webhook` | `TIKTOK_LEADS_WEBHOOK_SECRET` (cabeçalho `X-Wings-Webhook-Secret`, bearer ou `?secret=`) | regra `tiktok_form`, senão `tiktok_campaign` | consentimento no formulário da TikTok (ver `tiktok-lead-ads.md`) |
| Manual            | `POST /leads` (`leads.write`)               | sessão                                    | escolhido na tela                              | escolhida na tela, com "onde e quando" |

> ⚠️ **Qual base legal vale para cada porta é decisão do Jurídico.** O sistema
> registra a base, a data e a origem em cada lead (`legal_basis`,
> `consented_at`, `consent_source`, `consent_text`) para que a resposta seja
> auditável; o que está escrito aqui é a leitura inicial, a confirmar.

O header do segredo compartilhado é `X-Wings-Webhook-Secret`. RD Station e
Z-API não assinam o corpo, por isso o segredo viaja na URL cadastrada neles
(`…/webhook?secret=<valor>`) ou num header, quando o serviço permite.

### O mesmo lead, chegando de novo

`upsertLead` encontra o lead que já existe nesta ordem: mesmo `external_id`
da mesma origem (um webhook reenviado), depois mesmo telefone, depois mesmo
e-mail. Um lead encontrado **só tem as lacunas preenchidas** (nome vazio,
e-mail vazio, perfil do WhatsApp vazio, base legal vazia); nada já gravado é
sobrescrito. Um lead que nenhuma regra tinha mapeado (`client_mapped =
false`) passa a ser do cliente da chegada nova, se ela vier mapeada. Cada
chegada vira uma linha em `lead_events`, com `matched: new | existing` e os
campos preenchidos, e uma em `audit_log` (`lead.received` ou `lead.merged`).

Um lead novo, ou um cujo estado de pesquisa é `none` ou `failed`, ganha um
job `enrich_lead`. Um lead já pesquisado não é pesquisado de novo por chegar
de novo. Exceção: o webhook do RD Station não enfileira a pesquisa num lead
que teve uma chegada pelo formulário do site na última hora
(`RD_ECHO_WINDOW_MS`, decidido dentro da transação do `upsertLead`): é o eco
que o RD faz de cada envio do formulário minutos depois, e a chave desse
formulário é que decide se paga (`SITE_FORM_RESEARCH_ENABLED`). Outra
conversão no RD, mais tarde, pesquisa como sempre.

Pelo **formulário do site**, um lead que já existe há mais de 10 minutos
(`SITE_FORM_RETURN_MIN_AGE_MS`) ainda ganha a tarefa de retorno para o dono e
o aviso no sino, e a resposta nova fica na linha do tempo (`detail.submitted`);
o mesmo formulário enviado duas vezes seguidas só fica na linha do tempo:
[../crm/aviso-lead-novo.md](../crm/aviso-lead-novo.md), "Lead que preenche o
formulário de novo". Dono, funil e etapa não mudam.

### Conversão sem regra

Uma conversão cuja LP ou formulário não bate com regra nenhuma **vira lead
mesmo assim**, arquivada na Wings Company com `client_mapped = false`. A tela
mostra "sem regra" e diz onde cadastrar. Uma regra criada depois não
reprocessa leads antigos (parte 2, se precisar).

Uma exceção: o eco do RD Station CRM. Cada vez que o CRM muda um negócio, o RD Marketing registra
uma conversão no contato ("Negociação atualizada no RD Station CRM", "RD Station CRM"). Isso não é
página nenhuma: de uma pessoa que a Wings ainda não tem (nem por id do RD, telefone ou e-mail) o
webhook responde 200, não cria lead e conta em `ignoredEcho` (`RD_CRM_ECHO_IDENTIFIERS` em
`webhooks.ts`). De uma pessoa que já existe, o eco continua se juntando ao lead dela.

## Data de entrada (`leads.entered_at`)

A ficha, a lista e o kanban mostram "Entrou em", no horário de Brasília, com a data da própria fonte.
`leads.created_at` continua sendo a hora em que a linha foi escrita e não muda. A coluna
`entered_at_source` diz de quem é o relógio (`LEAD_ENTERED_SOURCES` em `packages/shared`):

| Fonte | `entered_at` | `entered_at_source` |
| --- | --- | --- |
| Meta Lead Ads | `created_time` do lead na Meta | `meta_created_time` |
| TikTok Lead Ads | `create_time` do lead | `tiktok_created_time` |
| RD CRM (importação e seguimento) | criação do negócio no RD | `rd_deal_created` |
| Webhook do RD Marketing | data da conversão (`event_timestamp` no corpo CONTACT) | `rd_conversion` |
| Formulário do site ou da `/lp` | hora do envio | `form_submitted` |
| WhatsApp (link rastreável) | hora da primeira mensagem | `whatsapp_message` |
| Google Ads, importação de CSV, criação manual | não trazem data | `received` |

`received` mostra a hora em que o sistema recebeu, com o aviso "recebido pelo sistema". Uma data
no futuro (além de 5 minutos de relógio) ou inválida também vira `received`. Um lead que já existe
nunca tem a data movida por uma chegada posterior. A lista ordena e filtra por `entered_at`
(`createdFrom` e `createdTo` mantêm os nomes, para não quebrar as visões salvas). A migração 0076
copia `created_at` para os leads existentes e marca os do RD CRM como `rd_deal_created`; os da
Meta e do RD Marketing que já existem são preenchidos pelo script `entrada-leads.sh`
(simulação primeiro; na produção, só com PRODUCAO digitado).

## Regras de origem (Administração → Clientes → "Origens de leads")

`lead_source_rules`, mantida por quem tem `clients.manage`. Três tipos:

| Tipo            | Padrão                                                                   | Bate com                                                                                      |
| --------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `landing_page`  | `sushi-do-bairro`, `lp.cliente.com.br`, `lp.cliente.com.br/verao` ou o identificador da conversão do RD | o slug de `franquia.wingscompany.com.br/<slug>`, o host, host + primeiro segmento, o endereço inteiro, ou o `conversion_identifier` |
| `meta_form`     | id numérico do formulário                                                | `form_id` do evento leadgen                                                                   |
| `meta_campaign` | id numérico da campanha                                                  | `campaign_id` lido do Graph API (só quando o formulário não tem regra)                        |

O padrão é normalizado ao salvar (minúsculas, sem `https://`, sem `www.`,
sem `/` final); entre várias regras que batem, vence a mais longa
(`matchSourceRule`, `packages/shared`).

## Links rastreáveis (Administração → Clientes → "Links e expansão")

Um link por cliente e canal (Instagram, site, Linktree, LinkedIn, TikTok):
`https://wa.me/<WINGS_WHATSAPP_NUMBER>?text=<código>`. O código tem 6
caracteres sem 0/O/1/I (`generateTrackingCode`), é único no banco e fica em
`lead_tracking_links` com o número da época, para o link impresso numa bio
continuar explicável se o número mudar.

O resolvedor é o webhook do Z-API: uma mensagem **que começa pelo código**
(`#` inicial e espaços ignorados) etiqueta quem mandou com o cliente e o
canal do link, guarda a primeira mensagem, o nome e a foto de perfil que o
Z-API manda no callback, e incrementa `hits` do link. Mensagem nossa
(`fromMe`), de grupo, sem código ou com código desconhecido é ignorada com
200 e o motivo no corpo (`ignored: not_inbound | no_code | unknown_code |
no_phone`). **Uma mensagem sem código não vira lead nesta parte.**

## Enriquecimento (worker, job `enrich_lead`)

`apps/worker/src/jobs/enrich-lead.ts`. A API enfileira `{ leadId }`; o worker
lê e escreve as tabelas de lead com SQL simples (não conhece o schema da
API) e marca o lead `running` → `done` ou `failed`. Cada passo é protegido
sozinho: um que falha deixa o seu fato vazio e o resto segue.

| Passo            | Serviço                              | Custo             | Quando roda                                                 |
| ---------------- | ------------------------------------ | ----------------- | ----------------------------------------------------------- |
| região           | tabela DDD → cidade principal/UF (`DDD_REGIONS`, `packages/shared`) | 0 | há telefone                                    |
| domínio do e-mail | lista de webmails                   | 0                 | há e-mail                                                   |
| `zapi_profile`   | Z-API `profile-picture` e `contacts` | 0                 | há telefone e o lead ainda não trouxe perfil (leads do WhatsApp já trazem) |
| `web_search`     | Brave Search, 2 consultas: `"nome" cidade UF linkedin` e `… instagram` | `ENRICH_SEARCH_USD_PER_QUERY` cada (padrão US$ 0,005) | há nome com 3+ caracteres e a chave está configurada |
| `web_search` (cnpj) | Brave, `"dominio" cnpj`           | idem              | nenhum CNPJ apareceu nos resultados e o e-mail é de domínio próprio |
| `brasilapi_cnpj` | BrasilAPI `/api/cnpj/v1/<cnpj>`, até 2 candidatos | 0    | apareceu um CNPJ em algum resultado                         |

A consulta leva **só o nome da pessoa e a região do DDD**: o nome do cliente
não entra em pedido nenhum. Um resultado só conta como "perfil encontrado" se
o título ou o trecho **citam o nome do lead** (primeiro e último nome,
`nameMatches`); um LinkedIn de outra pessoa é ruído, não achado. Uma empresa
só fica ligada ao lead se ele **consta no QSA** ou se o **domínio do e-mail**
aparece na razão social ou no nome fantasia, e só se está ATIVA.

### Teto e ledger

`lead_enrichment_ledger` é append-only. Antes de cada consulta paga,
`reserveSpend` abre uma transação, toma `pg_advisory_xact_lock`, soma o dia
(00:00 em São Paulo) e grava a linha `started` com o custo, ou `refused`
com 0 se o teto seria ultrapassado; a chamada é feita **uma vez** depois do
commit, e uma linha `done` ou `failed` (custo 0) fecha o passo. Uma busca que
falha **mantém** o custo reservado: a chamada foi feita, cobrou o que cobrou.
O dia é a soma de todos os leads, de toda a empresa. A tela mostra o custo de
cada lead em dólares.

### Nota e resumo

`franchiseeScoreOf` (`packages/shared`), 0–100, três critérios com os
porquês na tela:

| Critério                    | Máx. | Pontos                                                                                     |
| --------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| Capital provável            | 40   | sócio de empresa ativa +15; capital social ≥ R$ 100 mil +15 (≥ R$ 30 mil +8); e-mail em domínio próprio +10 |
| Experiência em gestão       | 30   | LinkedIn público +5; cargo de gestão citado num resultado +15; sócio/administrador +10     |
| Cidade na área de expansão  | 30   | cidade do DDD está na área +30; só o estado +15; fora 0                                    |

Um critério que nada permitiu julgar (sem telefone; cliente sem área de
expansão) fica **fora do total** em vez de valer zero, e a tela diz "não
avaliado". O DDD dá a **região**, não a cidade: a tela escreve "região de
Campinas/SP pelo DDD 19". O resumo tem sempre 5 linhas: quem e onde;
WhatsApp; presença pública; empresa; a nota e seus três números.

A área de expansão é do cliente (`clients.expansion_area`, editada na tela do
cliente): UFs ou "Cidade/UF", conferidas contra a tabela de UFs ao salvar.

## Tela

**Funil** (`/crm-vendas/funil`, `leads.read`): lista com contato, cliente
("sem regra" quando não mapeado), origem e canal, nota ou estado da pesquisa,
filtros por texto, cliente e origem. "Novo lead" (`leads.write`) cadastra à
mão com base legal e "onde e quando a pessoa autorizou". Quem tem
`leads.read` só como `own` (vendedores) vê apenas os leads que possui; um
lead de webhook não tem dono nesta parte, então aparece para gerentes e
administradores, e o vendedor passa a vê-lo quando a parte 2 o atribuir.

**Lead** (`/crm-vendas/funil/:id`): blocos **Origem** (cliente, como chegou,
canal, código do link, LP ou campanha e formulário, primeira mensagem),
**LGPD** (base legal, data, onde), **Pesquisa** (estado, custo, resumo de 5
linhas, nota com barra e razões por critério, links encontrados, "Refazer
pesquisa", que responde 409 enquanto uma pesquisa está na fila) e a linha do
tempo. A tela se atualiza sozinha enquanto a pesquisa está na fila.

## Variáveis

API:

| Variável                     | Para quê                                                             |
| ---------------------------- | -------------------------------------------------------------------- |
| `RD_STATION_WEBHOOK_SECRET`  | segredo do webhook do RD (16+ caracteres)                             |
| `ZAPI_WEBHOOK_SECRET`        | segredo do webhook do Z-API (16+)                                     |
| `META_APP_SECRET`            | app secret do app do Meta, assina os webhooks                        |
| `META_LEADGEN_VERIFY_TOKEN`  | token do handshake de assinatura do webhook (16+)                    |
| `META_LEADS_ACCESS_TOKEN`    | token com `leads_retrieval` para ler as respostas; sem ele, usa `META_WRITE_TOKEN` só para ler |
| `WINGS_WHATSAPP_NUMBER`      | número dos links, 55 + DDD + número                                  |

Worker:

| Variável                       | Para quê                                                         |
| ------------------------------ | ---------------------------------------------------------------- |
| `ZAPI_INSTANCE_ID`, `ZAPI_INSTANCE_TOKEN`, `ZAPI_CLIENT_TOKEN` | a mesma instância da API, para o perfil |
| `BRAVE_SEARCH_API_KEY`         | busca web; sem ela o passo é pulado e o resumo diz "não realizada" |
| `ENRICH_SEARCH_USD_PER_QUERY`  | custo por consulta (padrão 0,005)                                |
| `ENRICH_DAILY_USD`             | teto do dia para todos (padrão 2)                                |
| `BRASILAPI_BASE_URL`           | opcional, padrão `https://brasilapi.com.br`                      |

## O que o Eric precisa fazer

1. No RD Station Marketing, cadastrar o webhook de conversão apontando para
   `https://<domínio>/api/integrations/rd-station/webhook?secret=<RD_STATION_WEBHOOK_SECRET>`.
2. No Z-API, apontar o webhook "ao receber" da instância para
   `https://<domínio>/api/integrations/zapi/webhook?secret=<ZAPI_WEBHOOK_SECRET>`.
3. No app do Meta, assinar o campo `leadgen` da página com a URL
   `https://<domínio>/api/integrations/meta/leadgen/webhook` e o
   `META_LEADGEN_VERIFY_TOKEN`; gerar um token com `leads_retrieval` e
   `pages_manage_ads` para a página.
4. Criar a chave do Brave Search (plano pago por consulta) e definir o teto.
5. Cadastrar as regras de origem e as áreas de expansão dos clientes.

## Não verificado ao vivo

Os formatos abaixo seguem a documentação publicada de cada serviço e foram
lidos de forma tolerante (vários nomes de campo). O log de formas
(`lead webhook`, `zapi profile`, `brave search`, `brasilapi cnpj`, `meta
lead fetched`) é onde conferir no primeiro evento real:

- RD Station, webhook criado na tela do RD (visto ao vivo no staging em 07/10): `{event_type: 'WEBHOOK.CONVERTED', entity_type: 'CONTACT', event_identifier, event_timestamp, contact: {uuid, email, name, personal_phone, tags, legal_bases, cf_*, company, funnel}}`. Não traz `last_conversion` nem o endereço da página: o identificador do formulário vem em `event_identifier` (a regra `landing_page` casa por ele) e a atribuição (UTM) fica vazia. Eventos `contact` que não são `WEBHOOK.CONVERTED` respondem 200 com `ignored: 'no_conversion'`. Ainda não confirmado: se `event_identifier` é mesmo o identificador de conversão que as regras usam.
- RD Station, formato clássico: `leads[].last_conversion.content.{conversion_identifier,url,created_at}`, `legal_bases`, `mobile_phone`/`personal_phone`; atribuição (CRM Fase 1, T4) de `content.utm_*`/`cf_utm_*`/`gclid`/`fbclid`, da query da `url` e de `content.traffic_source` (o formato `encoded_`+base64 foi lido ao vivo nos eventos de contato em 28/09, não num webhook).
- Z-API "ao receber": `phone`, `text.message`, `senderName`, `senderPhoto`, `momment`, `fromMe`, `isGroup`; endpoints `profile-picture` e `contacts/<phone>`.
- Meta: o corpo `entry[].changes[].value.leadgen_id`, e o Graph
  `GET /v23.0/<leadgen_id>?fields=field_data,campaign_id,campaign_name,form_id,…`.
- Brave: `web.results[].{title,url,description}`.
- BrasilAPI: `razao_social`, `nome_fantasia`, `capital_social`, `qsa[].nome_socio`, `descricao_situacao_cadastral`.

## Tabelas

| Tabela                    | O quê                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `leads`                   | o lead, a origem, a base legal e o resultado da pesquisa                                   |
| `lead_events`             | linha do tempo append-only, por id, sem dado pessoal                                       |
| `lead_source_rules`       | LP / formulário / campanha → cliente                                                       |
| `lead_tracking_links`     | os links `wa.me` por cliente e canal, com contagem de mensagens                            |
| `lead_enrichment_ledger`  | cada passo de cada pesquisa e o que custou, append-only                                    |
| `clients.expansion_area`  | UFs e cidades onde o cliente procura franqueados                                            |

Migração `0029_lead_intake`. No staging, `wings_ro` só lê essas tabelas
depois de `grant select on leads, lead_events, lead_source_rules,
lead_tracking_links, lead_enrichment_ledger to wings_ro;`.

## Parte 2 (não feita)

Handoff para a Sofia (SDR), atribuição de dono, status além de `new`,
reprocessar leads "sem regra" quando a regra é criada, ler leads do Meta cuja
leitura do Graph falhou, mensagens do WhatsApp sem código.
