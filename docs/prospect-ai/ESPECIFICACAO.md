# Wings Prospect AI — especificação técnica da Fase 1

Versão de 29/10/2026. Base: o plano "Wings Prospect AI — plano de construção", aprovado pelo Eric no chat em 29/10/2026 às 10:31 ("Totalmente autorizado. Siga conforme suas sugestões"), e a auditoria do código (somente leitura, commit `c4168cb` da develop). Toda referência `arquivo:linha` é desse commit. Abreviações: `api` = `apps/api/src`, `web` = `apps/web/src`, `shared` = `packages/shared/src`, `worker` = `apps/worker/src`.

**Como ler.** Este arquivo traz as decisões (§1), os fluxos com estados e erros (§3) e a ordem dos PRs (§9). O detalhe de cada parte está num anexo, em `docs/prospect-ai/anexos/`:

| § | Assunto | Onde |
|---|---|---|
| 1 | Decisões, premissas, divergências e o que fica fora | aqui |
| 2 | Contrato de dados (tabelas, índices, migrations 0099–0105, retenção) | [anexo 1](anexos/01-contrato-de-dados.md) |
| 3 | Fluxos e regras | aqui |
| 4 | Classificador e frases de teste | [anexo 2](anexos/02-classificador.md) |
| 5 | API, variáveis, chaves, webhook e limites da Graph | [anexo 3](anexos/03-api-e-configuracao.md) |
| 6 | Telas | [anexo 4](anexos/04-telas.md) |
| 7 | Painel por fonte (modelo dimensional) | [anexo 5](anexos/05-painel-por-fonte.md) |
| 8 | Testes por PR | [anexo 6](anexos/06-testes.md) |
| 9 | Sequência de PRs | aqui |
| 10 | Checklist da Fase 2 na Meta | [anexo 7](anexos/07-fase2-meta.md) |
| 11 | Rascunho para o advogado (legítimo interesse, avisos, prazos) | [anexo jurídico](anexos/juridico.md) |

Marcas usadas: **decisão do Eric** = falta uma escolha dele, e o texto traz a recomendação; **a validar** = depende do advogado; **divergência** = o plano e o código dizem coisas diferentes, e vale o código.

---

## 1. Decisões e premissas

### 1.1 Decidido em 29/10/2026 (afeta o código)

| # | Decisão | Efeito no código |
|---|---|---|
| D1 | Exceção ao congelamento "nenhum módulo novo até 14/11" (`docs/decisoes.md:10`) | O PR C1 acrescenta a linha de 29/10 em `docs/decisoes.md`. Este PR de documentação já a acrescenta |
| D2 | MVP = "comenta e recebe" no Instagram da Wings + fila de oportunidades + painel por fonte | PRs C, D e F (§9) |
| D3 | Concorrentes pela opção A: radar pela Business Discovery, comentários lidos pelo vendedor no próprio Instagram, registro manual **só de empresas**, anúncios da Wings para esse público | PR E. Nada de raspagem, de coleta de telefone de bio nem de envio em massa: não existe código para isso, e os testes provam que a tela recusa pessoa física |
| D4 | Construção em modo de teste (contas da equipe com papel no app) antes da revisão da Meta, que exige vídeo | Tudo atrás de chaves desligadas (anexo 3, §5.3). O roteiro do vídeo está no anexo 7 |
| D5 | Trava de contato e correção da Sofia já | **Fora deste trabalho**: PR `feat/trava-unica-contato` (migration 0098, `contact_opt_outs`, função única `contactBlock`). Esta especificação só chama essa função (§3.8) |
| D6 | Correções da prospecção Google (expiração de reserva, falha parcial, logo, retenção do enriquecimento) | **Fora deste trabalho**: PR `fix/prospeccao-ajustes`, sem migration. O registro de ligação ficou para cá (PR C5) |

### 1.2 Premissas técnicas

1. **Sem serviço novo.** O webhook roda na API atual; trabalhos periódicos seguem o padrão `setInterval` + `pg_try_advisory_xact_lock` iniciado em `api/server.ts` (exemplo: `api/modules/leads/automations-scheduler.ts:22,47-60`). A fila `jobs` do worker não tem backoff (`worker/queue.ts:177-192`), por isso o Instagram usa uma tabela própria de eventos, no molde de `meta_leadgen_events`.
2. **Uma porta de leads.** Todo lead nasce ou é juntado por `upsertLead` (`api/modules/leads/service.ts:534`), com `clientId: WINGS_CLIENT_ID` e `clientMapped: true`, como a prospecção faz (`api/modules/prospecting/service.ts:711-712`; `shared/clients.ts:14`).
3. **Classificação fora do WhatsApp é nova** e não reaproveita a Sofia (o modelo e o prompt dela são de outra tarefa, `shared/sofia.ts:529`). Reaproveita o cliente `createOpenRouterLlm` (`api/modules/agent/llm.ts:137`), a ferramenta forçada com Zod e a reserva de custo da Sofia (`api/modules/sofia/engine.ts:906-950`).
4. **App da Meta.** O código conhece dois apps: "Wings Traffic Agent" (anúncios e formulário, `META_APP_SECRET`, `api/env.ts:519`; `docs/leads/meta-lead-ads.md:51-58`) e "Wings CRM Vendas" (WhatsApp, `WHATSAPP_APP_ID`/`WHATSAPP_APP_SECRET`, `api/env.ts:530,543-544`). Não existe `META_APP_ID`. A recomendação é usar o **Wings CRM Vendas** para o Instagram (empresa verificada segundo `docs/handoff/opus-crm-2026-09-30.md:34-35`, já tem usuário do sistema e o produto de login para empresas) e manter o app que mexe em verba separado do que conversa com pessoas. Detalhe e alternativa no anexo 7. **Decisão do Eric.**
5. **Modo de login: unificado** (Instagram API with Unified Login, token de usuário do sistema, `graph.facebook.com`), com a rota de envio `POST /{ig-user-id}/messages`. Motivo e alternativa (login pela Página) no anexo 7, §10.3. **Decisão do Eric.** O código é o mesmo nos dois modos; muda o token e a lista de permissões.
6. **Versão da Graph:** `v23.0`, a mesma de `api/modules/ads/platform/meta-client.ts:332` e `api/modules/whatsapp/graph.ts:11`.
7. **Os 12 exemplos do plano** são as 10 frases da coluna "Sinal típico" da lista de serviços mais as 2 frases de interesse e necessidade da tabela de intenção ("quanto custa formatar?" e "crescemos e a gestão não acompanha"). O plano não os lista em outro lugar; registrei esta leitura no anexo 2.

### 1.3 O que fica fora da Fase 1

- Leitura automática de comentários de concorrentes, raspagem, coleta de telefone de bio e envio em massa (proibidos, D3).
- Busca por hashtag (pede outra revisão da Meta; opção B recusada), menções em posts de terceiros além de registrar o aviso, Meta Content Library.
- Resposta pública automática a comentário (inclusive para "conteúdo educativo"): o vendedor responde no Instagram.
- Caixa de entrada do Direct dentro do CRM: a conversa acontece no Instagram (app ou Meta Business Suite); o CRM guarda o trecho da evidência e o prazo.
- Resposta como "atendente humano" depois de 24 h (pede outra aprovação da Meta).
- Qualquer mensagem gerada por IA. A única mensagem automática é o texto fixo aprovado pelo Eric (§3.1).
- Mudança no jeito de buscar do Google (o fluxo atual fica igual; só ganha o registro de ligação, PR C5).
- Fase 5: retorno de conversões para a Meta (API de Conversões) e para o Google Ads (conversão offline). Fica só o desenho de §9.6.
- Implantação na produção: a main não tem a prospecção nem as migrations 0084–0097 (auditoria, item J16). O piloto roda no staging.

### 1.4 Divergências entre o plano e o código (vale o código)

| # | O plano diz | O código mostra | Como a especificação trata |
|---|---|---|---|
| V1 | A IA da prospecção tem "teto diário de gasto" (`pros/service.ts:187`) | A prospecção só conta chamadas (60 por pessoa por dia, `shared/prospecting.ts:189`) e não registra custo (auditoria F) | O classificador usa teto em dólar com reserva antes da chamada, como a Sofia (anexo 2) |
| V2 | "O painel atual agrupa por funil e etapa" (`funnelSummary`) | `funnelSummary` (`api/modules/leads/service.ts:1340-1395`) não é usado por nenhuma tela; o painel em uso é `GET /crm/dashboard` (`api/modules/leads/sales-dashboard.ts:161`). E já existe um modelo dimensional (`dw`, `docs/bi/`, migration 0060) sem nenhuma carga | O painel por fonte entra no `dw` existente e traz a primeira carga (anexo 5) |
| V3 | O funil mostra "reuniões" e "propostas" | `crm_stages` não tem tipo de etapa (`api/db/schema/crm.ts:41-65`); reunião e proposta são reconhecidas pelo nome (`/reuni/i`, `/proposta/i`, `api/modules/ads/dashboard/funnel-crm.ts:25-26`) | Reaproveita a mesma regra e registra o risco: renomear uma etapa muda o painel. Reunião também conta por `crm_meetings` |
| V4 | Business Discovery em `check-instagram.ts` serve de base | O job pede só dados do perfil, sem posts (`worker/lib/instagram-check.ts:65`) | O radar faz uma chamada nova, com o campo `media` (PR E2) |
| V5 | "Ajustes da prospecção (existente)" ganha a lista de serviços | O Ajustes atual é uma aba de `ProspectingPage.tsx` (1.650 linhas, :1499-1650) | Ajustes do Prospect AI numa página nova; a aba atual só ganha um link (anexo 4) |
| V6 | `docs/crm/roadmap.md:36` previa as permissões `instagram_business_*` | Essas são do login pelo Instagram, que não tem Business Discovery nem hashtag | O login unificado usa `instagram_basic`, `instagram_manage_comments` e `instagram_manage_messages` (anexo 7) |
| V7 | A Graph "não trata limite de taxa" | Existe `isRateLimit` (17, 613, 80004) em `meta-client.ts:70-72`, mas ninguém chama; `MetaApiError` não guarda o status HTTP (:52-63) | O cliente novo devolve resultado sem lançar, com o status, no molde de `whatsapp/graph.ts:31-85` (anexo 3, §5.6) |
| V8 | O "Detalhe do lead" ganha uma aba | As abas ficam em `web/pages/crm/DealTabs.tsx:31-38` (628 linhas); a página `DealPage.tsx` tem 2.167 | Aba nova num componente novo; `DealTabs.tsx` ganha só a entrada da lista |
| V9 | A Meta manda o @ e o id da pessoa no comentário | Confirmado na documentação (`from.id`, `from.username`), mas nada disso foi testado ao vivo; o código atual nem recebe | Toda leitura do payload passa por Zod tolerante e o formato é marcado "não verificado ao vivo" até o PR D1 rodar com a conta de teste |

### 1.5 Decisões do Eric que faltam (com recomendação)

| # | Decisão | Recomendação |
|---|---|---|
| E1 | Quais serviços a Wings vende hoje (`vendido` na lista, anexo 1 §2.6) | Confirmar a lista de 11 linhas; serviço não vendido não vira lead |
| E2 | Palavras-chave | `FRANQUIA` para quem quer franquear e outra palavra (sugestão: `UNIDADE`) para quem quer comprar uma franquia |
| E3 | Texto da resposta automática | Aprovar o rascunho do anexo jurídico §3.1 (depois do advogado) |
| E4 | Quem responde o Direct no piloto | Uma pessoa fixa (`routing.instagramDonoPadrao`), com prazo de 1 hora útil |
| E5 | App da Meta e modo de login | App "Wings CRM Vendas", login unificado (anexo 7) |
| E6 | Limite de respostas automáticas por pessoa | Uma a cada 7 dias, mesmo que ela comente em vários posts (não é regra da Meta; é cuidado nosso) |
| E7 | O que conta como "lead qualificado" no painel | Oportunidade aprovada na fila, ou lead que saiu da etapa de entrada para uma etapa aberta (anexo 5) |
| E8 | Quem vê o painel por fonte | Gerente, Diretoria e Admin tudo; Marketing tudo (custo de anúncio); vendedor só os próprios números |
| E9 | Validação jurídica antes do piloto com clientes reais | Sim (anexo jurídico) |
| E10 | Modelo do classificador no piloto | Haiku 4.5 como principal e Haiku 5.5 em modo sombra na mesma amostra; decidir depois de 2 semanas (anexo 2) |

---

## 2. Contrato de dados

Resumo (detalhe no [anexo 1](anexos/01-contrato-de-dados.md)):

- **Base comum (C):** `prospect_ai_settings` (configuração em jsonb + Zod), `prospect_evidence` (prova: fonte, id externo, link, data, trecho de até 280 caracteres, base legal, retenção, quem registrou), `prospect_opportunities` (a fila: 6 estados, categoria e secundárias, intenção, prioridade e confiança 0–100, justificativa, dono, prazo, lead), `prospect_classifications` (histórico, inclusive o "certo/errado" do piloto), `prospect_source_health`, `prospect_classifier_cache` (só hash), `prospect_classifier_runs` (custo) e `prospect_call_logs` (registro de ligação).
- **Instagram (D):** `ig_webhook_events` (id único por evento, tentativas e espera), `ig_people` (IGSID, @, janela de 24 h, lead), `ig_private_replies` (uma por comentário, unique no banco).
- **Radar (E):** `competitor_accounts` e `competitor_posts` (só id, link, data, legenda curta e número de comentários; 30 dias).
- **Painel (F):** fatos e dimensões no schema `dw` existente.
- **Origens novas do lead** (só Zod): `instagram_comment`, `instagram_dm`, `instagram_ad`, `competitor_radar`.
- Migrations 0099 a 0105, depois da 0098 da trava.

---

## 3. Fluxos e regras

### 3.1 Comentário → palavra-chave → resposta privada → oportunidade

Disparo: evento `comments` do webhook (anexo 3, §5.5), já gravado em `ig_webhook_events` e processado pelo laço de 60 s (molde: `api/modules/leads/meta-intake.ts:1070-1135`).

1. **Ler o evento** com Zod tolerante: id do comentário, texto, `from.id` (IGSID), `from.username`, `media.id`, `media.media_product_type`, `media.ad_id` e `parent_id` se vierem. Faltou id do comentário ou `from.id` → `status = 'failed'`, `last_error = 'payload_invalido'`, sem nova tentativa.
2. **Ignorar o que é nosso:** `from.id` igual à conta da Wings → `status = 'ignored'` (respostas da própria Wings não podem disparar nada).
3. **Pessoa e prova:** upsert em `ig_people` pelo IGSID (atualiza `username` e `last_seen_at`). O permalink do post é lido uma vez por `media_id` (`GET /{media-id}?fields=permalink`, reaproveitado de uma evidência anterior do mesmo post, quando houver) e conta no limite da Graph.
4. **Palavra-chave, sem IA:** o texto é normalizado (minúsculas, sem acento, sem emoji, pontuação vira espaço) e comparado **palavra inteira** com as palavras ativas de `settings.keywords`. "franquia!", "FRANQUIA 🙌" e "quero franquia" casam; "franquiado" e "franquias" não. Negação ("não quero franquia") **não** é tratada no MVP: o texto aprovado já diz como pedir para parar.
5. **Sem palavra-chave:** o texto vai ao classificador (§3.2, passo 3, e anexo 2). Intenção `interesse_declarado`, `necessidade_provavel` ou `informacao_insuficiente` → abre oportunidade (passo 8, sem resposta automática). Qualquer outra → `status = 'done'`, **sem evidência nem oportunidade** (minimização).
6. **Com palavra-chave: portões, nesta ordem.** O primeiro que falhar grava `ig_private_replies.status = 'blocked'` com o motivo e segue para o passo 8 sem enviar:
   1. `INSTAGRAM_AUTO_REPLY_ENABLED` ligada e `settings.sources.instagram.pausada = false` (motivos `desligado`, `fonte_pausada`);
   2. comentário com menos de `deadlines.respostaPrivadaDias` (padrão 7) dias, com margem de 1 hora (`prazo_meta`). A data vem do evento; sem data, usa `received_at`;
   3. `contactBlock` do PR da trava, canal `instagram`, com o IGSID e o lead ligado, se houver (§3.8) → bloqueado = `nao_contatar`;
   4. limite por pessoa: `ig_people.last_auto_reply_at` mais recente que `limits.diasEntreRespostasMesmaPessoa` (`limite_pessoa`);
   5. limite por hora: respostas `sent` nos últimos 60 minutos ≥ `limits.respostasPrivadasPorHora` (padrão 600, teto da Meta 750) → `rate_limited` com nova tentativa em 5 minutos, se ainda couber nos 7 dias;
   6. fonte em espera por limite da Graph (`prospect_source_health.paused_until`) → `rate_limited`.
7. **Enviar, uma vez só:**
   1. inserir `ig_private_replies` com `status = 'sending'` (unique `(tenant_id, comment_id)`; conflito = já tratado, sai sem enviar);
   2. montar o texto: `settings.messages.textos[keyword.mensagem]`, trocando só `{link_diagnostico}` (com `?utm_source=instagram&utm_medium=comenta_e_recebe&utm_campaign=<palavra>&utm_content=op_<id da oportunidade>`) e `{link_politica}`. O texto nunca passa por IA. Grava `message_sha256`;
   3. `POST /{ig-user-id}/messages` com `{"recipient": {"comment_id": "<id>"}, "message": {"text": "<texto>"}}`, uma chamada;
   4. resultado: com `message_id` → `sent`, `sent_at`, `ig_people.last_auto_reply_at`; erro de limite certo (anexo 3, §5.6) → `rate_limited` e nova tentativa com espera; outro erro 4xx → `failed`, sem nova tentativa; tempo esgotado, 5xx ou resposta sem `message_id` → `unknown`, **nunca reenviado** (pode ter chegado; mesma regra de `whatsapp/graph.ts:67,81,257`). Código 10 ou 200 → `failed` e a fonte vira "aguardando a Meta".
8. **Oportunidade** (estado `nova`): evidência `instagram_comment` (ou `instagram_ad_comment` se houver `ad_id`), base legal `legitimate_interest`, `retention_until = occurred_at + retention.oportunidadeSemLeadDias`. Classificação `palavra_chave`: categoria = serviço da palavra, intenção `interesse_declarado`, confiança = `thresholds.confiancaPalavraChave` (60, abaixo do mínimo de 70, então a revisão humana é obrigatória e `needs_review_reason = 'confianca_baixa'`). `respond_by = occurred_at + 7 dias`. Dono: `routing.instagramDonoPadrao`, senão `nextInRotation` do funil da categoria, senão nenhum (só quem tem escopo `all` vê).
9. **Não vira lead aqui.** Só vira lead quando a pessoa responde no Direct (§3.2, passo 5) ou preenche o diagnóstico (§3.9).

### 3.2 Direct recebido → classificação → oportunidade → lead

Disparo: evento `messages` (inclusive a resposta à resposta privada).

1. **Ler** com Zod: `sender.id`, `recipient.id`, `timestamp`, `message.mid`, `message.text`, `message.is_echo`, `message.referral` e anexos (só o tipo). `is_echo = true` → é a Wings respondendo: marca `responded_at` na oportunidade aberta da pessoa, se ainda vazio, e `status = 'done'`. Sem texto (só figurinha, áudio ou foto) → atualiza a pessoa e a janela, sem classificar.
2. **Pessoa e janela:** upsert em `ig_people`; `last_inbound_at = timestamp`. Isso abre a janela de 24 h da Meta, e o `respond_by` de qualquer oportunidade aberta dela passa a `min(respond_by, last_inbound_at + deadlines.janelaDirectHoras)`.
3. **Pedido para parar, sem IA:** o mesmo padrão de `isOptOut` (`api/modules/whatsapp/webhook-parse.ts:342-343`: sair, parar, pare, stop, cancelar, descadastrar) → grava "não me contate" no canal `instagram`, chave `instagram_user` = IGSID, origem `instagram`, pela função de gravação do PR da trava; fecha as oportunidades abertas dela como `rejeitada` (`decision_reason = 'pediu_para_parar'`); nada é classificado.
4. **Classificar:** regras simples primeiro (anexo 2, §4.2); se não decidirem e `PROSPECT_AI_CLASSIFIER_ENABLED` estiver ligada, a IA, com cache e teto (anexo 2). Sem IA ou teto do dia atingido → categoria `nao_identificada`, confiança 0, `needs_review_reason = 'sem_ia'` ou `'teto_ia'`.
5. **Oportunidade ou lead:**
   - se a pessoa **tem oportunidade aberta de comentário** (respondeu à resposta privada): a nova mensagem vira evidência `instagram_dm` ligada à mesma pessoa, a classificação é atualizada se a da mensagem tiver confiança maior, e **vira lead** (passo 6) se a categoria for de um serviço vendido. Se a categoria for `nao_identificada`, de serviço não vendido ou de revisão obrigatória, fica em `em_revisao`;
   - se **não tem**: abre oportunidade `instagram_dm` (`legal_basis = 'pre_contract'`, a pessoa escreveu primeiro). Vira lead na hora só se intenção = `interesse_declarado`, confiança ≥ `thresholds.confiancaMinima`, serviço vendido e sem revisão obrigatória. Senão, `em_revisao` com o motivo;
   - intenção `comentario_casual`, `outro_assunto` ou `conteudo_educativo` sem oportunidade aberta → nada é criado (`status = 'done'`).
6. **Virar lead** (§3.6): `upsertLead` e, no mesmo processamento, `prospect_opportunities.state = 'aprovada'`, `lead_id`, `decided_by = null` (regra), `ig_people.lead_id`. `respond_by` fica como está: a tarefa de primeiro contato do `upsertLead` (`api/modules/leads/service.ts:781-782`, 1 hora útil) é o lembrete do vendedor.
7. **Prazo vencido:** o agendador de §3.10 passa para `prazo_vencido` toda oportunidade `nova` ou `em_revisao` com `respond_by < agora` e sem `responded_at`. Uma mensagem nova da pessoa volta a oportunidade para `em_revisao` com prazo novo.

### 3.3 Anúncios

- **Comentário em anúncio:** o evento traz `media.ad_id` (e às vezes `ad_title`). A evidência vira `instagram_ad_comment` com `ad_id`; o lead nasce com `source = 'instagram_ad'` e `attribution = { adPlatform: 'meta', adExternalId: ad_id }` (`api/modules/leads/service.ts:319-334`). Campanha e conjunto são achados depois pela tabela `ad_ads` (`api/db/schema/ads.ts:770-802`) quando o anúncio já foi ingerido, e gravados em `ad_campaign_external_id` e `ad_set_external_id` só se estiverem vazios.
- **Post impulsionado** pode gerar dois avisos do mesmo comentário: a unique `(tenant_id, event_key)` descarta o segundo.
- **Anúncio que abre o Direct:** a mensagem traz `referral` com `source = 'ADS'`, `type = 'OPEN_THREAD'` e `ad_id` (ou chega um evento `messaging_referral` sem texto). O `ad_id` é guardado na evidência; o lead nasce `instagram_ad` com a mesma atribuição. Referral sem mensagem só atualiza a pessoa e grava o `ad_id` pendente para a próxima mensagem dela (no `payload` do evento, lido pelo IGSID).

### 3.4 Radar de concorrentes (opção A)

1. **Contas:** quem tem `prospect_ai.configure` cadastra o @ e o ramo (`competitor_accounts`). Só conta comercial (a Business Discovery não lê conta pessoal).
2. **Leitura periódica** (agendador do PR E2, a cada hora, com `pg_try_advisory_xact_lock`), só com `COMPETITOR_RADAR_ENABLED` ligada e a fonte não pausada:
   - orçamento da rodada: `limits.radarChamadasPorHora` (padrão 20; o teto da Meta para a plataforma é de 200 × usuários do app por hora, e nunca chegamos perto);
   - pega as contas ativas com `last_fetched_at` mais antigo que `limits.radarAtualizarHoras`, uma chamada por conta: `GET /{INSTAGRAM_DISCOVERY_ACCOUNT_ID}?fields=business_discovery.username(<@>){media.limit(25){id,permalink,timestamp,caption,comments_count}}`;
   - grava ou atualiza `competitor_posts` (legenda cortada em 150 caracteres) e ignora posts mais velhos que a janela de retenção;
   - lê os cabeçalhos `X-App-Usage` e `X-Business-Use-Case-Usage`: qualquer uso ≥ 80% encerra a rodada; `estimated_time_to_regain_access` > 0 vira `paused_until`;
   - erros: limite (anexo 3, §5.6) → para a rodada e espera; 10, 190 ou 200 → fonte "aguardando a Meta"; 110, 24 ou subcódigo 2207013 → conta marcada `nao_encontrada` (mesmo mapa de `worker/lib/instagram-check.ts:95-112`).
3. **Tela:** posts dos últimos `limits.radarJanelaDias` dias, do mais comentado para o menos, com filtro por ramo. Botão "Abrir no Instagram" (permalink). **Os comentários não são lidos pelo sistema**: o vendedor lê no próprio Instagram.
4. **Registro manual de EMPRESA:** formulário com "Quem comentou é: Empresa / Pessoa física". Pessoa física desabilita o envio com o texto "Pessoa física não entra no radar (LGPD). Só registre empresas." A API exige `tipo: 'empresa'` (literal no Zod) e responde 400 `radar_somente_empresa` em qualquer outro caso. Campos: nome da empresa (obrigatório), @ da empresa, link do comentário (obrigatório, `https://www.instagram.com/...`), trecho (até 280), data do comentário, e pelo menos um **canal oficial publicado pela empresa** (site, telefone comercial, WhatsApp comercial ou e-mail comercial). Limite de `limits.radarRegistrosPorVendedorDia` por vendedor (429 `radar_limite_dia`).
5. **Oportunidade:** evidência `competitor_radar` (`legal_basis = 'legitimate_interest'`, `recorded_by` = vendedor, `url` = link do comentário), oportunidade `nova` com dono = quem registrou e `needs_review_reason = 'registro_manual'`. O trecho, se houver, passa pelo classificador. Mesmo link já registrado → 409 `radar_ja_registrado` com o dono atual.
6. **Aprovar** cria o lead por `upsertLead`: `source = 'competitor_radar'`, `company`, telefone ou e-mail **comerciais** digitados, `legalBasis = 'legitimate_interest'`, `consentSource = 'prospeccao'` (a trava `whatsappOptInMissing`, `shared/prospecting.ts:557-566`, passa a bloquear o WhatsApp até a empresa aceitar, como na prospecção Google), `ownerEmployeeId` = dono da oportunidade, `distribute: false`, `mergeOnlyIfOwnedBy` = dono (mesma regra de 28/10, `docs/decisoes.md:19`). O contato é feito à mão, um a um, pelo canal oficial.

### 3.5 Estados da oportunidade

| De | Para | Quem ou o quê | Regras |
|---|---|---|---|
| (nada) | `nova` | evento do Instagram ou registro do radar | |
| `nova` | `em_revisao` | regra (confiança baixa, revisão obrigatória, serviço não vendido, sem IA) ou alguém clica "Revisar" | grava `needs_review_reason` |
| `nova`, `em_revisao` | `aprovada` | regra (§3.2, passo 5) ou pessoa com `prospect_ai.review` + `leads.write` | exige lead: cria ou junta por `upsertLead` na mesma transação lógica; falhou o lead → a oportunidade não muda |
| `nova`, `em_revisao` | `rejeitada` | pessoa; ou regra (pediu para parar, exclusão a pedido) | motivo obrigatório na tela |
| `nova`, `em_revisao` | `duplicada` | pessoa | aponta o lead ou a oportunidade original |
| `nova`, `em_revisao` | `prazo_vencido` | agendador | `respond_by` passou sem `responded_at` |
| `prazo_vencido` | `em_revisao` | mensagem nova da pessoa | prazo novo |
| `rejeitada`, `duplicada` | `em_revisao` | só escopo `all` ("Reabrir") | `audit_log` |

Toda mudança grava `audit_log` (`api/lib/audit.ts:22`, sem dado pessoal: ids e códigos). Se há lead, grava também `lead_events` (`prospect.opportunity_<estado>`).

### 3.6 Roteamento e entrada no CRM

| Categoria | Funil (`pipeline`) |
|---|---|
| `investidor_franquia` (quer comprar uma franquia) | `expansao` |
| `formatacao_franquias`, `expansao_rede` (quer franquear) | `formatacao` |
| demais serviços vendidos | `consultoria` |
| `nao_identificada` ou serviço sem funil | não vira lead sozinha: fila de revisão; quem aprova escolhe o funil |

O funil vem de `settings.services[].funil`, então mudar o destino de um serviço é configuração. Parâmetros do `upsertLead` (`api/modules/leads/service.ts:225-316`):

| Campo | Instagram | Radar |
|---|---|---|
| `source` | `instagram_comment`, `instagram_dm` ou `instagram_ad` | `competitor_radar` |
| `externalId` | id do comentário ou `mid` da mensagem que abriu a oportunidade | link normalizado do comentário |
| `channel` | `instagram` | `instagram` |
| `fields` | `instagram` = @; telefone e e-mail **só se a pessoa escreveu** na conversa | empresa, telefone, e-mail ou site comerciais |
| `firstMessage` | trecho da evidência | trecho, se houver |
| `pipeline` | da categoria | da categoria |
| `legalBasis` / `consentSource` | `pre_contract` / `instagram` (a pessoa pediu) | `legitimate_interest` / `prospeccao` |
| `ownerEmployeeId` / `distribute` | dono da oportunidade, senão rodízio (`distribute: true`) | quem registrou / `false` |
| `attribution` | `{ adPlatform: 'meta', adExternalId }` quando há anúncio | — |
| `event` | `{ kind: 'lead.instagram', detail: { opportunityId, evidenceId } }` | `{ kind: 'lead.competitor_radar', detail: { opportunityId, evidenceId } }` |

Junção com lead existente: §2.10 do anexo 1. Dono e etapa do lead existente não mudam (`fillGaps`, `service.ts:420-471`). Telefone e e-mail nunca são obrigatórios.

### 3.7 Nota de prioridade (0–100)

`priority = round(Σ peso × nota)`, com os pesos de `settings.weights` (soma 100) e cada nota entre 0 e 1:

| Critério | Nota |
|---|---|
| clareza | 1 se há frase justificativa e a categoria não é `nao_identificada`; 0,5 se `informacao_insuficiente`; 0 nos demais |
| intenção | `interesse_declarado` 1; `necessidade_provavel` 0,6; `informacao_insuficiente` 0,3; demais 0 |
| encaixe | 1 se o serviço é vendido; 0 se não; 0 para `nao_identificada` |
| perfil da empresa | 0,5 (neutro) no MVP: dado ausente nunca conta como zero. Fica o campo para quando houver nota ICP da empresa |
| atualidade | `max(0, 1 − horas desde o evento ÷ horas da janela)`, com janela de 24 h (Direct) ou 168 h (comentário e radar) |
| confiabilidade da fonte | 1 para texto escrito pela pessoa; 0,6 para registro manual do radar |

Recalculada a cada classificação nova e uma vez por hora pelo agendador de §3.10 (a atualidade cai com o tempo). Nenhum atributo pessoal (idade, sexo, saúde, família) entra; sucessão e reestruturação são sempre `revisaoObrigatoria`. Função pura em `shared/prospect-ai.ts`, testada.

### 3.8 "Não me contate" antes de qualquer resposta automática

- A única resposta automática do módulo é a resposta privada (§3.1). Antes dela, `contactBlock(tenant, 'instagram', { leadId, instagramUserId })` do PR `feat/trava-unica-contato`. Bloqueado → não envia, grava `blocked` com `nao_contatar`, e a oportunidade mostra o selo.
- **Contrato esperado da trava** (a confirmar no PR dela, sem redesenhar): canal `instagram` e chave `instagram_user` existem na tabela `contact_opt_outs`; `contactBlock` aceita o id do Instagram e devolve `{ bloqueado, motivo, origem }`. Se o nome ou a assinatura mudarem no merge, só o adaptador `api/modules/instagram/opt-out.ts` muda.
- Aprovar uma oportunidade do radar e o botão "Registrar não me contate" da fila também gravam pela função de gravação da trava.
- A Sofia não entra neste módulo (já corrigida pelo PR da trava).

### 3.9 Diagnóstico pelo link

O link da resposta privada leva a um formulário do site já existente (rota pública `/public/site-forms/:slug`, `api/modules/site/site-forms.ts:306`), com `utm_content=op_<id>`. Quando o `upsertLead` do formulário cria ou junta o lead (`source = 'site_form'`), um gancho do PR D4 procura a oportunidade pelo `utm_content`, liga `lead_id` e passa para `aprovada`. A origem do lead continua `site_form` (primeiro toque, como manda `fillGaps`); a evidência do comentário aparece na aba "Origem e evidência". Qual formulário: **decisão do Eric** (sugestão: o diagnóstico de Formatação que já existe).

### 3.10 Agendadores do módulo

Todos no padrão `setInterval` + `pg_try_advisory_xact_lock`, iniciados em `api/server.ts`, cada um com uma chave de trava própria:

| Agendador | Intervalo | Faz | PR |
|---|---|---|---|
| `prospect-ai:housekeeping` | 1 h | prazo vencido (§3.5), recálculo da atualidade, limpeza de retenção (anexo 1), alerta "fonte sem evento" | C7 (D3 acrescenta o alerta) |
| `instagram:intake` | 60 s + chute do webhook | processa `ig_webhook_events` e reenvia `rate_limited` | D2 |
| `instagram:radar` | 1 h | lê a Business Discovery | E2 |
| `dw:funil-fonte` | diário às 03:00 (São Paulo) + botão "Recalcular" | carrega o modelo dimensional | F2 |

### 3.11 Erros e o que acontece

| Erro | Efeito | Onde aparece |
|---|---|---|
| Assinatura do webhook inválida | 401, nada gravado | log (só o formato) |
| Payload fora do formato | evento `failed` (`payload_invalido`), sem nova tentativa | Central de fontes, contagem |
| Banco fora durante o webhook | 500; a Meta reenvia | — |
| Graph com limite (429, 4, 17, 32, 613, 80002, 80006) | espera crescente na fonte; resposta privada `rate_limited` | Central: "Em espera até HH:MM" |
| Graph sem permissão (10, 200) ou token inválido (190) | fonte "aguardando a Meta"; nada é reenviado | Central, com o código |
| Resposta privada sem confirmação (tempo esgotado, 5xx) | `unknown`, nunca reenviada | cartão da oportunidade: "Envio não confirmado; confira no Instagram" |
| IA fora, resposta inválida ou teto do dia | oportunidade vai para revisão humana | cartão: "Sem classificação automática" |
| `upsertLead` recusa (`ForeignLeadError`, `NumberInAttendanceError`, `service.ts:525,532`) | 409 com o dono; a oportunidade não muda | tela da fila |
| Evento com 8 tentativas falhas | `failed` | Central de fontes |

---

## 4. Classificador

Resumo (detalhe e frases de teste no [anexo 2](anexos/02-classificador.md)): entra só o texto (sem @, nome, telefone ou e-mail); regras simples antes da IA; saída por ferramenta forçada e Zod (categoria, secundárias, intenção, confiança, frase que justifica e que **tem de existir no texto**); modelo por variável (`anthropic/claude-haiku-4.5`, com `anthropic/claude-haiku-5.5` em modo sombra para comparar); cache pelo hash do texto; teto diário `PROSPECT_AI_DAILY_USD` com reserva antes da chamada; nenhuma ferramenta, nenhuma escrita no banco; texto delimitado como dado.

## 5. API e configuração

Resumo (detalhe no [anexo 3](anexos/03-api-e-configuracao.md)): três permissões novas (`prospect_ai.review`, `prospect_ai.configure`, `prospect_ai.dashboard`), rotas `/prospect-ai/*`, `/prospecting/calls` e o webhook público `/integrations/instagram/webhook`; variáveis novas só por nome; chaves de liga e desliga com padrão desligado; tratamento dos limites da Graph com espera crescente.

## 6. Telas

Resumo (detalhe no [anexo 4](anexos/04-telas.md)): Painel de prospecção, Central de fontes, Fila de oportunidades, Radar de concorrentes, aba "Origem e evidência" no lead e Ajustes, no padrão atual do CRM Vendas.

## 7. Painel por fonte

Resumo (detalhe no [anexo 5](anexos/05-painel-por-fonte.md)): fato do funil por dia × fonte × campanha × vendedor × categoria, no schema `dw` que já existe, com fato de custo separado e visões que calculam as taxas; "—" e o motivo quando não há dado.

## 8. Testes

Resumo (detalhe no [anexo 6](anexos/06-testes.md)): Vitest com a rede travada, banco descartável, um conjunto por PR, mais os critérios do piloto.

---

## 9. Sequência de PRs

Cada PR é pequeno, entra no staging com o OK do Eric e não liga nada sozinho. A coluna "Depende de" é de merge; PRs sem dependência entre si podem ser feitos em paralelo.

### 9.1 (C) Base comum

| PR | Entrega | Depende de | Migration |
|---|---|---|---|
| C1 | Tabelas `prospect_ai_settings`, `prospect_evidence`, `prospect_opportunities`, `prospect_classifications`, `prospect_source_health`; Zod em `shared/prospect-ai.ts` (estados, intenções, configuração e padrões); origens novas do lead (§2.12 do anexo 1); permissões novas e a matriz por papel; linha de 29/10 em `docs/decisoes.md` se ainda não estiver | trava (0098) | 0099 |
| C2 | Serviço da fila (`api/modules/prospect-ai/opportunities.ts`): criar, transições de §3.5, prioridade (§3.7), aprovar com `upsertLead`, escopo own/sector/all; rotas da fila e de configuração | C1 | — |
| C3 | Classificador: regras, IA, cache, custo e teto (anexo 2); só a função, sem fonte ligada | C1 | 0100 |
| C4 | Telas: Fila de oportunidades e Ajustes (anexo 4) | C2 | — |
| C5 | Registro de ligação: tabela, rotas `/prospecting/calls`, botão "Registrar ligação" no cartão do prospect e do lead; "pediu para não contatar" grava pela trava | trava (0098) | 0101 |
| C6 | Aba "Origem e evidência" no lead | C2 | — |
| C7 | Agendador `prospect-ai:housekeeping` (prazo, atualidade, retenção) | C2 | — |

### 9.2 (D) Conector do Instagram, atrás de chave desligada

| PR | Entrega | Depende de | Migration |
|---|---|---|---|
| D1 | Tabelas `ig_webhook_events`, `ig_people`, `ig_private_replies`; rota pública do webhook (handshake, HMAC, enfileirar, responder na hora); variáveis novas; Zod tolerante dos payloads | C1 | 0102 |
| D2 | Laço de processamento (comentário, menção, mensagem, eco, referral), com espera crescente; cria evidência e oportunidade; classificação por C3 | D1, C2, C3 | — |
| D3 | Cliente Graph do Instagram (`api/modules/instagram/graph.ts`), resposta privada com portões e idempotência, limites da Graph; Central de fontes (tela) e alerta "fonte sem evento" | D2 | — |
| D4 | Lead a partir da resposta no Direct e do diagnóstico (§3.2, §3.9); atribuição de anúncio (§3.3) | D2, C2 | — |
| D5 | Exclusão a pedido (pessoa do Instagram) e "não me contate" pelo Direct | D2, trava | — |

Com D1 a D5 no staging e as chaves ainda desligadas, o Eric segue o anexo 7 (Fase 2) e liga primeiro `INSTAGRAM_WEBHOOK_ENABLED` (só recebe), depois `INSTAGRAM_AUTO_REPLY_ENABLED` com as contas de teste, e grava o vídeo.

### 9.3 (E) Radar de concorrentes

| PR | Entrega | Depende de | Migration |
|---|---|---|---|
| E1 | Tabelas `competitor_accounts`, `competitor_posts`; rotas das contas e dos posts | C1 | 0103 |
| E2 | Agendador `instagram:radar` (Business Discovery com orçamento por hora e espera) | E1, D3 (cliente Graph) | — |
| E3 | Tela do Radar e registro manual de empresa (pessoa física bloqueada), aprovação em lead | E1, C2 | — |

### 9.4 (F) Painel por fonte

| PR | Entrega | Depende de | Migration |
|---|---|---|---|
| F1 | Dimensões, fatos e visões novas no `dw`; `GRANT` para `wings_ro` | C1 | 0104, 0105 |
| F2 | Carga diária e "Recalcular" (`api/modules/prospect-ai/dw-load.ts`) | F1, C2 | — |
| F3 | Tela do Painel de prospecção | F2 | — |

F1 e F2 podem começar logo depois de C1: as fontes Google e anúncios já têm dados; as do Instagram aparecem com "—" e o motivo até D entrar.

### 9.5 Ordem sugerida

C1 → (C2, C3, C5, F1 em paralelo) → (C4, C6, C7, D1, E1, F2) → (D2, E3, F3) → D3 → (D4, D5, E2) → Fase 2 na Meta (anexo 7) → piloto de 4 semanas.

### 9.6 Fase 5 (depois do piloto): retorno de conversões

- **Meta (API de Conversões):** evento `Lead` qualificado e `Purchase` (contrato) para leads com `fbclid` ou origem `meta_lead_ads`/`instagram_ad`, com e-mail e telefone em SHA-256 (só com base legal validada, `docs/ads/fechar-ciclo.md:242-262`); id do evento = id do lead + etapa, para não duplicar com o `fbq` do site (`web/lib/site-conversion.ts:85-90`).
- **Google Ads (conversão offline):** `uploadClickConversions` com o `gclid`, `gbraid` ou `wbraid` já guardados no lead (`api/db/schema/leads.ts:146-149`), na mudança para "qualificado" e para "ganho".
- Ambos atrás de chave desligada, com fila própria e registro de envio. Pré-requisito: a política de privacidade publicada e o advogado de acordo.

---

## 10. Checklist da Fase 2 na Meta

No [anexo 7](anexos/07-fase2-meta.md): qual app, produto Instagram, permissões por modo de login (com a recomendação), modo Live, verificação da empresa, URLs de privacidade e de exclusão de dados, "permitir acesso a mensagens" no app do Instagram, inscrição dos webhooks e o roteiro do vídeo de cada permissão.

## 11. Anexo para o advogado

No [anexo jurídico](anexos/juridico.md): teste de legítimo interesse (3 fases do guia da ANPD) para Google e Instagram, textos dos avisos e prazos de retenção. Tudo marcado "a validar".
