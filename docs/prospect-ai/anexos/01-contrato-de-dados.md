# Anexo 1 — Contrato de dados

Parte da [especificação do Wings Prospect AI](../ESPECIFICACAO.md), seção 2. Código de referência: commit `c4168cb` da develop. Abreviações: `api` = `apps/api/src`, `shared` = `packages/shared/src`.

## 2.0 Regras que valem para todas as tabelas novas

- Toda tabela tem `tenant_id uuid not null default WINGS_TENANT_ID references tenants` (helper em `api/db/schema/leads.ts:21-25`), como `meta_leadgen_events` (`api/db/schema/meta-leads.ts:36`). Uniques de negócio incluem `tenant_id`.
- Chave primária `id uuid default gen_random_uuid()`; datas `timestamptz`; dinheiro em inteiro (`*_cents`, `*_micro_usd`), como manda `AGENTS.md` ("Naming").
- Estados e enums são `text` com `CHECK` no banco **e** a mesma lista em Zod no `shared`. Exceção: o slug de categoria (serviço), que é configurável em Ajustes e por isso só o Zod confere (ver 2.6).
- Nenhuma coluna guarda dado do Google além do `place_id` (regra atual, `docs/crm/prospeccao.md:9`).
- Do Instagram, só o que está aqui. **Não se guarda**: foto, bio, número de seguidores da pessoa, telefone achado fora da conversa, nem histórico completo do Direct. Isso segue os Termos da Plataforma da Meta, item 3.a.v: não montar nem enriquecer perfis.
- Tabelas novas são exportadas em `api/db/schema/index.ts` (padrão da linha :19). As migrations saem de `pnpm --filter @wings/api db:generate`. O `GRANT` para `wings_ro` vai numa migration própria, no molde de `0075_grant_wings_ro_ad_lead_forms.sql`, para todas as tabelas novas **menos** `ig_webhook_events` (tem o corpo bruto).
- Retenção: cada prazo é um campo de `prospect_ai_settings.settings.retention` (2.6). A limpeza é feita pelo agendador do PR C7. Prazos propostos estão no [anexo jurídico §5](juridico.md#5-prazos-de-retenção-propostos--a-validar), marcados "a validar".

## 2.1 Ordem das migrations

A `0098` é do PR `feat/trava-unica-contato` (`contact_opt_outs`). Os números abaixo valem se ela entrar primeiro. Pela regra de 27/10 (`AGENTS.md`, "Migrations"), quem fizer merge depois **regera** a migration (nova numeração e novo `when`), nunca só renomeia.

| Nº | Arquivo (nome sugerido) | PR | Conteúdo |
|---|---|---|---|
| 0099 | `0099_prospect_ai_base.sql` | C1 | `prospect_ai_settings`, `prospect_evidence`, `prospect_opportunities`, `prospect_classifications`, `prospect_source_health` |
| 0100 | `0100_prospect_classifier.sql` | C3 | `prospect_classifier_cache`, `prospect_classifier_runs` |
| 0101 | `0101_prospect_call_logs.sql` | C5 | `prospect_call_logs` |
| 0102 | `0102_instagram_intake.sql` | D1 | `ig_webhook_events`, `ig_people`, `ig_private_replies` |
| 0103 | `0103_competitor_radar.sql` | E1 | `competitor_accounts`, `competitor_posts` |
| 0104 | `0104_dw_funil_fonte.sql` (`--custom`) | F1 | `dw.dim_fonte`, `dw.dim_categoria_servico`, `dw.dim_campanha_resumo`, `dw.fato_funil_fonte_diario`, `dw.fato_custo_fonte_diario`, visões |
| 0105 | `0105_grant_wings_ro_prospect_ai.sql` (`--custom`) | F1 | `GRANT SELECT` em todas as tabelas acima, menos `ig_webhook_events` |

**Colisão de números já à vista** (PRs abertos em 29/10, nenhum na develop): a pilha da Central WhatsApp usa `0098_wa_central` (#41), `0099_wa_attendance` (#38) e `0100_wa_reliability` (#39), e o #37 (Ads Intelligence) usa `0103_ads_intelligence`. Os números acima são indicativos: cada PR do Prospect AI gera a sua migration com `db:generate` sobre a develop do dia e regera se outro entrar antes.

Dependências entre tabelas: `prospect_opportunities` → `prospect_evidence`, `leads`, `employees`; `ig_private_replies` → `prospect_opportunities`; `competitor_posts` → `competitor_accounts`. Nada aponta para `contact_opt_outs`: a consulta é sempre pela função única do PR da trava.

## 2.2 `prospect_evidence` — a prova de cada oportunidade (C1)

Uma linha por fato observado: um comentário, uma mensagem do Direct, um registro manual do radar. **Só inserção**; a limpeza de retenção é a única exceção (apaga a linha inteira ou zera `excerpt`, `author_username` e `author_igsid`).

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id`, `id` | uuid | padrão 2.0 |
| `source` | text not null | CHECK em (`instagram_comment`, `instagram_dm`, `instagram_ad_comment`, `instagram_ad_referral`, `instagram_mention`, `competitor_radar`) |
| `external_id` | text not null | id no sistema de origem: id do comentário, `mid` da mensagem ou, no radar, o link do comentário normalizado (sem query string, minúsculo) |
| `url` | text | link público. Comentário: permalink do post (lido uma vez por post, ver 3.1 passo 3). Radar: link que o vendedor colou (CHECK começa com `https://www.instagram.com/`). Direct: nulo (não há link público) |
| `occurred_at` | timestamptz not null | data do comentário ou da mensagem na origem; no radar, a data informada pelo vendedor ou, se ele não informar, a do registro |
| `excerpt` | text | **trecho mínimo**: no máximo 280 caracteres (CHECK `char_length(excerpt) <= 280`), cortado no código antes de gravar |
| `author_igsid` | text | id da pessoa no Instagram (IGSID, ver 2.10). Nulo no radar |
| `author_username` | text | @ sem o arroba, minúsculo. No radar, o @ da **empresa** |
| `media_id` | text | id do post ou anúncio no Instagram (quando houver) |
| `ad_id` | text | id do anúncio, quando o comentário ou o referral vier de anúncio |
| `legal_basis` | text not null | CHECK em `LEAD_LEGAL_BASES` (`consent`, `pre_contract`, `legitimate_interest`; `shared/leads.ts:119`). Padrão por fonte em 3.6 |
| `retention_until` | timestamptz | calculado na inserção (`occurred_at` + prazo da fonte); vira nulo quando a oportunidade gera lead (passa a valer a retenção do lead) |
| `recorded_by` | uuid → employees | quem registrou; nulo quando automático (webhook) |
| `created_at` | timestamptz not null default now() | |

Índices: **unique** `(tenant_id, source, external_id)` (o mesmo evento não gera duas evidências); `(tenant_id, author_igsid)`; `(retention_until)` para a limpeza.

## 2.3 `prospect_opportunities` — a fila (C1)

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id`, `id` | uuid | |
| `evidence_id` | uuid not null → `prospect_evidence` (on delete restrict) | a prova que abriu a oportunidade. **Unique** `(evidence_id)`: uma evidência abre no máximo uma oportunidade |
| `source` | text not null | a mesma lista de 2.2 (copiada para filtrar sem join) |
| `state` | text not null default `'nova'` | CHECK em (`nova`, `em_revisao`, `aprovada`, `rejeitada`, `duplicada`, `prazo_vencido`). Transições em 3.5 |
| `category` | text | slug do serviço principal (lista configurável, 2.6). Nulo = ainda não classificada |
| `secondary_categories` | text[] not null default `'{}'` | CHECK `cardinality(secondary_categories) <= 3` |
| `intent` | text | CHECK em (`interesse_declarado`, `necessidade_provavel`, `conteudo_educativo`, `comentario_casual`, `outro_assunto`, `informacao_insuficiente`) |
| `priority` | smallint | CHECK 0–100. Cálculo em 3.7 |
| `confidence` | smallint | CHECK 0–100 |
| `justification` | text | a frase do texto que motivou a classificação (no máximo 200 caracteres, CHECK) |
| `classification_id` | uuid → `prospect_classifications` | a classificação vigente |
| `needs_review_reason` | text | por que exige humano: `confianca_baixa`, `revisao_obrigatoria`, `servico_nao_vendido`, `sem_ia`, `teto_ia`, `ia_invalida`, `registro_manual`. Nulo quando não exige |
| `owner_employee_id` | uuid → employees | dono |
| `respond_by` | timestamptz | prazo para responder (3.1 e 3.2). Nulo no radar |
| `responded_at` | timestamptz | primeira resposta humana (eco do Direct, se a Meta mandar, ou o botão "Respondi") |
| `lead_id` | uuid → leads (on delete set null) | lead gerado ou juntado |
| `duplicate_of_opportunity_id` | uuid → `prospect_opportunities` | quando `duplicada` |
| `decided_by` | uuid → employees | quem aprovou, rejeitou ou marcou duplicada; nulo quando foi a regra automática |
| `decided_at` | timestamptz | |
| `decision_reason` | text | motivo livre curto (no máximo 300) |
| `ig_person_id` | uuid → `ig_people` (on delete set null) | só Instagram |
| `created_at`, `updated_at` | timestamptz not null default now() | |

CHECKs de coerência: `state = 'aprovada'` exige `lead_id is not null`; `state = 'duplicada'` exige `lead_id` ou `duplicate_of_opportunity_id`; `state in ('aprovada','rejeitada','duplicada')` exige `decided_at`.

Índices: `(tenant_id, state, respond_by)` (a fila ordena por prazo), `(tenant_id, owner_employee_id, state)`, `(tenant_id, source, created_at)`, `(lead_id)`, `(ig_person_id)`.

## 2.4 `prospect_classifications` — histórico da classificação (C1)

Só inserção. Cada classificação (regra, IA ou pessoa) é uma linha; a oportunidade aponta para a vigente. É daqui que sai o acerto do piloto (100% revisado nas duas primeiras semanas).

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id`, `id` | uuid | |
| `opportunity_id` | uuid not null → `prospect_opportunities` (on delete cascade) | |
| `method` | text not null | CHECK em (`palavra_chave`, `regra`, `ia`, `ia_sombra`, `humano`) |
| `category`, `secondary_categories`, `intent`, `confidence`, `justification` | como em 2.3 | |
| `model` | text | modelo da IA (nulo fora de `ia`/`ia_sombra`) |
| `prompt_version` | text | versão do prompt (constante no código) |
| `run_id` | uuid → `prospect_classifier_runs` | a chamada paga, quando houve |
| `verdict` | text | CHECK em (`certo`, `errado`): o revisor do piloto marca a classificação anterior |
| `verdict_fields` | text[] | o que estava errado: `categoria`, `intencao` |
| `actor_employee_id` | uuid → employees | quem corrigiu ou deu o veredito |
| `created_at` | timestamptz not null default now() | |

Índices: `(opportunity_id, created_at)`, `(tenant_id, method, created_at)`.

## 2.5 `prospect_source_health` — estado de cada fonte (C1)

Base da Central de fontes, do alerta "fonte sem evento" e do backoff da Graph entre processos.

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id` | uuid | PK com `source` |
| `source` | text | CHECK em (`instagram`, `instagram_radar`, `google_places`, `meta_lead_ads`, `site_form`, `rd_station`, `google_ads`) |
| `last_event_at` | timestamptz | último evento recebido |
| `last_ok_at` | timestamptz | última chamada bem-sucedida à plataforma |
| `last_error_code` | text | código curto (`rate_limited`, `permission_denied`, `token_invalid`, `unavailable`...) |
| `last_error_at` | timestamptz | |
| `paused_until` | timestamptz | backoff ativo depois de limite da Graph (5.6) |
| `backoff_step` | smallint not null default 0 | índice na lista de espera |
| `updated_at` | timestamptz not null default now() | |

As fontes que já existem (Google, formulário da Meta, site, RD) **não gravam aqui no MVP**: a Central lê o estado delas das tabelas que já existem (ver anexo 4). A tabela aceita esses códigos para quando elas passarem a gravar.

## 2.6 `prospect_ai_settings` — configuração (C1)

Mesmo molde de `prospecting_settings` (`api/db/schema/prospecting.ts:90-97`): `tenant_id` PK, `settings jsonb not null`, `updated_by → employees`, `updated_at`. Leitura e gravação por parte, no molde de `loadProspectingSettings` e `saveProspectingPart` (`api/modules/prospecting/settings.ts:21-55`): cada parte passa pelo seu `safeParse`; parte inválida cai no padrão; gravar uma parte faz `settings || part::jsonb`.

Os esquemas Zod ficam em `shared/prospect-ai.ts`. Padrões (todos editáveis em Ajustes, só com `prospect_ai.configure` escopo `all`, com `audit_log`):

| Parte | Conteúdo | Padrão e limites |
|---|---|---|
| `services` | lista de `{ slug, nome, funil: 'expansao' \| 'formatacao' \| 'consultoria' \| null, vendido: boolean, revisaoObrigatoria: boolean, sinais: string[] }` | as 11 linhas do plano (tabela abaixo); até 30 serviços; slug `^[a-z0-9_]{3,40}$`, único; `sinais` até 5 frases de até 120 caracteres; `nao_identificada` é fixo e não pode ser removido |
| `keywords` | lista de `{ palavra, servico, mensagem, ativa }` | `FRANQUIA` → `formatacao_franquias`, mensagem `padrao`. Até 20. `palavra` é uma palavra só (`^[A-Za-zÀ-ú0-9]{2,30}$`), única sem acento e sem caixa |
| `messages` | `{ textos: Record<id, string>, linkDiagnostico: url, linkPolitica: url }` | `textos.padrao` = rascunho do [anexo jurídico §3.1](juridico.md#3-avisos-de-privacidade-textos-propostos--a-validar). Cada texto: 20 a 1.000 caracteres e **tem de conter `{link_politica}`** (refine do Zod). Placeholders aceitos: `{link_diagnostico}`, `{link_politica}`. Nada mais é interpolado |
| `weights` | `{ clareza, intencao, encaixe, perfil, atualidade, fonte }` | 25, 20, 20, 20, 10, 5. Inteiros 0–100 cuja **soma é 100** (refine) |
| `thresholds` | `{ confiancaMinima, confiancaPalavraChave }` | 70 e 60 (0–100). Abaixo de `confiancaMinima`, revisão humana obrigatória |
| `limits` | `{ respostasPrivadasPorHora, diasEntreRespostasMesmaPessoa, radarChamadasPorHora, radarRegistrosPorVendedorDia, radarJanelaDias, radarAtualizarHoras, alertaSemEventoHoras }` | 600 (1–750), 7 (0–30), 20 (1–200), 20 (1–100), 14 (1–60), 24 (6–168), 48 (6–168) |
| `deadlines` | `{ respostaPrivadaDias, janelaDirectHoras, primeiraRespostaHorasUteis }` | 7 (1–7), 24 (1–24), 1 (1–24). Os dois primeiros não passam do limite da Meta |
| `retention` | `{ webhookDias, webhookFalhaDias, oportunidadeSemLeadDias, respostasPrivadasDias, radarPostsDias, cacheDias, ligacoesMeses }` | 30 (7–90), 90 (30–180), 90 (30–365), 180 (30–365), 30 (7–90), 30 (7–90), 24 (6–60). Todos "a validar com o advogado" na tela |
| `routing` | `{ instagramDonoPadrao: uuid \| null }` | nulo = rodízio do funil (`nextInRotation`, `api/modules/leads/crm.ts:827`). **Decisão do Eric** (pessoa fixa no piloto) |
| `sources` | `{ instagram: { pausada }, instagram_radar: { pausada } }` | `false`. Pausar na tela não substitui a chave de ambiente (5.3): as duas precisam permitir |

**Lista de serviços padrão** (do plano; **decisão do Eric**: confirmar quais a Wings vende hoje, `vendido`):

| slug | nome | funil | revisão obrigatória |
|---|---|---|---|
| `formatacao_franquias` | Formatação de franquias | formatacao | não |
| `expansao_rede` | Expansão da própria rede | formatacao | não |
| `estruturacao_gestao` | Estruturação e profissionalização da gestão | consultoria | não |
| `organizacao_operacional` | Organização administrativa e operacional | consultoria | não |
| `sucessao_gestao` | Sucessão e transição de gestão | consultoria | **sim** |
| `reestruturacao` | Reestruturação organizacional | consultoria | **sim** |
| `planejamento_estrategico` | Planejamento estratégico | consultoria | não |
| `consultoria_mentoria_coaching` | Consultoria, mentoria e coaching | consultoria | não |
| `desenvolvimento_liderancas` | Desenvolvimento de lideranças | consultoria | não |
| `investidor_franquia` | Investidor que quer comprar uma franquia | expansao | não |
| `nao_identificada` | Necessidade não identificada | null (fila de revisão) | **sim** |

Divergência registrada: no plano, "Expansão da própria rede" vai para o funil Formatação, e é isso que o padrão faz. O funil `expansao` do código (`shared/leads.ts:56`) é o de quem quer **abrir** uma unidade, por isso recebe o investidor.

## 2.7 Classificador: `prospect_classifier_cache` e `prospect_classifier_runs` (C3)

**`prospect_classifier_cache`** — o mesmo texto nunca é classificado duas vezes. **O texto de entrada não é guardado**; o resultado guarda só a `frase` justificativa (até 200 caracteres, trecho do próprio texto), por isso a retenção é curta (anexo 2, §4.7).

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id` | uuid | PK com `key_hash` |
| `key_hash` | text | `sha256(textoNormalizado + '\n' + model + '\n' + promptVersion + '\n' + servicesVersion)`, em hex. `servicesVersion` = sha256 da lista de serviços vigente, para o cache cair quando a lista muda |
| `result` | jsonb not null | a saída já validada pelo Zod (anexo 2) |
| `created_at` | timestamptz not null default now() | limpeza por `retention.cacheDias` |

**`prospect_classifier_runs`** — registro de custo, com reserva antes da chamada no molde de `sofia_ai_runs` (`api/db/schema/sofia.ts:34-51`; reserva em `api/modules/sofia/engine.ts:906-935`).

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id`, `id` | uuid | |
| `at` | timestamptz not null default now() | |
| `model`, `prompt_version` | text not null | |
| `key_hash` | text not null | liga ao cache, sem o texto |
| `shadow` | boolean not null default false | chamada do modelo de comparação (anexo 2, §4.6) |
| `reserved_micro_usd` | integer not null | reserva feita antes da chamada |
| `cost_micro_usd` | integer | custo real (do provedor ou estimado); nulo se a chamada caiu |
| `cost_source` | text | CHECK em (`provider`, `estimate`) |
| `input_tokens`, `output_tokens` | integer | |
| `outcome` | text not null default `'pending'` | CHECK em (`pending`, `ok`, `invalid`, `failed`, `timeout`) |

Índice `(tenant_id, at)` para a soma do dia. Retenção: 24 meses (é registro financeiro, sem dado pessoal).

## 2.8 `prospect_call_logs` — registro de ligação (C5)

Hoje não existe: `prospect_calls` é o livro da cota do Google (`api/modules/prospecting/quota.ts:240-267`), e o vendedor só muda o status do prospect (`docs/crm/prospeccao.md:72`). Esta tabela é nova e **não** mexe em `prospect_calls`.

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id`, `id` | uuid | |
| `prospect_id` | uuid → prospects (on delete set null) | |
| `lead_id` | uuid → leads (on delete set null) | CHECK: `prospect_id` ou `lead_id` não nulo na inserção |
| `employee_id` | uuid not null → employees | quem ligou (sempre o ator; não se registra ligação em nome de outro) |
| `called_at` | timestamptz not null | padrão: agora; pode ser até 7 dias no passado (Zod) |
| `outcome` | text not null | CHECK em (`interessado`, `retornar`, `sem_interesse`, `nao_atendeu`, `caixa_postal`, `numero_errado`, `pediu_nao_contatar`) |
| `duration_sec` | integer | CHECK 0–14.400 |
| `notes` | text | no máximo 1.000 caracteres |
| `next_step_at` | timestamptz | retorno combinado |
| `created_at` | timestamptz not null default now() | |

Índices: `(tenant_id, employee_id, called_at)`, `(prospect_id, called_at)`, `(lead_id, called_at)`. Retenção: `retention.ligacoesMeses`; depois do prazo, `notes` vira nulo e o resto fica para o painel.

## 2.9 Instagram (D1)

### `ig_webhook_events` — eventos recebidos, no molde de `meta_leadgen_events`

Molde: `api/db/schema/meta-leads.ts:33-66` e `api/modules/leads/meta-intake.ts` (8 tentativas, espera `[1, 5, 15, 60, 180, 360, 720, 1440]` minutos, :56-58).

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id`, `id` | uuid | |
| `event_key` | text not null | **id único por evento**: `comment:<id do comentário>`, `mention:<id do comentário ou da mídia>`, `message:<mid>`, `echo:<mid>`, `referral:<igsid>:<timestamp>`. Um POST da Meta com várias entradas vira várias linhas |
| `kind` | text not null | CHECK em (`comment`, `mention`, `message`, `echo`, `referral`, `other`) |
| `ig_account_id` | text not null | `entry[].id` (a conta da Wings) |
| `occurred_at` | timestamptz | horário do evento na Meta (`entry[].time` ou `timestamp` da mensagem) |
| `payload` | jsonb | só o pedaço do evento (a `change` ou o item de `messaging`), nunca o POST inteiro; zerado no prazo de retenção |
| `received_at` | timestamptz not null default now() | |
| `status` | text not null default `'pending'` | CHECK em (`pending`, `done`, `ignored`, `failed`) |
| `attempts` | integer not null default 0 | |
| `next_attempt_at` | timestamptz not null default now() | |
| `last_error` | text | só o código |
| `processed_at` | timestamptz | |
| `opportunity_id` | uuid → `prospect_opportunities` (on delete set null) | |

Índices: **unique** `(tenant_id, event_key)` (entrega repetida da Meta é ignorada com `on conflict do nothing`); `(status, next_attempt_at)`; `(received_at)`.

### `ig_people` — a pessoa do Instagram, mínima (2.10)

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id`, `id` | uuid | |
| `igsid` | text not null | id da pessoa **com escopo do app** (Instagram-scoped ID) que a Meta manda em `from.id` (comentário) e `sender.id` (Direct). **Unique** `(tenant_id, igsid)` |
| `username` | text | @ mais recente visto num evento, minúsculo e sem arroba. Atualizado, nunca acumulado |
| `first_seen_at`, `last_seen_at` | timestamptz not null | |
| `last_inbound_at` | timestamptz | última mensagem **dela** no Direct; abre a janela de 24 h |
| `last_auto_reply_at` | timestamptz | última resposta privada automática para ela (limite por pessoa, 3.1) |
| `lead_id` | uuid → leads (on delete set null) | lead ligado; é a chave da junção entre comentário, Direct e lead |
| `created_at`, `updated_at` | timestamptz | |

Índices: `(tenant_id, username)`, `(lead_id)`, `(last_seen_at)` para a limpeza.

### `ig_private_replies` — uma resposta privada por comentário, idempotente

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id`, `id` | uuid | |
| `comment_id` | text not null | **unique** `(tenant_id, comment_id)`: a segunda tentativa de enviar para o mesmo comentário falha no banco |
| `opportunity_id` | uuid → `prospect_opportunities` | |
| `ig_person_id` | uuid → `ig_people` (on delete set null) | |
| `keyword` | text not null | palavra que disparou |
| `message_key` | text not null | id do texto em `settings.messages.textos` |
| `message_sha256` | text not null | hash do texto final enviado (prova de que era o texto aprovado, sem guardar o texto de novo) |
| `status` | text not null | CHECK em (`sending`, `sent`, `failed`, `rate_limited`, `unknown`, `blocked`). `blocked` = trava de contato, prazo de 7 dias ou limite por pessoa |
| `block_reason` | text | `nao_contatar`, `prazo_meta`, `limite_pessoa`, `limite_hora`, `fonte_pausada`, `desligado` |
| `attempts` | smallint not null default 0 | só sobe em `rate_limited` (erro certo de limite, mensagem não entregue) |
| `next_attempt_at` | timestamptz | |
| `graph_message_id` | text | `message_id` devolvido pela Meta |
| `last_error` | text | código |
| `comment_created_at` | timestamptz not null | base dos 7 dias |
| `sent_at`, `created_at` | timestamptz | |

Índices: `(tenant_id, sent_at)` (conta as da última hora), `(status, next_attempt_at)`.

## 2.10 Como guardar a pessoa do Instagram (IGSID e @) sem montar perfil

- **Chave da pessoa: o IGSID** (`ig_people.igsid`). É o id que a Meta dá à pessoa **dentro do app da Wings**: não serve fora dele e é estável entre comentário, resposta privada e Direct (o `recipient_id` da resposta privada é esse id). O @ muda; o IGSID não.
- **O @ é só rótulo** (`ig_people.username`, `prospect_evidence.author_username`) e chave de busca secundária. Ao virar lead, o @ vai para `leads.instagram` (`api/db/schema/leads.ts:78`) pelo `fillGaps` (`api/modules/leads/service.ts:441`), sem sobrescrever o que já houver.
- **Deduplicação, em ordem:** (1) `ig_people.lead_id` do IGSID; (2) `upsertLead` com `externalId` do comentário ou da mensagem (unique `(source, external_id)`, `api/db/schema/leads.ts:219`); (3) telefone ou e-mail **que a própria pessoa escreveu** na conversa, normalizados (`normalizeBrazilianPhone`, e-mail minúsculo), pela busca do `upsertLeadTx` (`service.ts:603-604`); (4) o @ contra `leads.instagram` gera só a **sugestão** "possível duplicada" na fila (o @ pode ter mudado de dono), nunca junta sozinho.
- **O que não se faz:** buscar o perfil da pessoa na Graph (foto, bio, seguidores), cruzar o @ com outras fontes, chamar o `check_instagram` (`apps/worker/src/jobs/check-instagram.ts`) para pessoa física, ou guardar o histórico do Direct além do trecho da evidência. O `check_instagram` continua valendo só para o @ que o lead digitou num formulário (uso atual).
- **Apagar a pedido:** apagar a pessoa = apagar `ig_people`, zerar `author_igsid`, `author_username` e `excerpt` das evidências dela sem lead, e marcar as oportunidades dela como `rejeitada` com motivo `exclusao_titular`. O "não me contate" fica em `contact_opt_outs` (é o que impede contato futuro). A trava guarda a pessoa do Instagram pelo **@** (chave `instagram_user`); o PR D5 acrescenta a chave `instagram_igsid` (ver especificação, §3.8). Rota e tela no PR D5.

## 2.11 Radar de concorrentes (E1)

### `competitor_accounts`

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id`, `id` | uuid | |
| `username` | text not null | @ da conta comercial do concorrente, minúsculo, sem arroba (`^[a-z0-9._]{1,30}$`). **Unique** `(tenant_id, username)` |
| `branch` | text not null | ramo. CHECK em (`consultoria_franquias`, `consultoria_empresarial`, `mentoria`, `coaching_empresarial`) |
| `active` | boolean not null default true | |
| `last_fetched_at` | timestamptz | |
| `last_error_code` | text | `nao_encontrada`, `nao_profissional`, `sem_permissao`, `limite` |
| `created_by` | uuid → employees | |
| `created_at`, `updated_at` | timestamptz | |

### `competitor_posts` — só metadados públicos, retenção curta

| Coluna | Tipo | Regra |
|---|---|---|
| `tenant_id`, `id` | uuid | |
| `account_id` | uuid not null → `competitor_accounts` (on delete cascade) | |
| `media_id` | text not null | **unique** `(tenant_id, media_id)` |
| `permalink` | text not null | CHECK começa com `https://www.instagram.com/` |
| `posted_at` | timestamptz not null | `timestamp` da Graph |
| `caption_excerpt` | text | legenda cortada em 150 caracteres (CHECK) |
| `comments_count` | integer | o número que a Graph devolver; nulo se não vier |
| `fetched_at` | timestamptz not null | atualizado a cada leitura (o número de comentários muda) |

Índices: `(tenant_id, posted_at)`, `(account_id, comments_count desc)`, `(fetched_at)` para a limpeza (`retention.radarPostsDias`, contado de `posted_at`). **Nenhum comentário, autor, curtida por pessoa ou seguidor é guardado.**

## 2.12 Origens novas do lead (C1, só Zod)

`leads.source` é `text` sem CHECK (`api/db/schema/leads.ts:51`); os valores vivem em `LEAD_SOURCES` (`shared/leads.ts:23-35`). Entram:

| Origem | Rótulo | Quando |
|---|---|---|
| `instagram_comment` | Instagram (comentário) | lead vindo do "comenta e recebe" ou de comentário orgânico |
| `instagram_dm` | Instagram (Direct) | a pessoa escreveu primeiro no Direct |
| `instagram_ad` | Instagram (anúncio) | comentário em anúncio (`ad_id`) ou Direct aberto por anúncio (referral com `ad_id`) |
| `competitor_radar` | Radar de concorrentes | empresa registrada pelo vendedor no radar |

Lugares que precisam mudar juntos (o `Record<LeadSource, …>` quebra o typecheck se faltar um): `LEAD_SOURCE_LABELS` (`shared/leads.ts:38-50`), `LEAD_SOURCE_BADGES` (`shared/crm.ts:902`, mais o tom no CSS do web), `ARRIVAL_SOURCES` (`api/modules/leads/crm-alerts.ts:534-540`, as três do Instagram entram para avisar o dono; o radar não, porque o dono é quem registrou), e o comentário desatualizado de `api/db/schema/leads.ts:50`. `TRIAGE_SOURCES` (`triage-schedule.ts:15`) **não** muda: o funil já vem da categoria. O canal `instagram` já existe (`shared/leads.ts:91-101`).
