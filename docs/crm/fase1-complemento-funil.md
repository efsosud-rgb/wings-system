# CRM Vendas — complemento: a Fase 1 nasce em cima do Funil que já existe

30/09/2026. Complemento à [especificação da Fase 1](fase1-especificacao.md).
**Só plano**: nada construído, nenhuma migração, nada gravado no RD, nada
implantado. Levantamento feito no código do develop, na auditoria do staging
(`audit_log`, só contagens) e nos nomes das variáveis do Coolify (nunca valores).

A tela **CRM Vendas → Funil** (`/crm-vendas/funil`) já existe e está vazia:
"Nenhum lead ainda. Quando uma landing page, um link rastreável ou um formulário
do Meta converter, ele aparece aqui." Ela é a porta de entrada que a especificação
já assume (§5). Este complemento **não a refaz**: liga as fontes reais a ela,
traz os negócios do RD para dentro e deixa o resto da especificação (kanban,
rodízio, SLA, importação completa) como a fase seguinte.

## 1. O que já existe no código

### Tabelas (migração `0029_lead_intake`, `apps/api/src/db/schema/leads.ts`)

| Tabela | O que guarda | Estado no staging |
| --- | --- | --- |
| `leads` | a chegada: nome, e-mail, telefone, `client_id` (a marca), `client_mapped`, `source` (`rd_station`, `whatsapp_link`, `meta_lead_ads`, `manual`), `channel`, `landing_page`, `campaign_id/name`, `form_id`, `tracking_link_id`, `external_id`, primeira mensagem, perfil do WhatsApp, base legal (LGPD), pesquisa (estado, nota 0–100, resumo, links, custo), `status` (só `new`), `owner_employee_id` (nunca preenchido) | vazia: **0** entradas `lead.received`/`lead.merged` na auditoria desde a criação |
| `lead_events` | linha do tempo por id (nunca dado pessoal) | vazia |
| `lead_source_rules` | regra → cliente: `landing_page` (slug, host, URL ou `conversion_identifier` do RD), `meta_form` (id do formulário), `meta_campaign` (id da campanha); vence a mais longa (`matchSourceRule`, `packages/shared`) | sem leitura daqui (`wings_ro` não vê as tabelas de lead); com 2 clientes cadastrados, no máximo regras da Wings |
| `lead_tracking_links` | um link `wa.me/<número>?text=<código>` por cliente e canal (Instagram, site, Linktree, LinkedIn, TikTok), `hits` | criar responde **503**: `WINGS_WHATSAPP_NUMBER` não está no api-staging |
| `lead_enrichment_ledger` | ledger append-only da pesquisa paga (Brave), teto diário sob lock | vazia |
| `clients` | a marca do lead | só **Wings Company** e **Sarantopoulos**: Casal, Açaí da Fila, Calçadão e as outras 6 marcas com LP não existem como cliente, então nenhuma regra pode mapeá-las |

Fora do Funil, mas sobre os mesmos leads: `rd_crm_deals` (espelho do RD CRM
sem dado pessoal, criado desde 30/06, etapa atual, origem, campanha, perda),
`campaign_leads` (leads das campanhas de Formatação, cifrados),
`expansion_landing_pages` (as 9 LPs de marca, para o job `expansion-intake`) e,
na fase 0 do WhatsApp (branch `feat/whatsapp-inbox-0`, não mesclada),
`wa_conversations`/`wa_messages`.

### Rotas de entrada (`apps/api/src/modules/leads/webhooks.ts`)

| Porta | Rota | O que exige | Por que não entrou nada |
| --- | --- | --- | --- |
| Landing page / formulário / balão do RD | `POST /integrations/rd-station/webhook` (`?secret=` ou header) | `RD_STATION_WEBHOOK_SECRET` | segredo criado em 29/09 (a rota responde 401 sem ele, antes respondia 503); **o webhook não foi cadastrado no RD Marketing**. Formato do corpo lido com tolerância (`{leads:[…]}` clássico ou evento v2), **não verificado ao vivo** |
| WhatsApp (link rastreável) | `POST /integrations/zapi/webhook` | `ZAPI_WEBHOOK_SECRET`; a mensagem tem de **começar pelo código** do link | `ZAPI_WEBHOOK_SECRET` não está no api-staging (rota responde **503**); nenhum link existe (503 do número); webhook não apontado no painel do Z-API. Mensagem sem código é ignorada de propósito (`ignored: no_code`) — a fase 0 do WhatsApp muda isso, mas está fora do develop |
| Meta Lead Ads | `GET`/`POST /integrations/meta/leadgen/webhook` | `META_APP_SECRET` (assinatura), `META_LEADGEN_VERIFY_TOKEN` (handshake), `META_LEADS_ACCESS_TOKEN` ou `META_WRITE_TOKEN` para ler o lead no Graph | nenhuma das três variáveis está no api-staging (**503**); app da Meta em modo de desenvolvimento; página não assinada; formulário instantâneo não criado (ver §4) |
| Manual | `POST /leads` (`leads.write`) | sessão | funciona; ninguém usou |

Comportamento comum (`upsertLead`, `service.ts`): acha o lead existente por
`external_id` da mesma origem → telefone → e-mail; só preenche lacunas; cada
chegada vira `lead_events` + `audit_log`; conversão sem regra vira lead da
Wings com `client_mapped = false` ("sem regra" na tela). Lead novo enfileira
`enrich_lead`.

### Pesquisa de perfil (worker, `enrich_lead`)

DDD → região, domínio do e-mail, foto/nome no Z-API, 2 buscas no Brave (pagas,
ledger e teto `ENRICH_DAILY_USD`), CNPJ na BrasilAPI; nota `franchiseeScoreOf`
(capital 40, gestão 30, cidade na área de expansão 30) e resumo de 5 linhas.
No staging **nunca rodou**: o `wings-worker-staging` tem `WORKER_JOB_TYPES`
fixo em ffprobe/transcribe/render (na tabela `jobs` só há 3 `transcribe` e 1
`render`), e não tem `BRAVE_SEARCH_API_KEY` nem `ZAPI_*`. Sem o job, a coluna
"Perfil" ficaria "na fila" para sempre.

### Resumo: por que está vazio

Nenhuma das três portas automáticas está ligada de ponta a ponta (RD: falta o
cadastro no RD; Z-API: faltam segredo, número, links e webhook; Meta: faltam
segredos, app público, assinatura da página e formulário), e mesmo que
estivessem, as marcas não existem como cliente, então tudo cairia como "sem
regra" na Wings Company. O trabalho comercial continua acontecendo no RD CRM
(400 negócios de Expansão e 73 de Formatação em 90 dias, ver
[`docs/analise/expansao-2026-09-30.md`](../analise/expansao-2026-09-30.md)),
que o Funil não enxerga.

## 2. Fase 1 (nova): ligar as fontes reais ao Funil e trazer o RD para dentro

Princípios, iguais aos da especificação: `upsertLead` é a única porta; dado
pessoal só em `leads`; o RD Marketing continua recebendo tudo (LPs, fluxos,
e-mail) e o RD CRM continua sendo onde a equipe trabalha até a virada da
especificação. Sentido dos dados nesta fase: **fontes → Wings e RD; RD CRM →
Wings (etapa)**; a Wings só escreve no RD CRM o que já escreve hoje (o negócio
novo do `expansion-intake`/`formatacao-intake`).

### 2.1 Base (schema e regras) — migração `0052+` (a fase 0 do WhatsApp toma a 0051)

- `clients`: cadastrar as marcas (Casal do Churros, Açaí da Fila, Calçadão do
  Frango, Mister Russo, Grupo Forte Fênix, Rio Açaí Gourmet, Ginteco, Família K)
  pela tela que já existe; a Formatação é a própria Wings Company. Sem código.
- `lead_source_rules` ganha `pipeline` (`expansao | formatacao`) e passa a ser a
  **única** lista de páginas: `expansion_landing_pages` vira regras (migração de
  dados; o job `expansion-intake` lê as regras) — uma lista, não duas. Regras
  iniciais: `casal-do-churros`, `acai-da-fila`, `calcadao-do-frango`,
  `lp-calcadao-do-frango` (balão), mais as 6 outras marcas → Expansão;
  `wings-company-form-site`, `lp-formatacao-whatsapp`, `Formulário Simplificado. -02`
  → Formatação (Wings).
- `leads` ganha: `pipeline`, `stage`, `stage_order`, `stage_changed_at`
  (a etapa do RD, enquanto o RD CRM manda), `closed_at`, `won`, `lost_reason`,
  `rd_deal_id` (único), `rd_contact_id`, `rd_owner_id`, e as colunas de
  atribuição do §1.4 da especificação (`utm_*`, `gclid`, `fbclid`,
  `ad_platform`, ids de campanha/conjunto/anúncio, `referrer`), lidas dos campos
  ocultos do RD quando existirem. Fonte nova: `rd_crm` ("RD CRM (importado)")
  e `site_form` ("Formulário do site").
- `rd_user_map`: id de usuário do RD CRM → funcionário (Fernando e os demais),
  editado em Administração; sem ele o dono fica "—".
- Grants: nada novo ao `wings_ro` (tudo aqui tem dado pessoal).

### 2.2 Portas, uma a uma (sem parar o envio ao RD)

| Porta | O que muda no código | O que o Eric faz |
| --- | --- | --- |
| **LPs das marcas e da Formatação, balões do RD** | webhook lê os campos ocultos de UTM/click id; regra decide marca **e** funil; o lead novo dispara o mesmo `expansion-intake`/`formatacao-intake` que cria o negócio no RD CRM e **grava `rd_deal_id` no lead** (hoje o job não conhece o lead) | cadastra o webhook de conversão no RD Marketing apontando para `…/api/integrations/rd-station/webhook?secret=…`; confere na primeira entrega o log de forma |
| **Site do Calçadão (calcadaodofrango.com.br)** | rota pública `POST /integrations/site-forms/:clientSlug` com token por cliente, honeypot e limite por IP: cria o lead (`site_form`), **reenvia a conversão ao RD Marketing** pela API de conversões (`POST /platform/conversions`, identificador `calcadao-do-frango`, credenciais `RD_MKT_*` que já existem) para os fluxos do RD continuarem, e responde o link de WhatsApp **rastreado** da marca para o site abrir em seguida | diz quem mantém o site (o código não está neste servidor) e pede a troca de `window.open(wa.me…)` por um `fetch` na rota + abrir o link devolvido; um número por marca |
| **WhatsApp por marca (links rastreáveis)** | mesclar a fase 0 (`feat/whatsapp-inbox-0`, migração renumerada para 0051): toda mensagem vira conversa ligada ao lead pelo telefone; criar um link por marca e canal (bio do Instagram, site, botão da LP) na tela que já existe | `WINGS_WHATSAPP_NUMBER`, `ZAPI_WEBHOOK_SECRET` no api-staging; no painel do Z-API, "Ao receber", "Ao enviar" e "Status" para `…/api/integrations/zapi/webhook?secret=…`; trocar os botões de WhatsApp das LPs (editor do RD) e das bios pelos links rastreados |
| **Meta Lead Ads** | ver §4: além do webhook, uma **leitura periódica** (a cada 15 min, na ingestão que já existe) de `GET /{form_id}/leads` dos formulários com regra, para nenhum lead depender do webhook | segredos, app público, assinatura da página, token, formulário, termos |
| **Manual** | nada | — |

### 2.3 Trazer o RD CRM para o Funil (com marca e etapa)

- CLI `leads-import-rd` na API (como `ingest-cli`), `--dry-run` primeiro, só
  contagens no terminal. Lê `GET /deals` (cursor, desde 30/06/2026: os ~400 de
  Expansão e ~73 de Formatação dos últimos 90 dias, mais os abertos mais
  antigos) e `GET /deals/:id/contacts` para nome, e-mail e telefone; marca pela
  custom field "Nome da Marca" ou pelo rótulo "LP/LE <marca> - Fluxo Expansão"
  → `clients`; etapa e ordem pelo `deal_pipelines`; dono por `rd_user_map`;
  fonte/campanha originais em `rd_source_raw`/`rd_campaign_raw`. Passa por
  `upsertLead` (fonte `rd_crm`, `external_id = rd_deal_id`): um lead que já
  entrou pelo webhook é **ligado**, não duplicado. Idempotente: rodar de novo
  atualiza. Só GET no RD; ~1.000 chamadas dentro do limite de 120/min.
- Sincronização contínua: a leitura de negócios que já roda na ingestão
  (`syncRdCrmDeals`, sem dado pessoal) passa a atualizar `stage`, `closed_at`,
  `won`, `lost_reason` dos leads pelo `rd_deal_id`, e a criar o lead (com
  contatos) quando aparece um negócio que o Funil não tem. Assim o Funil segue
  o RD enquanto o RD CRM for a ferramenta de trabalho; a virada de sentido
  (Wings manda, `moveDeal`, histórico real) é a fase seguinte, como na
  especificação.
- Mudar etapa dentro do Funil **não** escreve no RD nesta fase (evita dois donos
  da mesma etapa). A tela deixa claro: "etapa lida do RD há N min".

### 2.4 Tela Funil (em cima da que existe)

Colunas novas: **Funil** (Expansão/Formatação), **Etapa**, **Dono**, **Parado há**;
filtros Funil, Etapa, Dono e "parados há mais de N dias"; um mini-funil por marca
no topo (chegaram / trabalhados / reunião / venda, 30 e 90 dias). "Novo lead"
continua. Detalhe do lead ganha o bloco "No RD CRM" (negócio, etapa, dono,
link para o RD). Nada de kanban ainda.

### 2.5 Estimativa (dias de desenvolvimento) e ordem

| Etapa | Dias |
| --- | ---: |
| 2.1 base: clientes, regras com funil, colunas em `leads`, `rd_user_map`, migração | 2 |
| 2.3 importador + sincronização de etapa + `rd_deal_id` gravado pelos jobs de entrada | 3 |
| 2.4 tela | 2 |
| 2.2 formulário de site (rota + reenvio ao RD + link rastreado) | 2 |
| 2.2 WhatsApp: mesclar fase 0 (renumerar), links por marca | 1 |
| §4 Meta Lead Ads: leitura periódica + caminho do formulário instantâneo no construtor | 3 |
| **Total** | **13** |

Ordem: base → importador (o Funil deixa de estar vazio no primeiro dia útil da
etapa 2) → tela → RD webhook → site → WhatsApp → Meta. Cada etapa numa branch,
mesclada depois da revisão do Eric; migrações sempre depois da 0051.

## 3. Renumeração das fases

| Antes | Agora |
| --- | --- |
| Funil Sofia parte 1 (feito) | idem |
| WhatsApp fase 0 (feito, não mesclado) | entra na Fase 1 |
| — | **Fase 1: fontes reais + RD dentro do Funil** (este documento) |
| CRM Fase 1 (especificação: 30 dias) | **Fase 2** — o importador do §2.3 vira a etapa 4 da importação completa (§3.1), e as colunas de etapa em `leads` migram para `crm_deals` |
| WhatsApp fase 1 (caixa de entrada, envio, assumir) | Fase 2, junto |
| WhatsApp fase 2 (Sofia) / Funil Sofia parte 2 | Fase 3 |

## 4. Meta Lead Ads de ponta a ponta: o que falta

O código do webhook e da leitura no Graph existe e tem testes; nada dele foi
exercitado ao vivo. Para um formulário instantâneo de uma campanha do Eric
chegar ao Funil:

1. **Segredos no api-staging** (`wings-env set`): `META_APP_SECRET` (assina o
   corpo), `META_LEADGEN_VERIFY_TOKEN` (handshake), `META_LEADS_ACCESS_TOKEN`
   — token de usuário do sistema do BM com `leads_retrieval`,
   `pages_show_list`, `pages_read_engagement` e `pages_manage_ads` na página. O
   `META_WRITE_TOKEN` de 25/09 **não** tem `leads_retrieval` (handoff do Opus).
2. **App "Wings Traffic Agent" em modo público** (Live). Hoje está em
   desenvolvimento (subcódigo 1885183 nas escritas de criativo); em
   desenvolvimento, webhooks de página só chegam de páginas de quem tem papel no
   app — conferir na primeira entrega.
3. **Assinar a página**: no painel do app, Webhooks → Page → campo `leadgen`,
   URL `https://staging.wingssystem.online/api/integrations/meta/leadgen/webhook`
   e o verify token (o GET responde o `hub.challenge`); depois
   `POST /{page_id}/subscribed_apps?subscribed_fields=leadgen` com token de
   página.
4. **Página**: aceitar os Termos do Lead Ads; **criar o formulário instantâneo**
   (Gerenciador de Anúncios ou `POST /{page_id}/leadgen_forms`): nome, e-mail,
   telefone, cidade e "capital disponível"; URL de política de privacidade.
5. **Regra `meta_form`** com o id do formulário → cliente (Wings para
   Formatação, marca para Expansão) e funil.
6. **Construtor**: o conjunto de anúncios do sistema otimiza por pixel e
   destino site (`promoted_object.pixel_id`); o formulário instantâneo exige
   `optimization_goal = LEAD_GENERATION`, `promoted_object = { page_id }` e
   `call_to_action.value.lead_gen_form_id` no criativo — o "caminho A, CBO" do
   handoff do Opus, ainda não construído. Nasce pausado, `validate_only` antes,
   como tudo no construtor.
7. **Teste**: a ferramenta de teste do Lead Ads da Meta cria um lead de
   mentira que chega pelo webhook; conferir `lead.received` na auditoria e o
   log de forma (`meta_leadgen`, `meta lead fetched`). Os leads que chegaram
   enquanto algo estava errado são pegos pela leitura periódica (§2.2).

Sem o item 1 o webhook responde 503; sem o 3 a Meta não chama; sem o 4 não há
formulário para anunciar; sem o 6 o construtor não consegue criar a campanha
com formulário (o Eric criaria na Meta à mão, e o sistema só leria).

## 5. O que o Eric decide antes de começar

1. Aprovar este recorte de Fase 1 (13 dias) na frente da especificação.
2. As marcas como clientes: os 8 nomes acima e quem responde por cada uma.
3. Site do Calçadão: quem mantém; aceita o formulário passar pela Wings e
   reenviar ao RD (`RD_MKT_*` já existem no staging).
4. Um número de WhatsApp por marca (hoje LP e site do Calçadão divergem) e
   qual é o número da Wings (`WINGS_WHATSAPP_NUMBER`).
5. Meta: fazer os itens 1 a 4 do §4, ou deixar o formulário instantâneo para
   depois e seguir com destino site + pixel (o que já funciona).
6. Fernando como dono padrão dos leads de Expansão (`rd_user_map` e
   `EXPANSION_OWNER_RD_USER_ID`).

Fora deste plano, como antes: Jurídico (base legal por porta), Sofia, kanban,
rodízio, SLA, importação dos 5.903 negócios históricos.
