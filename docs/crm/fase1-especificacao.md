# CRM próprio — Fase 1: especificação

25/09/2026. **Documento de especificação: nada aqui foi construído.** Nenhuma
migração, nenhum código, nada gravado no RD. Os números do RD vêm de leituras
`GET` feitas em 25/09 (RD Station CRM API v1 e RD Station Marketing), agregadas
sem nenhum dado de cliente.

Objetivo: substituir o RD Station CRM por um CRM dentro do Wings System, com a
estrutura que a equipe já conhece (funis, etapas, negociações, tarefas) e o
que falta a uma franqueadora: histórico real de etapas, rodízio de
responsáveis, triagem de parados, SLA de primeiro contato e ganho ligado à
campanha que trouxe o lead.

A porta de entrada **é o Funil Sofia parte 1** ([../leads/intake.md](../leads/intake.md)).
O CRM não cria uma segunda captação: amplia a que existe.

## 0. O RD hoje, em números (25/09/2026)

| Objeto                          |     Quantidade | Observação                                                                                                                    |
| ------------------------------- | -------------: | ----------------------------------------------------------------------------------------------------------------------------- |
| Negociações                     |          5.903 | 131 ganhas, 4.523 perdidas, 1.249 em andamento, 1 congelada (`hold`)                                                          |
| Funis                           |              9 | Parcerias, Formatação, Expansão, Estruturação, Lista de espera, 2 "Vendidos", 2 "Negócios perdidos"                           |
| Etapas                          |             77 | de 5 a 12 por funil                                                                                                           |
| Contatos                        |          5.577 | 1.574 sem e-mail, 40 sem telefone, 35 sem nenhum dos dois válido, 89 telefones inválidos                                      |
| Duplicados                      |                | 65 e-mails em 132 contatos; 213 telefones em 497 contatos                                                                     |
| Empresas (organizations)        |            801 |                                                                                                                               |
| Tarefas                         |         20.542 | 241 abertas, 240 atrasadas (amostra de 10.000; ver §3.6)                                                                      |
| Anotações (activities)          |          8.913 | texto livre                                                                                                                   |
| Usuários                        |             17 | 4 ativos, 13 inativos, nenhum oculto                                                                                          |
| Times                           |              3 | EXPANSÃO VENDA (2), FORMATAÇÃO (1), SDR EXPANSÃO (2)                                                                          |
| Motivos de perda                |             18 |                                                                                                                               |
| Fontes                          |             46 | muitas são UTMs coladas como texto ("Busca Paga \| Facebook Ads", "Social \| ig")                                             |
| Campanhas                       |            118 | só nome e descrição                                                                                                           |
| Produtos                        |              5 | Formatação Exclusive (R$ 135 mil), Formatação Pocket (R$ 80 mil), Proposta por módulos (R$ 75 mil), Franquia, Rede Moto Peças |
| Campos personalizados CRM       |             33 | 17 de negociação, 11 de contato, 5 de empresa (ver §3.3)                                                                      |
| Campos personalizados Marketing |             87 | `cf_*` (ver §3.4)                                                                                                             |
| Segmentações Marketing          |             35 | 17 com zero contatos                                                                                                          |
| Bases legais (LGPD)             | 1.484 contatos | 910 interesse legítimo, 552 consentimento, 21 recusas                                                                         |

O que o RD **não** tem e é o motivo deste projeto:

- **Histórico de etapas.** O RD guarda só a etapa atual. Não há como saber
  quanto tempo uma negociação ficou em "Reunião agendada" nem calcular
  conversão por etapa com dado real.
- **Negócio fechado fora do lugar.** 157 negociações estão "em andamento"
  dentro dos funis Vendidos / Negócios perdidos (96 + 59 + 2), e 1 ganha está
  em "Negócios perdidos - Expansão". O funil virou um arquivo, e o estado
  ganha/perdida ficou em segundo plano.
- **Carteira órfã.** 13 usuários inativos seguram 423 negociações em
  andamento nos funis de trabalho.
- **Campanha real.** A fonte é texto livre; não há como ligar um ganho ao
  gasto da campanha que o trouxe.

## 1. Modelo de dados

Convenções, iguais ao resto do sistema:

- Toda tabela tem `tenant_id` (padrão Wings, `tenantId()` local ao arquivo de
  schema) e `client_id` quando o dado pertence a um cliente da Wings
  (`clientId()`, padrão Wings Company). Hoje o CRM é da própria Wings; o
  `client_id` existe para o dia em que a Wings operar o comercial de um
  franqueado.
- Arquivo novo `apps/api/src/db/schema/crm.ts`; prefixo `crm_` em toda tabela.
- **Dado pessoal fica na tabela do contato e só nela.** Eventos, auditoria,
  histórico e erros citam por id.
- Toda migração que cria tabela termina com o grant ao `wings_ro`, no padrão
  da 0037/0038:
  ```sql
  DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wings_ro') THEN
    GRANT SELECT ON crm_pipelines, crm_stages, ... TO wings_ro;
  END IF; END $$;
  ```
  Exceção: `crm_contacts` **não** vai ao `wings_ro` (tem nome, e-mail,
  telefone). Para análise há a view `crm_contacts_ro` sem colunas pessoais.
- Tabelas append-only (histórico, eventos) ganham o mesmo trigger que
  `time_entries` usa para recusar `UPDATE`/`DELETE`.

### 1.1 Estrutura

**`crm_pipelines`** — funis

| coluna                 | tipo                                                                | nota                                                 |
| ---------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| id                     | uuid pk                                                             |                                                      |
| tenant_id, client_id   |                                                                     |                                                      |
| name                   | text                                                                | "Formatação", "Expansão"...                          |
| product_line           | enum `formatacao \| expansao \| estruturacao \| parcerias \| outro` | liga o funil ao produto (painel, CAC)                |
| position               | int                                                                 | ordem no menu                                        |
| active                 | bool                                                                | funil desativado some do kanban, fica nos relatórios |
| rd_id                  | text null, unique                                                   | só para a importação                                 |
| created_at, updated_at |                                                                     |                                                      |

**`crm_stages`** — etapas

| coluna           | tipo                       | nota                                                             |
| ---------------- | -------------------------- | ---------------------------------------------------------------- |
| id               | uuid pk                    |                                                                  |
| pipeline_id      | fk                         |                                                                  |
| name, position   |                            |                                                                  |
| kind             | enum `open \| won \| lost` | uma etapa `won` e uma `lost` por funil (ver §4.1)                |
| sla_hours        | int null                   | tempo máximo na etapa antes de alertar (null = sem SLA)          |
| is_first_contact | bool                       | a etapa cujo fim encerra o SLA de primeiro contato               |
| stale_after_days | int null                   | quando uma negociação parada nesta etapa entra na triagem (§4.2) |
| active           | bool                       |                                                                  |
| rd_id            | text null, unique          |                                                                  |

**`crm_loss_reasons`**

| coluna           | tipo      | nota                                                     |
| ---------------- | --------- | -------------------------------------------------------- |
| id, tenant_id    |           |                                                          |
| name             | text      |                                                          |
| requires_note    | bool      | "Outros" exige observação                                |
| active, position |           |                                                          |
| rd_id            | text null | para os 18 antigos, que viram inativos e mapeados (§3.5) |

**`crm_products`** — produtos/planos

| coluna           | tipo                | nota                                                                       |
| ---------------- | ------------------- | -------------------------------------------------------------------------- |
| id, tenant_id    |                     |                                                                            |
| name             | text                | Formatação Exclusive, Formatação Pocket, Proposta por módulos, Franquia... |
| product_line     | mesmo enum do funil |                                                                            |
| list_price_cents | bigint              |                                                                            |
| active           | bool                |                                                                            |
| rd_id            |                     |                                                                            |

**`crm_sources`** — fonte normalizada

| coluna        | tipo        | nota                                                                                                 |
| ------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| id, tenant_id |             |                                                                                                      |
| key           | text unique | `meta_ads`, `google_ads`, `organico_google`, `indicacao_franqueador`, `feira`, `site`, `whatsapp`... |
| label         | text        |                                                                                                      |
| paid          | bool        | entra no CAC                                                                                         |
| active        |             |                                                                                                      |

As 46 fontes do RD são mapeadas para ~15 chaves (tabela de-para no
importador); o texto original fica em `crm_deals.rd_source_raw`.

### 1.2 Pessoas e empresas

**`crm_contacts`** — a pessoa (lead ou cliente)

| coluna                                                  | tipo              | nota                                                                                                            |
| ------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| id, tenant_id, client_id                                |                   |                                                                                                                 |
| name                                                    | text              |                                                                                                                 |
| email                                                   | text null         | minúsculo; índice `(tenant, email)`                                                                             |
| phone                                                   | text null         | `55`+DDD+número (`normalizeBrazilianPhone`); índice `(tenant, phone)`                                           |
| extra_emails, extra_phones                              | text[]            | os demais, já normalizados                                                                                      |
| cpf_encrypted, cpf_index                                |                   | AES-256-GCM + índice cego, **mesmo `createCpfCrypto` dos clientes**; revelar exige `crm.sensitive` e é auditado |
| city, state, neighborhood                               | text null         |                                                                                                                 |
| instagram                                               | text null         |                                                                                                                 |
| company_id                                              | fk null           |                                                                                                                 |
| legal_basis, consented_at, consent_source, consent_text |                   | mesmos campos de `leads`; vêm do RD Marketing na importação                                                     |
| opted_out_at                                            | timestamptz null  | pediu para não ser contatado                                                                                    |
| custom                                                  | jsonb             | campos personalizados (§1.5)                                                                                    |
| rd_contact_id, rd_mkt_uuid                              | text null, unique |                                                                                                                 |
| created_at, updated_at                                  |                   |                                                                                                                 |

**`crm_companies`** — empresa do lead (a marca que quer ser formatada ou a
empresa do investidor)

| coluna                            | tipo      | nota                                                                                                   |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| id, tenant_id                     |           |                                                                                                        |
| name                              | text      |                                                                                                        |
| cnpj                              | text null | mesmo validador do cadastro de clientes                                                                |
| website, instagram, city, service | text null |                                                                                                        |
| client_id                         | fk null   | **quando a empresa vira cliente** da Wings, aponta para `clients` — não duplica o cadastro de clientes |
| rd_id                             |           |                                                                                                        |

**Responsáveis** = `employees`. Nada de tabela de usuários própria. O vínculo
com o RD fica em **`crm_user_map`** (`rd_user_id` → `employee_id` null), só
para a importação e para os 13 inativos.

**`crm_rotation_members`** — quem entra no rodízio de cada funil (§4.1)

| coluna                   | tipo             | nota                |
| ------------------------ | ---------------- | ------------------- |
| pipeline_id, employee_id | pk composta      |                     |
| weight                   | int, padrão 1    | 2 = recebe o dobro  |
| paused_until             | date null        | férias, sobrecarga  |
| last_assigned_at         | timestamptz null | ponteiro do rodízio |

### 1.3 Negociação

**`crm_deals`**

| coluna                                 | tipo                       | nota                                              |
| -------------------------------------- | -------------------------- | ------------------------------------------------- |
| id, tenant_id, client_id               |                            |                                                   |
| title                                  | text                       |                                                   |
| pipeline_id, stage_id                  | fk                         |                                                   |
| status                                 | enum `open \| won \| lost` | **fonte da verdade**; a etapa acompanha (§4.1)    |
| owner_employee_id                      | fk null                    |                                                   |
| contact_id                             | fk                         | contato principal                                 |
| company_id                             | fk null                    |                                                   |
| product_id                             | fk null                    |                                                   |
| amount_cents                           | bigint null                | valor da proposta                                 |
| expected_close_date                    | date null                  |                                                   |
| rating                                 | smallint null              | 1–5, como o RD                                    |
| lost_reason_id                         | fk null                    | obrigatório quando `status = lost`                |
| lost_note                              | text null                  |                                                   |
| won_at, lost_at                        | timestamptz null           |                                                   |
| stage_entered_at                       | timestamptz                | cópia da última linha do histórico, para o kanban |
| last_activity_at                       | timestamptz null           | última tarefa concluída ou anotação               |
| first_contact_due_at, first_contact_at | timestamptz null           | SLA (§4.4)                                        |
| lead_id                                | fk null → `leads`          | a chegada que abriu a negociação                  |
| attribution                            | ver §1.4                   |                                                   |
| custom                                 | jsonb                      | campos personalizados de negociação               |
| rd_deal_id                             | text null, unique          |                                                   |
| rd_source_raw, rd_campaign_raw         | text null                  | como estava no RD                                 |
| created_at, updated_at                 |                            |                                                   |

**`crm_deal_contacts`** — contatos adicionais (sócio, cônjuge): `deal_id`,
`contact_id`, `role` text. 446 contatos do RD têm mais de uma negociação;
vários têm mais de um contato por negociação.

**`crm_deal_products`** — itens da proposta: `deal_id`, `product_id`,
`quantity`, `unit_price_cents`, `discount_cents`.

**`crm_stage_history`** — **o que o RD não tem; obrigatório, append-only**

| coluna                     | tipo                                                              | nota                                   |
| -------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| id                         | bigserial                                                         |                                        |
| tenant_id, deal_id         |                                                                   |                                        |
| from_stage_id              | fk null                                                           | null na criação                        |
| to_stage_id                | fk                                                                |                                        |
| from_status, to_status     | enum                                                              | registra ganho/perda e reabertura      |
| from_owner_id, to_owner_id | fk null                                                           | troca de responsável também entra aqui |
| at                         | timestamptz                                                       |                                        |
| actor_employee_id          | fk null                                                           | null = sistema (rodízio, triagem)      |
| cause                      | enum `manual \| import \| rotation \| triage \| intake \| reopen` |                                        |
| note                       | text null                                                         | sem dado pessoal                       |

Toda mudança de etapa, status ou responsável passa por **uma** função do
serviço (`moveDeal`) que grava a negociação e o histórico na mesma transação.
Não existe outro caminho de escrita em `stage_id`/`status`/`owner_employee_id`.

### 1.4 Atribuição (fonte, campanha, UTM)

Hoje `leads` guarda `campaign_id`/`campaign_name` só para Meta Lead Ads e
**não tem UTM nem click id**. A Fase 1 amplia `leads` (a chegada) e copia um
retrato para a negociação:

Colunas novas em **`leads`**: `utm_source`, `utm_medium`, `utm_campaign`,
`utm_content`, `utm_term`, `gclid`, `fbclid`, `gbraid`, `wbraid`,
`ad_platform` (`meta \| google \| null`), `ad_campaign_external_id`,
`ad_set_external_id`, `ad_external_id`, `referrer`.

Em **`crm_deals`**, o retrato do primeiro toque (não muda depois):
`source_id` (fk `crm_sources`), `attr_platform`, `attr_campaign_external_id`,
`attr_campaign_id` (fk `ad_campaigns` null — ligada quando a ingestão já
conhece a campanha), `attr_utm` jsonb.

Regra: a campanha é resolvida por **id** sempre que houver (Meta Lead Ads
traz; o site traz se a LP passar `utm_id`/`campaign_id` — ver §5.1); por nome
de `utm_campaign` só como último recurso, marcada `attr_confidence = 'name'`.

### 1.5 Campos personalizados

**`crm_custom_fields`**: `id`, `entity` (`contact \| deal \| company`), `key`
(slug estável), `label`, `type` (`text \| number \| option \| multi \| date \|
bool`), `options` jsonb, `pipeline_ids` uuid[] (em quais funis aparece),
`active`, `position`, `rd_crm_id`, `rd_mkt_identifier`.

Os valores ficam no `custom` jsonb da entidade, validados contra a definição
no servidor. Não se usa EAV: com ~40 campos ativos, jsonb com índice GIN
basta para filtrar.

### 1.6 Trabalho do dia

**`crm_tasks`**

| coluna               | tipo                                                                         | nota                               |
| -------------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| id, tenant_id        |                                                                              |                                    |
| deal_id              | fk null                                                                      |                                    |
| assignee_employee_id | fk                                                                           |                                    |
| type                 | enum `call \| whatsapp \| email \| meeting \| visit \| task \| reactivation` | os tipos do RD + reativação (§4.2) |
| subject              | text                                                                         |                                    |
| due_at               | timestamptz                                                                  |                                    |
| done_at              | timestamptz null                                                             |                                    |
| outcome              | text null                                                                    |                                    |
| created_by           | fk null                                                                      | null = sistema                     |
| auto_rule            | text null                                                                    | `triage`, `sla_first_contact`...   |
| rd_task_id           |                                                                              |                                    |

**`crm_notes`** — anotações (as 8.913 `activities` do RD): `deal_id`,
`author_employee_id`, `body`, `created_at`, `rd_activity_id`. O texto é livre
e pode ter dado pessoal: fica só aqui, nunca em log.

**`crm_events`** — linha do tempo técnica, append-only, sem dado pessoal
(mesmo papel de `lead_events`): `deal_id`, `kind`, `actor`, `detail` jsonb.

### 1.7 Configuração

**`crm_settings`** (uma linha por tenant): `triage_reactivation_days` (padrão
7), `triage_default_stale_days` (padrão 90), `first_contact_sla_minutes`
(padrão 15 no horário comercial), `business_hours` jsonb,
`rotation_enabled` bool.

### 1.8 Permissões

Chaves novas em `packages/shared/src/rbac/permissions.ts`, no padrão
`<módulo>.<ação>`:

| chave           | o que libera                                                         |
| --------------- | -------------------------------------------------------------------- |
| `crm.read`      | ver negociações, contatos, tarefas (escopo own/sector/all)           |
| `crm.write`     | criar e editar negociação, mover etapa, tarefa, anotação (no escopo) |
| `crm.reassign`  | trocar responsável de negociação que não é sua                       |
| `crm.sensitive` | revelar CPF do contato (auditado)                                    |
| `crm.export`    | exportar lista (auditado, com contagem, sem conteúdo no log)         |
| `crm.configure` | funis, etapas, motivos, campos, rodízio, SLA, triagem                |
| `crm.import`    | rodar a importação do RD                                             |

Matriz proposta, seguindo `leads.*`: Admin Master e Gerente Comercial
`all` em tudo; Diretoria `crm.read` `all` (e as demais se decidir, §8);
Vendedor Expansão / Formatação `crm.read`+`crm.write` **`own`**; gestor de
setor (`is_sector_manager`) ganha `crm.reassign` no `sector`. O escopo é
aplicado na consulta (`owner_employee_id = actor` para `own`), nunca só na
tela. A navegação usa o módulo `crm-vendas` que já existe (`/crm-vendas/funil`
passa a ser o kanban).

## 2. Telas

Todas em `/crm-vendas/*`. Em cada uma, o que aparece e o que se clica:

1. **Kanban por funil** (`/crm-vendas/funil/:pipeline`). Seletor de funil no
   topo; uma coluna por etapa `open`, com contagem e soma de valor. Cartão:
   título, empresa, responsável (foto), dias na etapa (vermelho acima do
   `sla_hours`), ícone de tarefa atrasada. Arrastar muda de etapa (grava o
   histórico). Botões **Ganhar** e **Perder** no cartão; Perder abre a lista
   de motivos (obrigatório). Filtros: responsável, produto, fonte, "só
   paradas", "só sem tarefa".
2. **Detalhe da negociação** (`/crm-vendas/negociacoes/:id`). À esquerda:
   contato (CPF mascarado; botão "Revelar" só com `crm.sensitive`), empresa,
   produto, valor, campos personalizados do funil, atribuição (fonte,
   plataforma, campanha com link para o Agente de Tráfego). No centro: linha
   do tempo única (anotações, tarefas, mudanças de etapa com duração em cada
   uma, mensagens do Funil Sofia). À direita: tarefas abertas, botão "Nova
   tarefa", "Trocar responsável" (com `crm.reassign`).
3. **Lista com filtros** (`/crm-vendas/negociacoes`). Tabela com todos os
   funis: filtros por funil, etapa, status, responsável, fonte, campanha,
   produto, período de criação/ganho/perda, dias sem atividade, campo
   personalizado. Ações em lote: trocar responsável, criar tarefa, marcar
   perdida (com motivo). Exportar CSV com `crm.export`.
4. **Tarefas do dia** (`/crm-vendas/tarefas`). A tela de abertura do vendedor:
   atrasadas, hoje, amanhã; "primeiro contato pendente" no topo com o
   cronômetro do SLA. Concluir pede o resultado em uma linha.
5. **Painel do gestor** (`/crm-vendas/painel`, `crm.read` `sector`/`all`):
   - **SLA de primeiro contato**: % dentro do prazo, mediana, por
     responsável e por fonte.
   - **Paradas**: negociações acima do `sla_hours` da etapa e as da triagem
     (§4.2), por responsável.
   - **Conversão por etapa com histórico real**: de cada etapa para a
     seguinte, tempo médio em cada uma, por coorte de entrada (mês). Só conta
     o que tem `crm_stage_history` com `cause <> 'import'` — ver §3.7.
   - **Carteira**: negociações abertas por responsável e funil, com o
     rodízio (quem está pausado).
   - **Ganhos e perdas**: por motivo, por fonte, por campanha.

## 3. Importação do RD

Script `crm-import` (CLI na API, como o `ingest-cli`), com `--dry-run` que
lê tudo, monta o plano e imprime só contagens. Idempotente por `rd_*_id`:
rodar de novo atualiza, não duplica. Nunca grava no RD.

### 3.1 Ordem

1. Usuários → `crm_user_map` (manual, na tela de configuração: cada um dos 17
   usuários ligado a um funcionário ou marcado "inativo").
2. Funis e etapas (9 e 77), motivos de perda (18), produtos (5), fontes (46 →
   ~15 chaves), campos personalizados (33 do CRM + os do Marketing escolhidos).
3. Empresas (801).
4. Contatos (5.577), com deduplicação (§3.2) e enriquecimento do RD Marketing
   (campos `cf_*`, base legal, `uuid`).
5. Negociações (5.903), com status, etapa, responsável, produto, campos.
6. Tarefas (20.542) e anotações (8.913).
7. Histórico: uma linha `cause = 'import'` por negociação (§3.7).
8. Validação (§3.8).

### 3.2 Deduplicação

Mesma ordem do `upsertLead`: id de origem → telefone normalizado → e-mail
minúsculo. No RD hoje: **65 e-mails** repetidos (132 contatos) e **213
telefones** repetidos (497 contatos). O importador:

- junta automaticamente só quando **e-mail e telefone** batem;
- quando só um bate, **não junta**: grava o par em `crm_merge_candidates`
  e a tela de configuração mostra "possíveis duplicados" para uma pessoa
  decidir (telefone repetido costuma ser um casal ou sócios);
- contato sem e-mail e sem telefone válido (35) entra marcado
  `needs_review`;
- depois da importação, cada lead do Funil Sofia (`leads`) é ligado ao
  contato pelo mesmo critério.

### 3.3 Campos do RD CRM

| RD (objeto → campo)                                               | Wings                                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| deal.name                                                         | `crm_deals.title`                                                          |
| deal.deal_stage → pipeline                                        | `stage_id`, `pipeline_id`                                                  |
| deal.win (`true/false/null`)                                      | `status` `won/lost/open`                                                   |
| deal.closed_at                                                    | `won_at` ou `lost_at`                                                      |
| deal.hold                                                         | `status = open` + evento `paused` (1 caso)                                 |
| deal.user                                                         | `owner_employee_id` via `crm_user_map`                                     |
| deal.rating                                                       | `rating`                                                                   |
| deal.amount_total / amount_unique / amount_montly                 | `amount_cents` (total); os outros dois em `custom`                         |
| deal.prediction_date                                              | `expected_close_date`                                                      |
| deal.deal_source                                                  | `source_id` + `rd_source_raw`                                              |
| deal.campaign                                                     | `rd_campaign_raw`; `attr_*` só se o nome casar com campanha conhecida      |
| deal.deal_lost_reason                                             | `lost_reason_id` (a API de listagem não devolve; ler por negociação, §3.6) |
| deal.deal_products                                                | `crm_deal_products`                                                        |
| deal.contacts                                                     | `contact_id` (o primeiro) + `crm_deal_contacts`                            |
| deal.created_at / updated_at / last_activity_at                   | idem                                                                       |
| contact.name, emails[], phones[]                                  | `name`, `email` + `extra_emails`, `phone` + `extra_phones`                 |
| contact.title, birthday, facebook, linkedin                       | `custom`                                                                   |
| contact.legal_bases                                               | `legal_basis`, `consented_at`, `consent_source = 'rd_crm'`                 |
| contact.organization_id                                           | `company_id`                                                               |
| organization.name, url, custom Instagram/Site/Cidade/Serviço/CNPJ | `crm_companies`                                                            |
| task.* (`subject,type,date,hour,done,done_date,user_ids,notes`)   | `crm_tasks`                                                                |
| activity.* (`text,date,user_id,deal_id`)                          | `crm_notes`                                                                |

Campos personalizados do CRM (33):

| Entidade   | Campo RD                                                                                                    | Destino                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| contato    | Cidade, Bairro                                                                                              | `city`, `neighborhood`                                                                              |
| contato    | Instagram                                                                                                   | `instagram`                                                                                         |
| contato    | CPF                                                                                                         | `cpf_encrypted`/`cpf_index` (hoje 0 preenchidos)                                                    |
| contato    | Número do celular                                                                                           | `extra_phones` (normalizado)                                                                        |
| contato    | Origem, Origem do contato, Campanha                                                                         | `rd_source_raw`/`custom`; alimentam a fonte                                                         |
| contato    | Data de criação                                                                                             | descartado (há `created_at`)                                                                        |
| contato    | Franquia / serviço de interesse (13 opções), Qualificação (2)                                               | `custom` (opção)                                                                                    |
| negociação | Nome da Marca                                                                                               | `crm_companies.name` quando não houver empresa                                                      |
| negociação | Segmento (franquia), Faturamento mensal - Formatação, Já trabalha com franquia                              | `custom` (opção)                                                                                    |
| negociação | Investimento disponível para franquia + 5 variações por faixa + "Investimento Disponível" + "Insvestimento" | **um** campo `investimento_disponivel` (opção, faixas unificadas); a origem fica em `custom.rd_raw` |
| negociação | Budget, Observações, OBS                                                                                    | `custom.budget`; Observações e OBS viram **uma anotação**                                           |
| negociação | Quem te Indicou?                                                                                            | `custom.indicado_por`                                                                               |
| negociação | CPF ou CPNJ (número)                                                                                        | CNPJ (14 dígitos) → empresa; CPF (11) → contato, cifrado; o número nunca é registrado em log        |
| empresa    | Instagram, Site, Cidade, Serviço, CNPJ                                                                      | colunas de `crm_companies`                                                                          |

### 3.4 Campos do RD Marketing (87 `cf_*`)

O RD Marketing é a base de contatos das LPs; o CRM só recebe o que o
vendedor usa. O importador lê os campos pelo `uuid`/e-mail do contato e
aplica o mapa abaixo. Os identificadores exatos (`cf_...`) saem da leitura
`GET /platform/contacts/fields` no dia da importação e ficam em
`crm_custom_fields.rd_mkt_identifier`.

| Grupo (qtde)                | Exemplos                                                                                                                                                               | Destino                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Endereço (6)                | Rua, Bairro, CEP, Estado1, Localização, Nacionalidade                                                                                                                  | `city/state/neighborhood`; Rua e CEP em `custom`                                   |
| Identificação (5)           | Primeiro Nome, Sobrenome, Estado Civil, Profissão, CPF ou CNPJ                                                                                                         | nome já vem; CPF/CNPJ como §3.3; o resto em `custom`                               |
| Contato (4)                 | Site - WhatsApp, Site - Email, Instagram, Site ou Instagram (+ `cf_cf_site_ou_instagram`)                                                                              | `extra_phones`, `extra_emails`, `instagram`                                        |
| Investimento por faixa (6)  | Investimento disponível para franquia - 25 a 75 mil ... A partir de 500 mil                                                                                            | `investimento_disponivel` (unificado)                                              |
| Investimento por marca (11) | Caval Barber Shop, Florir Café, Na Chapa, Espaço Felipe Nilo, Bazar das Flores, Churros Delivery, Odin, Valhalla, Luccas Toon, Dona Bonitex, "Investimento Disponível" | `investimento_disponivel` + `custom.marca_interesse` = a marca do campo            |
| Perguntas por marca (8)     | Florir/Conytos: "Você já empreende...", "Qual o valor disponível...", "Qual a sua disponibilidade...", "Você gostaria de receber", local desejado                      | `custom.qualificacao` (objeto por marca)                                           |
| Formatação (4)              | Faturamento mensal - Formatação, Nome da Marca, Segmento (franquia), Observações complementares (FMT)                                                                  | mesmos destinos do CRM (§3.3)                                                      |
| Quiz (10)                   | Quiz p1 ... p10                                                                                                                                                        | `custom.quiz` (lista) — visível só no detalhe                                      |
| Intenção (6)                | Objetivo, Objetivo - escolha única, `cf_cf_objetivo`, O que você quer agora?, Em qual etapa você está?, Motivação para investir, Maturidade do lead, Perfil do lead    | `custom.intencao` (unificado); **Maturidade** vira campo próprio (entra no painel) |
| Origem (4)                  | Origem, Origem do formulário, Campanha, Quem te indicou?                                                                                                               | fonte/atribuição (§1.4); o texto em `rd_source_raw`                                |
| Retorno (3)                 | Como prefere retorno?, `cf_cf_preferencia_de_retorno`, Mensagem via Website / Mensagem                                                                                 | preferência em `custom`; mensagens viram anotação                                  |
| Espelho do CRM (8)          | `cf_plug_*` (etapa, funil, responsável, valor, motivo de perda, origem, qualificação)                                                                                  | **descartados** — são cópia do próprio RD CRM                                      |
| Dados financeiros (2)       | Pix, Dados Bancários                                                                                                                                                   | **não importados** (sem uso comercial; risco LGPD). Decisão da Diretoria/Jurídico  |
| Outros (≈10)                | Serviço, OBS, Observações, Consentimento, `cf_cf_etapa` etc.                                                                                                           | Consentimento → base legal; o resto em `custom`                                    |

A contagem exata por grupo sai do `--dry-run`, que lista cada `cf_*` com o
destino e quantos contatos têm valor — é o documento que a Diretoria aprova
antes da importação real.

### 3.5 As 157 negociações no funil errado e os motivos antigos

- **Negócios perdidos - Formatação (96) e - Expansão (59), em andamento:**
  importadas como `lost`, no funil de **origem** (Formatação ou Expansão,
  deduzido do nome do funil), etapa `lost`. Motivo: o que estiver na
  negociação; se nenhum, "Sem resposta" quando a etapa do RD for
  "Reativar - …" ou "Sem motivo de perda", senão "Outros" com a nota
  `"importado de <etapa do RD>"`.
- **Vendidos | Expansão (2), em andamento:** importadas como `won` no funil
  Expansão, `won_at` = `updated_at` do RD.
- **1 ganha dentro de "Negócios perdidos - Expansão":** vai para a lista
  "revisar" da importação; ninguém decide sozinho.
- Os 4 funis Vendidos / Negócios perdidos **não são criados** no Wings. No
  lugar deles: filtro "Ganhas"/"Perdidas" em qualquer funil. As etapas
  "Reativar - 09/2025 ... 2026" viram a triagem (§4.2).
- Os 18 motivos do RD entram **inativos** e mapeados para os 10 padrões
  (§4.3); o original fica em `lost_note`.

### 3.6 Limites da API do RD que mudam o plano

- `GET /deals` pagina por cursor (`next_page`) e trouxe as 5.903.
- `GET /tasks` e `GET /contacts` com `page`: **a página 51 responde 400**
  (limite de 10.000 itens). Tarefas (20.542) precisam ser lidas por
  negociação ou em janelas de data.
- A listagem de negociações **não traz o motivo de perda**: é preciso ler
  cada negociação perdida (4.523 chamadas, dentro do limite por minuto do
  CRM, ~1 h).
- O RD Marketing tem limite de 120 consultas/min por conta, compartilhado com
  outros usos (backup): o importador lê com fila, espera no 429 e nunca
  paraleliza.

### 3.7 Histórico de etapas na importação

O RD não tem histórico. Cada negociação importada ganha **uma** linha em
`crm_stage_history` com `cause = 'import'`, `at = updated_at` do RD e a etapa
atual. O painel **não usa** essas linhas para conversão ou tempo por etapa:
a conversão real começa no dia da virada. Ganho e perda do passado (datas do
RD) entram nos relatórios de resultado, não nos de funil.

### 3.8 Validação (contagens batendo com o RD)

O importador termina com um relatório (e grava em `crm_import_runs`):

| Checagem                                       | Esperado                                                  |
| ---------------------------------------------- | --------------------------------------------------------- |
| negociações por funil de origem e status       | igual ao RD, com as 157 movidas explicadas linha a linha  |
| soma de `amount_total` por funil e status      | igual ao RD, ao centavo                                   |
| contatos                                       | 5.577 − juntados automaticamente, com a lista de juntados |
| empresas, tarefas, anotações                   | 801 / 20.542 / 8.913                                      |
| tarefas abertas por responsável                | igual ao RD                                               |
| negociação sem contato, contato sem negociação | contados, não perdidos                                    |
| campos personalizados preenchidos              | por campo, igual ao RD                                    |

Uma rodada em staging, conferida pela Diretoria na tela; depois a de
produção.

## 4. Regras de negócio

### 4.1 Status, etapa e rodízio

- Ganhar/perder muda `status`, move para a etapa `won`/`lost` do **mesmo
  funil** e grava o histórico. Perder exige motivo. Reabrir volta para a
  última etapa `open` (`cause = 'reopen'`). Não existe funil de arquivo.
- **Rodízio automático** quando entra uma negociação sem responsável (lead
  novo, carteira de quem saiu):
  - escolhe entre os `crm_rotation_members` do funil, ativos
    (`employees.status = 'active'`) e não pausados;
  - critério: **menor carga aberta ponderada pelo peso**, empate pelo
    `last_assigned_at` mais antigo (rodízio justo que não afoga quem já está
    cheio);
  - a opção "excluir pessoa do funil" é tirar a linha de
    `crm_rotation_members` ou pôr `paused_until`;
  - roda sob `pg_advisory_xact_lock` por funil (dois leads ao mesmo tempo
    não vão para a mesma pessoa por corrida);
  - cria a tarefa de primeiro contato (§4.4) e avisa no WhatsApp do
    responsável (Z-API, já configurado), **sem dado do lead na mensagem**
    além do primeiro nome e o link.
- **Desligamento de funcionário** (status ≠ `active`): a carteira aberta
  entra no rodízio automaticamente, com `cause = 'rotation'` e evento de
  auditoria `crm.portfolio_redistributed` (contagens, sem nomes de lead).
- **Carga inicial** (os 423 órfãos + os do §3.5): o `--dry-run` mostra a
  proposta de redistribuição por funil (igual ao ensaio de 25/09) e a
  Diretoria aprova antes; só então o importador aplica.

### 4.2 Triagem de parados

- Uma negociação `open` sem atividade há mais de `stale_after_days` da etapa
  (padrão 90, configurável) entra na triagem.
- Triagem = tarefa `reactivation` para o responsável **atual** (ou o do
  rodízio, se o atual estiver inativo), com prazo de
  `triage_reactivation_days` (padrão 7).
- Tarefa concluída com resultado "respondeu": sai da triagem. Vencida sem
  conclusão: a negociação é marcada `lost`, motivo "Sem resposta",
  `cause = 'triage'`, **reversível** por "Reabrir".
- Roda uma vez por dia (tarefa agendada no Coolify, como a ingestão), com
  limite por rodada e relatório no painel. Na primeira rodada: 82
  (Formatação) + 277 (Expansão) em "Tentando contato" há mais de 90 dias.
- A regra é do CRM e **não** toca em verba de anúncio: a regra de "nenhuma
  automação em gasto de mídia" do CLAUDE.md não se aplica e não é afetada.

### 4.3 Motivos de perda padrão

1. Sem resposta
2. Contato inválido ou sem telefone
3. Duplicidade
4. Sem capital no momento
5. Não prioriza agora
6. Fechou com outra empresa
7. Fora do perfil (segmento ou região)
8. Preço
9. Desistiu do projeto
10. Outros (observação obrigatória)

De-para dos 18 atuais: "Lead parou de responder", "Ciclo de vendas
finalizado sem resposta", "Demora no follow" → 1; "Contato inválido", "Lead
sem número de telefone", "Lead não se lembra de ter solicitado contato" → 2;
"Duplicidade" → 3; "Sem capital para realizar o projeto no momento" → 4;
"Lead não está priorizando o projeto" → 5; "Fechou com outra empresa" → 6;
"Lead desqualificado", "Região inválida para expansão", "Não oferecemos
franquias no segmento que o lead procurava" → 7; "Preço" → 8; "Cliente optou
por não realizar o projeto", "Divergência entre sócios", "Não gosto do
produto/serviço" → 9; "Outros" → 10.

### 4.4 SLA de primeiro contato

- Começa quando a negociação ganha responsável (`first_contact_due_at =
agora + first_contact_sla_minutes`, contado só no horário comercial).
- Termina na primeira tarefa concluída de tipo `call`/`whatsapp`/`email`
  **ou** na saída da etapa `is_first_contact`.
- Estourou: alerta ao responsável e ao gestor do setor; aparece no painel.
  **Não** redistribui sozinho na Fase 1 (decisão da Diretoria, §8).

## 5. Entrada de leads

### 5.1 Portas

Todas continuam sendo as do Funil Sofia (`leads`, `upsertLead`). A Fase 1
acrescenta, depois do `upsertLead`:

1. contato: acha ou cria `crm_contacts` pelo mesmo critério;
2. negociação: se o contato **não** tem negociação `open` no funil de
   destino, cria uma (etapa inicial, `cause = 'intake'`); se tem, só grava o
   evento "voltou a converter" e cria tarefa para o responsável;
3. funil de destino: regra por LP/formulário/campanha, como as
   `lead_source_rules` que já existem (tabela ganha a coluna `pipeline_id`);
4. rodízio (§4.1) e SLA (§4.4).

Atribuição por porta:

| Porta                                                        | O que chega                         | O que falta construir                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Site (formulário RD em `wingscompany.com.br/contato/` e LPs) | webhook do RD Marketing             | a LP gravar `utm_*`, `gclid`, `fbclid` em campos ocultos do formulário RD (GTM), e o webhook ler esses campos para `leads.utm_*` |
| Meta Lead Ads                                                | form id, ad id, campaign id (Graph) | nada além de gravar também `ad_set`/`ad` e `ad_platform = meta`                                                                  |
| Google Ads (formulário de lead / LP)                         | `gclid` via LP                      | idem site; formulário de lead do Google é Fase 2                                                                                 |
| WhatsApp (link rastreável)                                   | código do link → cliente            | `lead_tracking_links` ganha `utm_*`/campanha, para o link de anúncio carregar a campanha                                         |
| Manual                                                       | escolhido na tela                   | fonte obrigatória                                                                                                                |

### 5.2 Convivência com o RD

- **Semana 0 (virada):** importação completa; a partir daí o Wings é onde se
  trabalha. O RD CRM fica **só leitura** para a equipe (combinado, não
  técnico).
- **Durante a convivência (2 a 4 semanas):** os leads continuam chegando ao
  RD Marketing (que segue sendo a ferramenta de LP e e-mail na Fase 1) **e**
  ao Wings pelo webhook. Uma sincronização diária de ida (RD CRM → Wings, só
  leitura) acusa qualquer negociação criada ou movida no RD por engano, e o
  painel mostra "movimentos no RD desde a virada".
- **Critério para desligar o RD CRM** (todos por 10 dias úteis seguidos):
  1. zero negociações criadas ou movidas no RD;
  2. 100% dos leads do webhook viraram negociação no Wings (conferido contra
     a contagem de conversões do RD Marketing);
  3. SLA e tarefas do dia em uso por todos os vendedores ativos;
  4. relatório de ganhos do mês fechado pelo Wings igual ao da planilha da
     Diretoria.
- O RD **Marketing** não é desligado na Fase 1.

## 6. Integração com o Agente de Tráfego

- **CPL real por campanha** = gasto da campanha (`ad_metrics_daily`) ÷
  negociações criadas com `attr_campaign_id` = campanha, no período. Hoje o
  CPL usa a conversão que a plataforma informa; os dois aparecem lado a
  lado ("Meta diz" × "chegou ao CRM").
- **CAC real** = gasto ÷ negociações **ganhas** atribuídas, por campanha, por
  funil/produto, com a janela de tempo configurável (ganho em até N dias do
  lead).
- **Taxa por etapa por campanha**: quantos leads da campanha chegaram a
  "Reunião realizada", "Proposta enviada", ganho — vinda do histórico real.
- O Agente de Tráfego **lê** esses números (tabelas próprias do CRM, com o
  escopo de quem pergunta) e pode citá-los numa proposta. **Não** move
  negociação, não cria tarefa e não muda verba — a regra do agente
  (lê e propõe) continua a mesma.
- Valor para as plataformas (envio de conversões offline para Meta/Google)
  fica para a Fase 2 e passa pelo Jurídico (LGPD).

## 7. Fases, estimativa e riscos

Estimativa em dias de trabalho de desenvolvimento, com testes, sem contar
revisão e espera de decisões:

| Etapa                | Conteúdo                                                                                     |   Dias |
| -------------------- | -------------------------------------------------------------------------------------------- | -----: |
| 1. Base              | schema `crm.ts`, migração, permissões, navegação, `moveDeal` + histórico append-only, grants |      4 |
| 2. Importador        | `crm-import --dry-run`, dedupe, mapa de campos CRM + Marketing, relatório de validação       |      5 |
| 3. Telas de trabalho | kanban, detalhe, lista com filtros e lote, tarefas do dia                                    |      7 |
| 4. Regras            | rodízio, triagem, SLA, motivos, configuração                                                 |      4 |
| 5. Entrada de leads  | `leads` → contato → negociação, UTMs, `pipeline_id` nas regras, WhatsApp do responsável      |      3 |
| 6. Painel e tráfego  | painel do gestor, CPL/CAC real por campanha                                                  |      4 |
| 7. Virada            | importação em staging, conferência, produção, sync de convivência                            |      3 |
| **Total**            |                                                                                              | **30** |

Mais **2 a 4 semanas de convivência** (calendário, não trabalho).

Riscos:

- **Formato do webhook do RD Marketing não verificado ao vivo** (o próprio
  Funil Sofia marca isso). Sem ele, a entrada pelo site não chega. Mitigação:
  verificar antes da etapa 5, com log de forma.
- **Campos ocultos de UTM nas LPs do RD** dependem de quem mantém as LPs e o
  GTM. Sem eles, CPL/CAC do site fica "por nome" ou sem campanha.
- **Qualidade dos dados**: 1.574 contatos sem e-mail, 497 com telefone
  repetido; a dedupe conservadora deixa trabalho manual.
- **Limites da API** (10.000 por paginação, motivo de perda por negociação,
  120/min no Marketing compartilhado): importação de horas, não minutos.
- **Adoção**: a equipe trabalha no RD há anos; sem o critério do §5.2 o RD
  continua sendo usado "só um pouquinho".
- **LGPD**: CPF e anotações livres passam a morar no Wings. CPF cifrado;
  anotações nunca em log; exportação auditada. Base legal da importação
  (continuar tratando os 4.093 contatos sem base registrada) é pergunta do
  Jurídico.
- **Portabilidade de histórico**: conversão por etapa só vale do dia da
  virada em diante; os primeiros relatórios terão pouco dado.

Fica para a **Fase 2**:

- formulários e landing pages próprios (substituir as LPs do RD Marketing);
- automação de marketing e e-mail (réguas, nutrição, segmentações);
- Sofia/SDR conversando com o lead (parte 2 do Funil Sofia);
- redistribuição automática por SLA estourado;
- conversões offline para Meta/Google;
- formulário de lead do Google Ads;
- desligar o RD Marketing.

## 8. Decisões que dependem da Diretoria

1. **Redistribuição inicial** dos 423 órfãos: igualar por funil (proposta do
   ensaio) ou poupar a Thais, que já tem 285 em Parcerias/Lista de
   espera/Estruturação.
2. **Quem entra no rodízio** de cada funil, com peso.
3. **Lista de motivos de perda** (os 10 do §4.3) e o de-para dos 18.
4. **Triagem**: 90 dias parado e 7 dias para reativar — confirmar ou mudar,
   e se vale para todos os funis.
5. **SLA de primeiro contato**: quantos minutos e qual horário comercial.
6. **O que importar do passado**: todas as 20.542 tarefas ou só as abertas +
   as dos últimos 12 meses; as 8.913 anotações.
7. **Campos do RD Marketing**: aprovar o mapa do §3.4, em especial unificar
   os 17 campos de investimento e **não** importar Pix / Dados Bancários.
8. **Diretoria no CRM**: só leitura (`crm.read all`) ou também edição.
9. **Critério de desligar o RD CRM** (§5.2) e a data da virada.
10. **Jurídico**: base legal para os contatos sem base registrada e para
    guardar CPF de lead.
