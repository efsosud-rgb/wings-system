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
