# CRM Vendas — Fase 1: o que está construído e como operar

Plano: `docs/crm/fase1-complemento-funil.md` (branch `docs/crm-fase1`). Este
documento diz o que já existe no código e como rodar. O RD Station CRM continua
sendo a ferramenta de trabalho até a Fase 5: aqui só se **lê** o RD CRM.

## Base (migrações 0051 e 0052)

- `leads`: `pipeline` (expansao | formatacao), `brand`, espelho do RD
  (`rd_deal_id` único, `rd_contact_id`, `rd_owner_id`, `rd_pipeline`, `stage`,
  `stage_order`, `stage_changed_at`, `won`, `closed_at`, `lost_reason`,
  `first_contact_at`, `rd_synced_at`) e atribuição de primeiro toque (`utm_*`,
  `gclid`, `fbclid`, `gbraid`, `wbraid`, `ad_platform`, ids de campanha,
  conjunto e anúncio, `referrer`).
- `lead_source_rules` é a **única** lista de páginas: ganhou `pipeline`,
  `brand`, `active` e `client_id` opcional (marca ainda não cadastrada fica pelo
  nome). As LPs das marcas (antes `expansion_landing_pages`, removida pela 0052)
  são regras do funil Expansão; os 3 formulários da Formatação são regras da
  Wings no funil Formatação.
- `rd_user_map`: usuário do RD CRM → funcionário (`GET`/`PUT /leads/rd-users`,
  `integrations.manage`, auditado). Preenchido pelo importador, que liga por
  e-mail e, se não houver, por nome completo idêntico e único.
- Fontes novas: `rd_crm` ("RD CRM (importado)") e `site_form` ("Formulário do site").
- Nada novo ao `wings_ro` (tudo aqui é dado pessoal ou liga a ele).

## Marcas como clientes

```
node dist/scripts/crm-brands.js            # simula
node dist/scripts/crm-brands.js --apply    # cadastra e liga
```

Cadastra as 8 marcas que faltam como "Novo cliente" (número, projeto, pastas
do Drive) e liga cada regra de LP de Expansão ao cliente pela marca ou pelo
identificador (sem acento, sem caixa, sem "do/dos/da/de/e"; `lp-`, `le-` e
`lista-de-espera-` ignorados). Auditoria `client.created` e
`lead_source_rule.linked`. Rodar de novo não faz nada.

## RD CRM → Funil

```
node dist/scripts/leads-import-rd.js                         # simula (lê RD e o Funil, não grava)
node dist/scripts/leads-import-rd.js --apply [--since=2026-06-30] [--no-histories]
```

- Traz os negócios dos funis de Expansão e Formatação (inclusive os arquivos
  "Vendidos"/"Negócios perdidos" de cada um) criados desde `--since`, mais os
  **abertos** de qualquer idade. Parcerias, Estruturação e Lista de espera
  ficam fora.
- Por negócio: `GET /deals/:id/contacts` (nome, e-mail, telefone do primeiro
  contato) e, sem `--no-histories`, `GET /deals/:id` para
  `deal_stage_histories` (1º contato = primeira entrada numa etapa depois da
  primeira; "parado há" = entrada na etapa atual). Formato de
  `deal_stage_histories`, `/users` e dos campos personalizados **não verificado
  ao vivo**: lido com tolerância e registrado como forma
  (`rd_import.*`, só chaves e números).
- Passa por `upsertLead` (fonte `rd_crm`, `external_id` = id do negócio): um
  lead que já chegou pelo site é **ligado**, não duplicado. Um lead por pessoa:
  quando a pessoa tem mais de um negócio, fica o aberto (ou o mais recente) e
  o outro vai para a linha do tempo (`rd.other_deal`).
- Marca: campo "Nome da Marca", senão a campanha "LP/LE <marca> - Fluxo
  Expansão"; cliente pela marca normalizada. Marca sem cliente: lead na Wings
  "sem regra", com a marca guardada; a saída lista essas marcas.
- Dono: `rd_user_map`; sem funcionário ligado, "—".
- **Não** enfileira a pesquisa paga (`enrich_lead`) para os importados.
- Base legal: o RD CRM não a informa aqui; fica vazia (nunca inventada).
- Saída: contagens, nomes de marca e formas; nunca uma pessoa.

A cada ciclo de ingestão (de hora em hora), depois do espelho `rd_crm_deals`:
etapa, resultado e dono dos leads que têm negócio (`followRdStages`, sem
chamada extra); negócios dos últimos 3 dias que o Funil ainda não tem
(`importRdDeals` com `onlyMissing`); e até 40 históricos de etapa por ciclo
para quem mudou de etapa (`refreshStageTimes`). Etapa que mudou fica com
"parado há" vazio até o histórico ser lido: nunca "agora".

Os jobs `expansion-intake`, `formatacao-intake` e a recuperação gravam o
`rd_deal_id` no lead do Funil com o mesmo telefone/e-mail quando criam o
negócio (`recordDealOnLead`, evento `rd.deal_created`).

Mudar a etapa dentro do Funil **não** escreve no RD nesta fase.

## Lote de importação e como desfazer

Cada `leads-import-rd --apply` recebe um lote (`rd-crm-AAAAMMDDTHHMMZ`, impresso
no início e gravado na auditoria `leads.import_rd`); o seguimento por hora usa
`rd-crm-sync-…`. Leads **criados** pelo lote levam `leads.import_batch_id`;
leads que **já existiam** e foram tocados ganham um evento `rd.import_batch` com
o que eram antes (ids, rótulos e datas; nada pessoal) e a lista de lacunas que
a importação preencheu.

```
node dist/scripts/leads-import-rd-undo.js --batch=rd-crm-...            # simula (contagens)
node dist/scripts/leads-import-rd-undo.js --batch=rd-crm-... --apply    # desfaz, numa transação
```

Desfazer remove os leads criados pelo lote (com a linha do tempo) e devolve os
que já existiam ao estado anterior, esvaziando de novo as lacunas preenchidas;
grava `leads.import_rd_undone` na auditoria. O mapa `rd_user_map` fica (é a
lista dos nossos usuários do RD, sem nada de lead). O seguimento por hora
(`CRM_RD_FOLLOW_ENABLED`) deve estar desligado ao desfazer.

## Webhook do RD Marketing (T4)

`POST /api/integrations/rd-station/webhook` (segredo em `?secret=` ou no header
`X-Wings-Webhook-Secret`; sem `RD_STATION_WEBHOOK_SECRET` responde 503).

- **Regra → cliente, marca e funil**: a regra `landing_page` (identificador,
  slug ou domínio) decide; regra de marca que ainda não é cliente arquiva sob
  Wings Company, com `brand` e `pipeline` gravados.
- **Atribuição de primeiro toque** (`leads.utm_*`, `gclid`, `fbclid`, `gbraid`,
  `wbraid`, `ad_platform`, ids de campanha/conjunto/anúncio, `referrer` só
  origem+caminho), nesta ordem, a primeira que tiver cada chave: campos do
  formulário (`utm_source` ou `cf_utm_source` — os campos ocultos que o GTM
  ainda não preenche), a query da página do formulário, e o `traffic_source`
  do RD (sessão atual, depois a primeira). Ids de anúncio só numéricos
  (`{{ad.id}}` sem preencher fica de fora). Nunca sobrescreve a de um lead que
  já tem.
- **Negócio do RD**: o intake de 5 min continua sendo quem cria o negócio no
  RD CRM (nenhuma escrita nova no RD) e grava `rd_deal_id` no lead
  (`recordDealOnLead`). Se a entrega chega **depois** do intake, o webhook acha
  o negócio no `expansion_intake_ledger` pela chave (uuid do contato no RD +
  identificador, 30 dias) e liga (`rd.deal_linked`), só se nenhum outro lead
  tem esse negócio e o funil bate.
- Auditoria `lead.received`/`lead.merged` com `pipeline` e `rdDealLinked`;
  evento com `adPlatform`/`hasUtm`, nada pessoal.

**Falta (Eric, no RD Marketing):** cadastrar o webhook de conversão com a URL
de staging e `?secret=` (o valor está só no Coolify). Na primeira entrega,
conferir o log `lead webhook` (forma) — em especial se `traffic_source` vem em
`last_conversion.content` no webhook como vem nos eventos de contato.

## Formulário do site, origem por página e dono inativo (T5, migração 0056)

**Formulário próprio** em `/lp/<slug>` (página pública do app, sem login):
`GET`/`POST /api/public/site-forms/:slug`. Responde só para uma regra
`landing_page` ativa com o formulário ligado; qualquer outra coisa é o mesmo 404.

- Ligar por página: CRM Vendas → Landing pages → "Formulário do site"
  (`lead_source_rules.site_form_enabled`, `PATCH /api/crm/landing-pages/:id`,
  `integrations.manage`, auditado).
- Antes de gravar: campo-isca (preenchido = resposta de sucesso, nada gravado,
  `site_form.honeypot`), depois Cloudflare Turnstile conferido no servidor
  (`site_form.captcha_refused`), e limite por IP (10 envios / 10 min; 120
  leituras / min). O IP é o que o Traefik entrega: ele não aceita
  `X-Forwarded-For` de fora e o domínio aponta direto para o servidor (sem proxy
  da Cloudflare). Se um dia passar pela Cloudflare, o limite precisa usar
  `CF-Connecting-IP`.
- Variáveis (só nomes): `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` (sem o
  secret: 503, nunca um falso sucesso), `SITE_FORM_RD_FORWARD_ENABLED` e
  `SITE_FORM_RESEARCH_ENABLED`.
- O lead entra pelo mesmo `upsertLead` do webhook (T4): cliente, marca e funil
  pela regra; atribuição de primeiro toque pelos campos ocultos (cookie
  `wings_ft`, `lib/site-tracking.ts`) e pela URL da página; consentimento com o
  texto `SITE_FORM_CONSENT_TEXT`. A pesquisa paga (`enrich_lead`) **não** roda
  para leads do formulário enquanto `SITE_FORM_RESEARCH_ENABLED` não for
  `true` (Eric, 01/10); pode ser pedida à mão no lead. Log só com a forma do corpo (`shapeOf`); auditoria só
  com ids e marcas.
- **Reenvio ao RD Marketing**: pronto e desligado. Com
  `SITE_FORM_RD_FORWARD_ENABLED=true` (só o Eric liga), uma chamada de conversão
  por envio, nunca repetida; resultado na auditoria (`rdForward`).
- Domínio `lp.wingscompany.com.br`: hoje é CNAME para as páginas do RD. Testar
  no staging (`staging.wingssystem.online/lp/<slug>`). Para o domínio próprio:
  A `lp` → `2.24.198.232` no HostGator, depois o domínio no Coolify no web **e**
  na API (`/api` precisa estar na mesma origem, ou o POST cai na trava de Origin).

**Origem por página** (`lead_source_rules.deal_source`): em CRM Vendas →
Landing pages, a "Origem" do RD CRM para os negócios **novos** que o intake de
Expansão criar a partir daquela página (`GET /api/crm/landing-pages/deal-sources`
lê a lista do RD). Sem origem, ou com uma que o RD não tem mais, vale a regra
anterior ("Referência | <host>" ou "Contato pelo Site"), contada em
`dealSourceMissing`. Negócios já existentes no RD não são tocados.

**Regras do seed (auditoria de 01/10)**: `mister-russo` (o formulário; o balão
é `lp-mister-russo`), `familia-k` e `wash-club`, funil Expansão. Só insere;
uma regra nova já nasce ligada ao cliente da marca quando ele existe. As três
nascem **sem criar negócio no RD** (`lead_source_rules.rd_deal_intake = false`,
migração 0057, que também desliga as que já existissem pela tela): a automação
do próprio RD pode já criar o negócio dessas páginas, e o intake, se rodasse
antes dela, duplicaria. O lead entra no Funil e é atribuído à marca
normalmente. Ligar: CRM Vendas → Landing pages → "Formulário e origem" →
"Criar negócio no RD CRM" (decisão do Eric). Vale para qualquer página: o
intake e a recuperação só usam regras com a chave ligada.

**Dono inativo**: `rd_user_map.departed_at` marca quem saiu da empresa (a 0056
marca o ex-vendedor `69ef68ab1ca7400013f89513`). No Funil, o filtro "Dono
inativo" junta negócios do RD sem dono, com dono inativo no RD, que saiu, ou sem
ligação a funcionário. Nada é redistribuído.

**B5 — marcas antigas para Expansão**:

```
node dist/scripts/crm-brands.js --expansion-legacy           # simula
node dist/scripts/crm-brands.js --expansion-legacy --apply   # aplica
```

As 8 marcas da primeira rodada passam a `relationship = 'expansao'` e os
projetos de Formatação abertos para elas ficam ocultos (`client_projects.hidden_at`),
sem apagar nada. Rodar de novo não faz nada.

## Links de WhatsApp por marca (T6, migração 0058)

Decisão do Eric (01/10): **todo link e toda página de Expansão abrem o WhatsApp da Wings**
(`WINGS_WHATSAPP_NUMBER`, 5521999470288), onde a Sofia atende. A marca é identificada pelo código
do link (cliente + canal) e pelo texto pré-preenchido: `<CÓDIGO> Olá! Quero saber sobre a franquia
<Marca>.` O lado que recebe lê só a primeira palavra (o código), então o lead cai no Funil com a
marca certa.

- **WhatsApp próprio da marca** (`clients.whatsapp`, ficha → Empresa) é só contato: nunca entra em
  link, página ou resposta pública. Sem WhatsApp próprio, a ficha guarda o motivo
  (`clients.whatsapp_note`) e o campo aparece vazio ("—").
- **Instagram** (`clients.social.instagram`) é o da marca e aparece na página `/lp/<slug>`.
- **Formulário do site**: depois do envio, a resposta traz `whatsappUrl`, o link **Site** mais
  recente da marca feito para o número atual da Wings (ou `null`: página sem marca, sem link Site,
  ou `WINGS_WHATSAPP_NUMBER` ausente). A rota pública não cria link; gere em Formatação → Clientes →
  Links e expansão → canal Site.
- Link feito para um número antigo da Wings aparece marcado ("não é mais o WhatsApp da Wings") e não
  é devolvido pelo formulário.
- Dados das marcas (Eric, 01/10): `node dist/scripts/crm-brands.js --contacts [--apply]` grava
  Instagram e WhatsApp próprio de Cenoritas e Amarjon e o motivo da Iguari (sem WhatsApp próprio).
  Simula por padrão; rodar de novo não muda nada; auditoria `client.company_updated` só com nomes de
  campo.
- Nada é enviado: `wa.me` só abre a conversa no aparelho da pessoa.
