# Anexo 3 — API e configuração

Parte da [especificação do Wings Prospect AI](../ESPECIFICACAO.md), seção 5. Referências do commit `c4168cb`. Abreviações: `api` = `apps/api/src`, `shared` = `packages/shared/src`.

## 5.1 Permissões novas

Declaradas em `PERMISSIONS` (`shared/rbac/permissions.ts:11-77`), no formato `recurso.ação` com descrição em português, e concedidas na matriz `ROLE_PERMISSIONS` (:170-345), que nega tudo o que não estiver listado (:160). O seed grava as duas no banco (`api/db/seed.ts:298,307`).

| Permissão | Descrição na tela | Escopo |
|---|---|---|
| `prospect_ai.review` | Ver e revisar a fila de oportunidades, a Central de fontes e o radar | own / sector / all |
| `prospect_ai.configure` | Configurar o Prospect AI (serviços, palavras-chave, textos, pesos, limites, prazos, contas do radar, pausar fontes) | all |
| `prospect_ai.dashboard` | Ver o painel de prospecção por fonte | own / all |

**Escopo** (mesma semântica dos leads, `api/modules/leads/access.ts:32-60`):
- `own`: só oportunidades e registros em que a pessoa é dona. Oportunidade sem dono é invisível (como o lead sem dono); fora do alcance a resposta é **404**, não 403 (`access.ts:22-23`).
- `sector`: o que `leadOwnerFilter` já faz para o setor.
- `all`: tudo, inclusive sem dono. Só `all` atribui, reabre e vê o custo no painel.

**Matriz proposta** (a da prospecção como molde: `permissions.ts:130,171-176,230,278-280,343`):

| Papel | review | configure | dashboard |
|---|---|---|---|
| `admin_master` | all | all | all |
| `diretoria` | all | — | all |
| `gerente_comercial` | all | all | all |
| `marketing` | — | — | all (**decisão do Eric**, E8) |
| `vendedor_formatacao` | own | — | own |
| `vendedor_expansao` | own (recebe investidores) | — | own |
| demais | — | — | — |

Também mudam no mesmo PR (C1): `docs/niveis-de-acesso.md` (tabela :40 e parágrafo :61-67), `route-access.test.ts` (sonda nova em `PROBES` :133, por exemplo `'prospect-ai': '/prospect-ai/settings'`, e a lista `LEVELS` :155), e o item de navegação de cada tela em `shared/navigation.ts` com a permissão (molde :151-158).

## 5.2 Rotas

Padrão de cada rota (`AGENTS.md`, "Where logic lives"): o handler faz `safeParse` com o esquema de `shared/prospect-ai.ts`, declara o acesso no `preHandler` (`app.requirePermission(...)`, `api/plugins/auth.ts:80-83,143-159`), chama uma função de serviço, grava `audit_log` quando a ação muda algo (`api/lib/audit.ts:22`, sem dado pessoal) e responde. Erros no formato `{ error, message }` com código em snake_case, como `api/modules/prospecting/routes.ts:93-118`. Módulo novo `api/modules/prospect-ai/` registrado em `api/app.ts` ao lado da prospecção (:44, :354).

### Configuração (C2)

| Método e rota | Permissão | Corpo | Resposta | Erros |
|---|---|---|---|---|
| `GET /prospect-ai/settings` | `prospect_ai.review` | — | `{ settings, updatedAt, updatedBy }` (`updatedBy` = nome, como `GET /sofia/settings`, `api/modules/sofia/routes.ts:291`) | — |
| `PUT /prospect-ai/settings/:part` | `prospect_ai.configure` (all) | a parte (`services`, `keywords`, `messages`, `weights`, `thresholds`, `limits`, `deadlines`, `retention`, `routing`, `sources`) | as configurações recarregadas | 400 `invalid` com `path`; 400 `unknown_part`. Audit `prospect_ai.settings_changed`, metadados `{ part, changedKeys }` (sem textos) |

Regras extras do `PUT`: `keywords[].servico` tem de existir em `services`; remover um serviço com oportunidade aberta responde 409 `service_in_use`; `routing.instagramDonoPadrao` precisa ser funcionário ativo com `prospect_ai.review`.

### Fila (C2)

| Método e rota | Permissão | Corpo / query | Resposta | Erros |
|---|---|---|---|---|
| `GET /prospect-ai/opportunities` | `prospect_ai.review` | `state`, `source`, `category`, `ownerId` (só all), `cursor`, `limit` ≤ 100 | `{ items: OpportunityCard[], nextCursor, counts: Record<state, number> }`. Ordem: `respond_by` mais próximo, depois `priority` | 400 `invalid` |
| `GET /prospect-ai/opportunities/:id` | `prospect_ai.review` | — | cartão + evidência + histórico da classificação + resposta privada (status) + selo de "não me contate" (`contactBlock`) | 404 `not_found` (também fora do escopo) |
| `POST /prospect-ai/opportunities/:id/decision` | `prospect_ai.review` (+ `leads.write` para `approve`) | `{ action: 'review' \| 'approve' \| 'reject' \| 'duplicate' \| 'reopen', reason?, pipeline?, duplicateOfLeadId?, duplicateOfOpportunityId? }` | o cartão atualizado; em `approve`, `{ leadId, created }` | 409 `invalid_transition`; 400 `reason_required`; 400 `pipeline_required` (categoria sem funil); 409 `foreign_lead` com o dono (de `ForeignLeadError`); 409 `number_in_attendance`; `reopen` só escopo all (403) |
| `POST /prospect-ai/opportunities/:id/classification` | `prospect_ai.review` | `{ category, secondaryCategories, intent, verdict?: 'certo' \| 'errado', verdictFields? }` | cartão com a nova classificação (`method = 'humano'`) | 400 `invalid` (categoria fora da lista) |
| `POST /prospect-ai/opportunities/:id/assign` | `prospect_ai.review` escopo all | `{ employeeId }` | cartão | 400 `invalid_assignee` (inativo ou sem permissão) |
| `POST /prospect-ai/opportunities/:id/responded` | `prospect_ai.review` | — | cartão com `respondedAt` | 409 se já marcado |
| `POST /prospect-ai/opportunities/:id/opt-out` | `prospect_ai.review` | `{ channels: ('instagram' \| 'all')[], reason }` | `{ blocked: true }` | grava pela função do PR da trava; 409 se já existe |
| `GET /prospect-ai/leads/:leadId/evidence` | `leads.read` (escopo do lead, `leadInScope`, `access.ts:51-60`) | — | `{ evidences, opportunities, classifications }` do lead | 404 |
| `DELETE /prospect-ai/people/:igPersonId` | `prospect_ai.configure` | `{ reason }` | `{ erased: true }` | exclusão a pedido (anexo 1, §2.10). PR D5 |

### Fontes (C2 lê; D3 completa)

| Método e rota | Permissão | Resposta |
|---|---|---|
| `GET /prospect-ai/sources` | `prospect_ai.review` | lista `{ source, status: 'conectada' \| 'com_erro' \| 'pausada' \| 'desligada' \| 'aguardando_meta', lastEventAt, lastErrorCode, lastErrorAt, pausedUntil, detail }`. "Conectada" só depois de um evento recebido |
| `POST /prospect-ai/sources/:source/pause` e `/resume` | `prospect_ai.configure` | grava `settings.sources.<fonte>.pausada`; audit `prospect_ai.source_paused` / `_resumed`. Só `instagram` e `instagram_radar` (as outras fontes continuam como hoje) |

### Radar (E1, E3)

| Método e rota | Permissão | Corpo / resposta | Erros |
|---|---|---|---|
| `GET /prospect-ai/radar/accounts` | `prospect_ai.review` | contas com `lastFetchedAt` e `lastErrorCode` | — |
| `POST /prospect-ai/radar/accounts` | `prospect_ai.configure` | `{ username, branch }` | 409 `radar_account_exists` |
| `PATCH /prospect-ai/radar/accounts/:id` | `prospect_ai.configure` | `{ active?, branch? }` | 404 |
| `GET /prospect-ai/radar/posts` | `prospect_ai.review` | query `branch`, `days` ≤ `limits.radarJanelaDias`; ordem `comments_count` desc | — |
| `POST /prospect-ai/radar/registrations` | `prospect_ai.review` | `{ tipo: 'empresa', companyName, companyUsername?, commentUrl, excerpt?, commentedAt?, officialChannel: { site?, phone?, whatsapp?, email? } }` (pelo menos um canal) → oportunidade | 400 `radar_somente_empresa`; 400 `canal_oficial_obrigatorio`; 409 `radar_ja_registrado`; 429 `radar_limite_dia` |

### Painel (F2, F3)

| Método e rota | Permissão | Corpo / resposta |
|---|---|---|
| `GET /prospect-ai/dashboard` | `prospect_ai.dashboard` | query `from`, `to`, `source`, `pipeline`, `sellerId` (own: forçado ao próprio). Formato no anexo 5 |
| `POST /prospect-ai/dashboard/refresh` | `prospect_ai.configure` | `{ from, to }` (até 90 dias) → `{ ran: boolean, rows }`. 409 `refresh_running` quando a trava está com outro |

### Registro de ligação (C5)

| Método e rota | Permissão | Corpo / resposta | Erros |
|---|---|---|---|
| `POST /prospecting/calls` | `prospecting.use` (own: só prospect ou lead do próprio vendedor) | `{ prospectId?, leadId?, calledAt?, outcome, durationSec?, notes?, nextStepAt? }` → registro criado. `pediu_nao_contatar` grava "não me contate" (todos os canais) pela trava e muda o prospect para `nao_contatar`. `nextStepAt` cria tarefa `follow_up` (`LEAD_TASK_KINDS`, `shared/crm.ts:140`) quando há lead | 400 `target_required`; 404 fora do escopo |
| `GET /prospecting/calls` | `prospecting.use` | query `prospectId` ou `leadId` → lista | 404 |

Arquivo novo `api/modules/prospecting/call-routes.ts`: `routes.ts` da prospecção já é grande, e o registro de ligação não muda a busca.

### Webhook do Instagram (D1)

| Método e rota | Acesso | Comportamento |
|---|---|---|
| `GET /integrations/instagram/webhook` | `app.publicRoute('platform webhook with its own secret')` (`api/plugins/auth.ts:77,131`), na lista `PUBLIC_ROUTES` do `route-access.test.ts` (:22) | handshake (5.5) |
| `POST /integrations/instagram/webhook` | idem | assinatura, enfileirar, responder (5.5) |

## 5.3 Variáveis de ambiente novas (só nomes)

Declaradas em `api/env.ts` com o padrão existente: chave liga/desliga no modelo `optionalString.refine(...)` (`api/env.ts:492-495`), ligada **só** quando o valor é `"true"`; números com `.positive().max(...)` como os `*_DAILY_USD` (:411-435). Os nomes entram em `.env.example` sem valor.

| Variável | Para quê | Padrão |
|---|---|---|
| `INSTAGRAM_WEBHOOK_ENABLED` | aceitar e gravar eventos do webhook | desligada |
| `INSTAGRAM_AUTO_REPLY_ENABLED` | enviar a resposta privada | desligada |
| `INSTAGRAM_APP_SECRET` | conferir a assinatura do webhook (segredo do app escolhido na Fase 2; se for o "Wings CRM Vendas", tem o mesmo valor de `WHATSAPP_APP_SECRET`, mas a variável é separada para o Instagram poder trocar de app sozinho) | — |
| `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | handshake; mínimo 16 caracteres, como `META_LEADGEN_VERIFY_TOKEN` (:520-523) | — |
| `INSTAGRAM_MESSAGING_TOKEN` | token do usuário do sistema com `instagram_manage_comments` e `instagram_manage_messages`, só para o Instagram (menor privilégio: não cai para nenhum outro token, ao contrário do que acontece em `api/server.ts:105`) | — |
| `INSTAGRAM_ACCOUNT_ID` | id da conta @wings.companybr na Graph (só dígitos, como `INSTAGRAM_DISCOVERY_ACCOUNT_ID`, :602-605) | — |
| `COMPETITOR_RADAR_ENABLED` | ligar o agendador do radar | desligada |
| `PROSPECT_AI_CLASSIFIER_ENABLED` | chamar a IA no texto livre | desligada |
| `PROSPECT_AI_CLASSIFIER_MODEL` | modelo (lista permitida no anexo 2) | `anthropic/claude-haiku-4.5` |
| `PROSPECT_AI_SHADOW_MODEL` | modelo de comparação (anexo 2, §4.6); vazio = sem sombra | vazio |
| `PROSPECT_AI_DAILY_USD` | teto diário da IA do módulo | 1 |
| `PROSPECT_DW_LOAD_ENABLED` | ligar a carga diária do painel | desligada |

O radar reaproveita `INSTAGRAM_DISCOVERY_ACCOUNT_ID` e `INSTAGRAM_DISCOVERY_TOKEN` (`api/env.ts:602-607`), que já servem à Business Discovery. Se a Fase 2 mostrar que o token novo também cobre a Business Discovery, o Eric pode pôr o mesmo valor nas duas; o código não junta as variáveis. `OPENROUTER_API_KEY` (:406) já existe.

**Sem segredo na URL:** nenhuma rota nova aceita segredo em query string (a auditoria achou três que aceitam, item J4; não é escopo daqui).

## 5.4 Chaves de liga e desliga

| Camada | O que desliga | Quem muda |
|---|---|---|
| Variável de ambiente (5.3) | o código inteiro daquela parte; padrão desligado | o Eric no Coolify |
| `settings.sources.<fonte>.pausada` | pausa operacional pela Central de fontes | `prospect_ai.configure`, com auditoria |
| Permissão | quem vê cada tela | matriz por papel |

As duas primeiras precisam permitir. Com `INSTAGRAM_WEBHOOK_ENABLED` desligada, o webhook responde 503 `instagram_disabled` e não grava nada (a Meta tenta de novo e mostra o erro no painel dela, o que é melhor que perder em silêncio). Com o webhook ligado e a resposta automática desligada, os eventos viram oportunidades e as respostas ficam `blocked` com motivo `desligado` (modo de observação, útil no começo do piloto).

## 5.5 Webhook do Instagram

Molde: o webhook do formulário da Meta (`api/modules/leads/webhooks.ts:349-364,547-597`; `api/modules/leads/meta-leads.ts:17-26`). Arquivo novo `api/modules/instagram/webhook-routes.ts`, num plugin próprio.

1. **Corpo bruto:** o plugin registra os parsers que devolvem `Buffer` (`parseAs: 'buffer'`, limite de 1 MiB), como `webhooks.ts:355-364`. O parser vale só dentro do plugin.
2. **Limite de entrada:** `config: { rateLimit: { max: 1200, timeWindow: '1 minute' } }` (o do WhatsApp).
3. **Handshake (GET):** `hub.mode === 'subscribe'` e `tokensMatch(hub.verify_token, INSTAGRAM_WEBHOOK_VERIFY_TOKEN)` (`api/lib/tokens.ts:17`) → responde `hub.challenge` em `text/plain`; senão 403 `bad_verify_token`. Sem a variável → 503.
4. **POST, nesta ordem:**
   1. chave desligada ou `INSTAGRAM_APP_SECRET` ausente → 503;
   2. `metaSignatureValid(INSTAGRAM_APP_SECRET, corpoBruto, header 'x-hub-signature-256')` (a função já é genérica, `meta-leads.ts:17-26`: HMAC-SHA256 do corpo bruto com o segredo do app, comparação `timingSafeEqual`, prefixo `sha256=`) → senão 401 `bad_signature`;
   3. `JSON.parse` → senão 400 `invalid_json`;
   4. `object !== 'instagram'` → 200 `{ received: 0 }` e nada gravado;
   5. separa cada `entry[].changes[]` (campos `comments`, `mentions`) e cada `entry[].messaging[]` (mensagens, ecos, referrals) num evento com `event_key` (anexo 1, §2.9);
   6. `insert ... on conflict (tenant_id, event_key) do nothing` em `ig_webhook_events`;
   7. chama o "chute" do laço (molde `app.wings.metaLeadKick`, `api/app.ts:95`; `webhooks.ts:593`) e responde **200** `{ received, queued }` na hora. Nenhuma chamada à Graph nem à IA acontece dentro da requisição.
5. **Log:** só o formato (`kind`, contagem, `event_key` sem o texto), nunca texto, @ ou IGSID; o logger do Fastify já não registra o corpo (`api/app.ts:172-185`).
6. **Processamento** (D2): laço de 60 s + chute, um passe por vez por processo, como `startMetaLeadgenIntake` (`meta-intake.ts:1070-1135`). Seleção de até 50 eventos `pending` com `next_attempt_at <= now()`; posse por compare-and-set em `attempts` (`meta-intake.ts:155-159`); erro → `next_attempt_at = now() + espera(attempts)` com a lista `[1, 5, 15, 60, 180, 360, 720, 1440]` minutos e `MAX_ATTEMPTS = 8` (`meta-intake.ts:56-58,430-431`; exportar e reaproveitar, não copiar); erro permanente (payload inválido, 4xx da Graph que não é limite) → `failed` sem nova tentativa. Limpeza diária do `payload` no prazo de retenção, como `purgeMetaLeadgenPayloads` (`meta-intake.ts:1051-1063`).

## 5.6 Limites da Graph e espera crescente

Cliente novo `api/modules/instagram/graph.ts`, no molde de `api/modules/whatsapp/graph.ts:31-85`: nunca lança; devolve `{ ok: true, data, usage } | { ok: false, status, code, subcode, unknown, usage }`; token no cabeçalho `Authorization: Bearer` (nunca na URL); tempo limite de 15 s; `unknown = true` quando um POST pode ter sido entregue (erro de transporte ou 5xx). `usage` = os cabeçalhos `X-App-Usage` e `X-Business-Use-Case-Usage` já lidos como JSON.

| Situação | Como reconhecer | O que fazer |
|---|---|---|
| Limite | HTTP 429, ou `error.code` em 4 (app), 17 (usuário), 32 (página), 613 (personalizado), 80002 (Instagram, uso de negócio), 80006 (mensagens); também `isRateLimit` de `meta-client.ts:70-72` | `prospect_source_health.paused_until = now() + espera`, com `backoff_step` subindo na mesma lista de 1 min a 24 h; se a Meta mandar `estimated_time_to_regain_access` (minutos), usa o maior dos dois. Nenhuma chamada da fonte até lá. A resposta privada fica `rate_limited` e volta só se ainda couber nos 7 dias |
| Perto do limite | qualquer porcentagem em `usage` ≥ 80 | o radar encerra a rodada; a resposta privada continua até 90 |
| Sem permissão | `code` 10 ou 200–299 | `failed`, fonte "aguardando a Meta"; sem nova tentativa automática |
| Token inválido | `code` 190 ou 102 | idem, `token_invalid`; aviso aos gerentes (uma vez por dia) |
| Fora do ar | 5xx, tempo esgotado | leitura (GET): nova tentativa pela espera do evento. Envio (POST): `unknown`, nunca reenvia |
| Sucesso | `ok` | `backoff_step = 0`, `last_ok_at = now()` |

Orçamento por hora (em `settings.limits`, nunca acima do teto da Meta): respostas privadas 600 (teto 750 por conta para posts e reels); radar 20 chamadas (teto da plataforma: 200 × usuários do app por hora; a Business Discovery usa esse limite, segundo a documentação de visão geral da Meta). O cálculo usa a tabela do próprio módulo (`ig_private_replies.sent_at`, contagem por hora), não a memória do processo, então vale mesmo com mais de uma instância da API.

**Não verificado ao vivo:** os códigos e os cabeçalhos acima vêm da documentação da Meta (consultada em 29/10/2026) e do código atual, que também diz não ter conferido ao vivo (`worker/lib/instagram-check.ts:26-28`). O PR D3 registra o formato real na primeira execução com a conta de teste, como `docs/integracoes/` faz para outros provedores.
