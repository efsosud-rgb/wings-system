# Prospecção Instagram — especificação técnica (3 partes, só pela via oficial)

Versão de 29/10/2026. Pedido e aprovação: Eric, 29/10/2026 às 16:35 ("Tudo aprovado"). Base de código: develop no commit `3a9a6f0f`; toda referência `arquivo:linha` é desse commit. Abreviações: `api` = `apps/api/src`, `web` = `apps/web/src`, `shared` = `packages/shared/src`, `worker` = `apps/worker/src`.

**Só documentação.** As seções 7 (Meta) e 8 (LGPD) estão em [instagram-meta-lgpd.md](instagram-meta-lgpd.md). Nada aqui foi construído, ligado ou configurado: nenhum código, banco, app da Meta, staging ou produção mudou. Tudo o que toca a Meta é feito pelo Eric, na hora (§7).

**De onde parte.** Esta especificação se apoia na especificação do Wings Prospect AI do PR #54 (branch `docs/prospect-ai-especificacao`, commit `4a21a456`, ainda aberto e em correção pela tarefa t023), chamada aqui de **"spec PA"**, e no código da Prospecção Google já mesclado (`docs/crm/prospeccao.md`, PR #55). Ela reaproveita as tabelas, o classificador, a trava de contato e o conector do Instagram da spec PA e só acrescenta o que as três partes pedem. Se a spec PA mudar na correção, vale a versão mesclada dela, e esta é ajustada no mesmo PR que construir a fase.

| Parte                                            | O que faz                                                                                                            | Depende da Meta?                                                                    | Fase             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------- |
| 2. Comentários de concorrentes (com a vendedora) | A vendedora cola o texto dos comentários; a IA separa quem quer comprar; ela aborda à mão pelo Direct da Wings       | **Não**: o sistema não entra no Instagram                                           | **A** (primeiro) |
| 3. Empresas do perfil ideal                      | Empresas da busca do Google que têm Instagram passam pela Business Discovery; os números entram na nota de 0 a 100   | Sim, mas usa a conta e o token que o sistema já tem para a conferência de Instagram | **B**            |
| 1. Comentários nos posts e anúncios da Wings     | Webhook de comentários; a IA separa quem quer comprar; prospect com o @ e o comentário; uma resposta privada oficial | Sim: permissões novas, webhooks e revisão do app                                    | **C**            |

**Proibido, e por isso não existe código para isso** (decisão do Eric e termos do Instagram): ler o Instagram com sessão logada, extensão de navegador, raspagem, cookie, automação de conta pessoal, copiar telefone de bio de forma automática, mandar mensagem automática fora das regras do Private Replies, mandar WhatsApp para quem não deu permissão.

Marcas: **proposta** = número ou texto nosso, sem fonte externa, para o Eric aprovar ou calibrar no piloto; **a validar** = depende do Jurídico (t066, t067); **divergência** = esta especificação e a spec PA dizem coisas diferentes, com a opção adotada.

---

## 0. Fontes oficiais consultadas (29/10/2026)

Todas lidas em 29/10/2026 (HTTP 200). O que a página não diz está como "—" ao longo do texto.

| Fonte                                                                                                                                                                                                                                                                                                   | Fatos usados aqui                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Private Replies](https://developers.facebook.com/docs/instagram-platform/private-replies)                                                                                                                                                                                                              | Vale para comentário em post, reel, story, Live ou "ad post" da conta profissional. `POST /<IG_ID>/messages` com `{"recipient":{"comment_id":"…"},"message":{"text":"…"}}`, resposta com `recipient_id` e `message_id`. "within 7 days of the creation time of the comment" (Live: só durante a transmissão). "Only one message can be sent to the commenter." "Follow-up messages can only be sent if the recipient responds, and must be sent within 24 hours of the response." Chega na caixa de entrada se a pessoa segue a conta; senão, em Solicitações                                                                                                                                   |
| [Campos de webhook](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields), [exemplos](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples) e [configuração](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup) | Permissão de cada campo por modo de login (§7.2). Corpo do `comments`: `from.id`, `from.username`, `comment_id`, `parent_id` (resposta), `text`, `media.id`, `media.media_product_type` e, em anúncio, `media.ad_id`, `media.ad_title`, `media.original_media_id`. "Your app must be published or Live to receive notifications"; "Advanced Access is required for comments and live_comments notifications"; "The account that owns the media must be public"; "Notifications do not return ad IDs for media used in dynamic ads"; verificação da empresa "Required for production access"                                                                                                     |
| [Business Discovery (guia)](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery) e [referência](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery)                     | `GET /<IG_USER_ID>?fields=business_discovery.username(<USERNAME>){…}`; dados de "other Instagram Business or Creator IG Users"; "Data about age-gated Instagram professional accounts will not be returned"; permissões da referência: `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` (+ `ads_management` ou `ads_read` se o papel na Página veio pelo Gerenciador de Negócios). Campos públicos do [IG User](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user): `biography`, `followers_count`, `id`, `media_count`, `username`, `website`; nos exemplos de mídia: `comments_count`, `like_count`, `view_count` |
| [Limites de taxa](https://developers.facebook.com/docs/graph-api/overview/rate-limiting)                                                                                                                                                                                                                | Instagram Platform: "Calls within 24 hours = 4800 * Number of Impressions" (fora mensagens). Business Discovery segue o limite da plataforma ("200 * Number of Users" por hora para token de app; para token de usuário, não divulgado). Private Replies: 750 chamadas por hora por conta (posts e reels); 100 por segundo em Live. Send API: 100 por segundo para texto (a mesma página diz 300 por segundo em outra seção: divergência da própria Meta). Erro de limite do Instagram: `80002`                                                                                                                                                                                                 |
| [Permissões](https://developers.facebook.com/docs/permissions)                                                                                                                                                                                                                                          | Texto e dependências de `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `pages_*`, `business_management`, `instagram_business_*`; cada uma pede descrição de uso e vídeo na revisão; "Business Verification … is required for all apps making requests for Advanced Access"                                                                                                                                                                                                                                                                                                                                                                                        |
| [Revisão do app](https://developers.facebook.com/docs/app-review) e [guia de envio](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide)                                                                                                        | Quem não tem papel no app só usa depois da revisão. "Make at least 1 successful API call using each permission … within 30 days of submitting"; gravação de tela "1080 or better", "Omit audio"; "Any requested permission or feature missing a screen recording will not be approved"; a gravação mostra a pessoa concedendo a permissão e o uso                                                                                                                                                                                                                                                                                                                                               |
| [Moderação de comentários](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/comment-moderation) e [`/comments`](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments)                              | "We strongly recommend using webhooks to prevent rate limiting"; `GET /<IG_MEDIA_ID>/comments` traz até 50 por chamada, só os de primeiro nível; comentário de anúncio: pegar `effective_instagram_media_id` do anúncio pela Marketing API; post impulsionado devolve os comentários das duas mídias                                                                                                                                                                                                                                                                                                                                                                                            |

Divergências da documentação, tratadas com a opção segura:

- **Business Discovery por modo de login.** O guia diz que funciona no login pelo Facebook e no login unificado; a referência cita só o login pelo Facebook; nenhuma das duas cita o login pelo Instagram. A spec PA (anexo 7, §10.3) lista só `instagram_basic` para ela; a referência pede também `instagram_manage_insights` e `pages_read_engagement`. **Adotado:** pedir as três da referência (§7.2).
- **`instagram_manage_messages` na resposta privada.** A página só diz isso na coluna do login unificado. **Adotado:** pedir a permissão em qualquer modo, porque a resposta seguinte (quando a pessoa responde) é Direct.
- **Campo `timestamp` da mídia na Business Discovery.** Não aparece nas páginas lidas. **Adotado:** pedir o campo e tratar a ausência como "sem dado" (§6.2), nunca como zero.

---

## 1. Fluxos, telas e estados

### 1.1 Onde fica

CRM Vendas → Prospecção (`/crm-vendas/prospeccao`) ganha a aba **Instagram**, ao lado da busca do Google que já existe:

| Aba ou bloco                                                                                            | Parte   | Quem vê                                                           |
| ------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------- |
| Instagram → **Colar comentários**                                                                       | 2       | quem tem `prospecting.instagram_paste` (§9)                       |
| Instagram → **Minhas listas** (as colagens e os prospects de cada uma)                                  | 2       | o vendedor vê as suas; gerência, Diretoria e Admin veem todas     |
| Instagram → **Comentários da Wings** (a fila de oportunidades da spec PA filtrada por origem Instagram) | 1       | dono da oportunidade; gerência, Diretoria e Admin todas           |
| Busca do Google → coluna **Instagram** e nota de 0 a 100                                                | 3       | quem já usa a busca (`prospecting.use`)                           |
| Ajustes → **Instagram** (limites, pesos, textos, chaves)                                                | 1, 2, 3 | `prospect_ai.configure`; o modo automático só o Admin Master (§9) |
| Central de fontes (spec PA, anexo 4)                                                                    | 1, 3    | gerência e Admin                                                  |

Toda tela que não conseguir carregar mostra "—" e o motivo (`components/LoadFailure.tsx`), nunca uma lista vazia que pareça real.

### 1.2 Parte 2 — comentários de concorrentes, colados pela vendedora (Fase A)

1. **No Instagram (fora do sistema):** a vendedora abre, no próprio celular ou computador, o post de um concorrente ou de uma marca do nicho, seleciona os comentários e copia o texto. O sistema não abre, não lê e não guarda nada do Instagram por conta própria.
2. **Colar:** em Instagram → Colar comentários, ela cola o texto, informa o **link do post** (obrigatório, `https://www.instagram.com/p/…` ou `/reel/…`) e, se souber, o **@ do dono do post** (o sistema também o reconhece pelo rótulo "Autor" ou pelo primeiro bloco, §4). Botão **"Ler comentários"**.
3. **Prévia, sem gravar nada e sem IA:** a API lê o texto (§4) e devolve a prévia: N comentários reconhecidos, M linhas ignoradas (com o motivo de cada tipo) e K linhas não reconhecidas (as primeiras 20 aparecem para ela conferir). Cada comentário já vem cruzado com a base (§2.4): "já é lead de X", "já é cliente", "não contatar", "já está na lista de Y". Nada foi gravado ainda; fechar a tela descarta tudo.
4. **Confirmar:** "Separar quem quer comprar (N comentários)". Só aí a API grava a colagem (`ig_paste_batches`) e os comentários aproveitáveis (§2), roda as regras simples e a IA (§3) e devolve três listas:
   - **Quer comprar**: sinal `quer_comprar` ou `pediu_preco` com confiança ≥ 70;
   - **Revisar**: confiança de 40 a 69, sinal `duvida`, ou sem classificação automática (IA desligada, teto do dia, resposta inválida);
   - **Outros** (fechada, só com a contagem por sinal): `elogio`, `reclamacao`, `spam` e confiança abaixo de 40. A vendedora pode abrir e mover um item para "Quer comprar".
     Quem já é lead, cliente ou "não contatar" **não vira prospect** (§2.4): aparece só na contagem da prévia.
5. **Abordar, à mão:** em cada prospect, a tela mostra o @, o trecho do comentário, a data (aproximada, §4.3), o link do post, o sinal, a confiança e a frase que justificou. Botões:
   - **"Abrir no Instagram"**: abre `https://www.instagram.com/<@>/` numa aba nova; a vendedora escreve pelo Direct da conta da Wings, no app ou no Meta Business Suite;
   - **"Copiar mensagem"**: copia o texto de primeira abordagem (§8.2) com o nome dela e o @ do post já trocados. Nada é enviado pelo sistema;
   - **"Abordei"**: registra a data (estado `abordada`);
   - **"Criar lead"**: quando a pessoa respondeu. Formulário igual ao "Criar lead" da busca do Google (`docs/crm/prospeccao.md`, "Criar lead"): telefone ou e-mail **que a pessoa passou na conversa**, digitados pela vendedora, e **"A pessoa pediu contato por WhatsApp?"** (obrigatório). O lead nasce no funil da categoria (spec PA, §3.6), dono = a vendedora, origem `instagram_colagem`;
   - **"Não contatar"**: grava o "não me contate" pelo @ (§8.3); **"Descartar"** com motivo.
6. **Prazo:** prospect que não virar lead em 30 dias desde a última mudança (criação, "Abordei" ou transferência) é apagado (§8.4).

### 1.3 Parte 3 — empresas do perfil ideal pela Business Discovery (Fase B)

1. A vendedora busca no Google como hoje. Para cada resultado, a API diz se a empresa tem Instagram conhecido, por uma destas fontes, nesta ordem:
   - o Instagram que o **site da própria empresa** mostrou (`prospects.enrichment.instagram`, guardado com `source: 'site da empresa'` e a data);
   - o **site informado no Google** quando ele é um perfil `instagram.com/<@>` (lido ao vivo da resposta do Google; o @ tirado dele **não** é gravado ligado ao `place_id`, regra "Só o `place_id` é guardado" em `docs/crm/prospeccao.md`).
2. A tela recebe a lista e pede, numa segunda chamada (`POST /prospecting/instagram/discovery`, até 20 @ por vez), os números do Instagram. A API devolve o que estiver no cache (§2.2, `instagram_business_snapshots`, até 7 dias) e chama a Business Discovery só para o resto, dentro do limite (§6.4).
3. A coluna **Instagram** mostra seguidores, posts, média de curtidas e comentários dos posts recentes e a data da leitura ("Meta, lido em DD/MM"). Sem dado: "—" e o motivo (§6.5). A **nota de 0 a 100** (§6.3) passa a ordenar a lista; o detalhe mostra cada critério que contou.
4. Nenhuma pessoa física passa pela Business Discovery: ela só é chamada para o @ de uma empresa vinda da busca do Google, nunca para o @ de quem comentou (partes 1 e 2), regra da spec PA (anexo 1, §2.10).

### 1.4 Parte 1 — comentários nos posts e anúncios da Wings (Fase C)

O fluxo de recebimento, os portões e o envio idempotente são os da spec PA, §3.1 a §3.3 (webhook → `ig_webhook_events` → laço de 60 s → evidência → oportunidade → resposta privada). A diferença pedida pelo Eric é **quem dispara a resposta**: além da palavra-chave da spec PA, a classificação da IA (§3). Resumo:

1. O webhook `comments` traz o comentário (§5.1). Comentário da própria Wings ou do dono do post é ignorado.
2. Regras simples e IA (§3). Sinal `quer_comprar` ou `pediu_preco` → abre oportunidade `nova` com o @, o trecho, o link do post e o anúncio (se houver). `duvida` → oportunidade em `em_revisao`, sem resposta automática. `elogio`, `reclamacao`, `spam` → nada é criado (minimização); a reclamação aparece só na contagem da Central de fontes, para a gerência olhar no Instagram.
3. Quem já é lead ou cliente: não vira oportunidade nova; a evidência entra na linha do tempo do lead existente e o dono recebe o aviso (§2.4).
4. **Resposta privada (§5.3):** passa pelos portões da spec PA (chave ligada, prazo de 7 dias, "não contatar", uma por pessoa a cada 7 dias, limite por hora) e sai **uma vez**, com o texto fixo aprovado pelo Eric (§5.4). No começo, ela só sai com um clique humano ("Enviar resposta privada"); o envio sozinho depende do Eric (§5.2).
5. A pessoa respondeu no Direct → o dono da oportunidade continua pelo Instagram, dentro de 24 h da resposta dela (§5.5). Se ela escreveu telefone ou e-mail, esses dados entram no lead.

### 1.5 Estados do prospect

O prospect do Instagram é a **oportunidade** da spec PA (`prospect_opportunities`, anexo 1, §2.3), com os estados dela e um a mais, `abordada`, para a parte 2.

| De                                                             | Para            | Quem ou o quê                                                                  | Parte | Regras                                                  |
| -------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------ | ----- | ------------------------------------------------------- |
| (nada)                                                         | `nova`          | colagem confirmada (2) ou webhook (1)                                          | 1, 2  |                                                         |
| `nova`                                                         | `em_revisao`    | regra (confiança baixa, sem IA, `duvida`) ou clique "Revisar"                  | 1, 2  | grava `needs_review_reason`                             |
| `nova`, `em_revisao`                                           | `abordada`      | vendedora clica "Abordei"                                                      | 2     | grava `responded_at`; o prazo de 30 dias recomeça       |
| `nova`, `em_revisao`, `abordada`                               | `aprovada`      | "Criar lead" (2); regra da spec PA §3.2 ou pessoa com `prospect_ai.review` (1) | 1, 2  | exige lead (CHECK da spec PA)                           |
| qualquer aberto                                                | `rejeitada`     | pessoa, com motivo; regra (pediu para parar, exclusão a pedido)                | 1, 2  |                                                         |
| qualquer aberto                                                | `duplicada`     | pessoa                                                                         | 1, 2  | aponta o lead ou a oportunidade original                |
| `nova`, `em_revisao`                                           | `prazo_vencido` | agendador                                                                      | 1     | `respond_by` (7 dias do comentário) passou sem resposta |
| `nova`, `em_revisao`, `abordada`, `prazo_vencido`, `rejeitada` | apagada         | agendador de retenção                                                          | 1, 2  | 30 dias sem virar lead (§8.4); fica só a contagem       |

**Divergência:** a spec PA não tem `abordada`. O PR A2 acrescenta o valor ao CHECK de `state` (e à lista Zod) numa migration curta; é o único estado novo. Toda mudança grava `audit_log` (ids e códigos, nunca o @ ou o trecho) e, se há lead, `lead_events`.

### 1.6 O que cada perfil vê e clica

| Quem                             | Parte 2                                                                                                    | Parte 3                                   | Parte 1                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Vendedora** (Formatação)       | cola, revisa, aborda, cria lead, marca "não contatar"; vê só as próprias listas                            | vê a nota e a coluna Instagram na busca   | vê e trabalha as oportunidades em que é dona; clica "Enviar resposta privada" se for a dona |
| **Gerência** (Gerente Comercial) | vê todas as listas, transfere prospect, reabre descartado                                                  | igual à vendedora + muda pesos em Ajustes | vê a fila inteira, aprova, transfere; vê a Central de fontes; muda limites                  |
| **Diretoria**                    | vê todas as listas e os números, sem colar nem criar lead (não tem `leads.write`, como na busca do Google) | vê a nota                                 | vê a fila e o painel por fonte, só leitura                                                  |
| **Eric (Admin Master)**          | tudo                                                                                                       | tudo                                      | tudo + aprova o texto da resposta privada e liga o envio sozinho                            |

---

## 2. Modelo de dados

Regras da spec PA (anexo 1, §2.0) valem para tudo: `tenant_id uuid not null default WINGS_TENANT_ID references tenants` em toda tabela e em toda unique de negócio; `id uuid`; `timestamptz`; dinheiro em inteiro (`*_micro_usd`); estados em `text` com CHECK e a mesma lista em Zod no `shared`. Migrations geradas por `db:generate` no PR que precisar. **Os números da spec PA (0099–0105) já foram usados** pela Central do WhatsApp (`apps/api/migrations/0099_wa_message_files.sql` a `0102_wa_reliability.sql`): o número sai do `db:generate` no dia do merge.

### 2.1 Reaproveitadas

| Tabela                                                                              | De onde                                                                   | O que esta especificação usa ou muda                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prospect_evidence`                                                                 | spec PA, anexo 1, §2.2                                                    | nova `source` **`instagram_colagem`** (parte 2) no CHECK; `external_id` = `sha256(link do post normalizado + '\n' + @ + '\n' + texto normalizado)` (o mesmo comentário colado duas vezes não duplica); `url` = link do post; `author_username` = @ de quem comentou; `excerpt` = trecho (até 280, com telefone, e-mail e link mascarados, §4.4); `recorded_by` = vendedora; coluna nova **`occurred_at_precision`** (`exata` \| `aproximada`, §4.3) |
| `prospect_opportunities`                                                            | spec PA, §2.3                                                             | estado novo `abordada` (§1.5); coluna nova **`buy_signal`** (os 6 sinais de §3.1, CHECK); `paste_batch_id` → `ig_paste_batches` (parte 2)                                                                                                                                                                                                                                                                                                           |
| `prospect_classifications`, `prospect_classifier_cache`, `prospect_classifier_runs` | spec PA, §2.4 e §2.7                                                      | `method` ganha `ia_lote` (parte 2, §3.5); `buy_signal` na saída                                                                                                                                                                                                                                                                                                                                                                                     |
| `prospect_ai_settings`                                                              | spec PA, §2.6                                                             | chaves novas em `settings.instagram` (§2.5)                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ig_webhook_events`, `ig_people`, `ig_private_replies`                              | spec PA, §2.9                                                             | parte 1, sem mudança                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `contact_opt_outs`                                                                  | develop, migration `0098_contact_opt_outs` (`docs/crm/nao-me-contate.md`) | chave `instagram_user` (o @ sem arroba, `shared/contact-opt-out.ts:21-28`), canal `instagram`, origem `instagram` ou `prospeccao`; lida por `contactBlock` (`api/modules/leads/contact-block.ts:187`)                                                                                                                                                                                                                                               |
| `leads`                                                                             | develop                                                                   | `instagram` (`api/db/schema/leads.ts:78`), `phone`, `email`, `company_cnpj` (:82), `source` (origens novas em §2.6)                                                                                                                                                                                                                                                                                                                                 |
| `clients`                                                                           | develop                                                                   | `cnpj` (`api/db/schema/clients.ts:47`) e redes sociais (`{ instagram: '@…' }`, :65), para "já é cliente"                                                                                                                                                                                                                                                                                                                                            |
| `prospects`                                                                         | develop                                                                   | `enrichment.instagram` (fonte "site da empresa"), entrada da parte 3                                                                                                                                                                                                                                                                                                                                                                                |

### 2.2 Novas

**`ig_paste_batches`** — uma linha por colagem confirmada (parte 2). **O texto colado nunca é gravado**: ele é lido na memória da requisição e descartado.

| Coluna                                                                                           | Tipo                               | Regra                                                           |
| ------------------------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------- |
| `tenant_id`, `id`                                                                                | uuid                               | padrão                                                          |
| `created_by`                                                                                     | uuid → employees, not null         | a vendedora                                                     |
| `post_url`                                                                                       | text not null                      | CHECK começa com `https://www.instagram.com/`; sem query string |
| `post_owner_username`                                                                            | text                               | @ do concorrente ou da marca (empresa), minúsculo, sem arroba   |
| `chars`, `lines_total`, `comments_found`, `lines_ignored`, `lines_unrecognized`, `already_known` | integer not null                   | contagens da leitura (§4)                                       |
| `format_detected`                                                                                | text                               | `web_computador`, `web_celular`, `manual`, `misto`              |
| `created_at`                                                                                     | timestamptz not null default now() |                                                                 |

Índices: `(tenant_id, created_by, created_at)` (limite por dia, §4.5). Retenção: a linha fica (só contagens e o link público de um post de empresa); os prospects ligados seguem §8.4.

**`instagram_business_snapshots`** — o que a Business Discovery devolveu sobre a conta comercial de uma **empresa** (parte 3).

| Coluna                                  | Tipo                                              | Regra                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant_id`, `id`                       | uuid                                              | **unique** `(tenant_id, username)`                                                                                                         |
| `username`                              | text not null                                     | @ normalizado (`normalizeInstagram`, `shared/lead-fields.ts`)                                                                              |
| `status`                                | text not null                                     | CHECK em `encontrada`, `nao_comercial` (conta pessoal, privada, com restrição de idade ou inexistente: a Meta não distingue, §6.5), `erro` |
| `followers_count`, `media_count`        | integer                                           | nulos se a Meta não mandou                                                                                                                 |
| `recent_media_read`                     | smallint                                          | quantos posts recentes vieram (pedido: 12)                                                                                                 |
| `avg_likes_milli`, `avg_comments_milli` | integer                                           | média × 1000 (inteiro, sem float); nulo se nenhum post trouxe o campo                                                                      |
| `posts_last_30d`                        | smallint                                          | nulo se `timestamp` não veio (§0)                                                                                                          |
| `last_post_at`                          | timestamptz                                       | idem                                                                                                                                       |
| `error_code`                            | integer                                           | código da Graph quando `status = 'erro'`                                                                                                   |
| `source`                                | text not null default `'meta_business_discovery'` |                                                                                                                                            |
| `api_version`                           | text not null                                     | `v23.0`, a mesma de `worker/lib/instagram-check.ts`                                                                                        |
| `fetched_at`                            | timestamptz not null                              | data da leitura; a tela mostra "Meta, lido em DD/MM"                                                                                       |

**Não se guarda**: nome, bio, site, foto, legendas, ids de mídia, nem o `place_id` (a ligação com o Google é feita ao vivo, §1.3). A bio pode ter telefone: ela nem é pedida (§6.1), então não há telefone de bio para copiar. Retenção: cache de 7 dias para a nota; a linha é apagada 30 dias depois de `fetched_at` (§8.4).

### 2.3 Origem de cada dado

| Dado                                                        | Fonte                                                                                          | Data guardada                                   | Onde                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| @ e trecho do comentário em post de concorrente             | texto colado pela vendedora (cópia humana do Instagram)                                        | data aproximada do comentário + data da colagem | `prospect_evidence` (`recorded_by`, `created_at`, `occurred_at`, `occurred_at_precision`) |
| link do post do concorrente                                 | digitado pela vendedora                                                                        | da colagem                                      | `ig_paste_batches.post_url`, `prospect_evidence.url`                                      |
| @, IGSID e trecho do comentário em post ou anúncio da Wings | webhook `comments` da Meta                                                                     | `occurred_at` do evento                         | `prospect_evidence`, `ig_people` (spec PA)                                                |
| id do anúncio                                               | webhook (`media.ad_id`)                                                                        | do evento                                       | `prospect_evidence.ad_id`                                                                 |
| telefone e e-mail do lead                                   | o que a pessoa escreveu no Direct (parte 1) ou o que a vendedora digitou da conversa (parte 2) | da criação do lead                              | `leads` (`legal_basis`, `consent_source`)                                                 |
| Instagram da empresa                                        | site da própria empresa (`enrichment`) ou site no Google (ao vivo, não guardado)               | do enriquecimento                               | `prospects.enrichment`                                                                    |
| seguidores, posts, curtidas e comentários médios da empresa | Business Discovery                                                                             | `fetched_at`                                    | `instagram_business_snapshots`                                                            |
| sinal, confiança, frase                                     | classificador (§3)                                                                             | da classificação                                | `prospect_classifications` (modelo, `PROMPT_VERSION`)                                     |

### 2.4 Duplicidade: mesma pessoa ou empresa

Chaves, todas normalizadas pelas funções que já existem (`normalizeContactKey` em `shared/contact-opt-out.ts`): **@** (minúsculo, sem arroba), **telefone** (`normalizeBrazilianPhone`), **e-mail** (minúsculo), **CNPJ** (só dígitos). Mesma chave = mesma pessoa ou empresa.

| Encontrou                | Onde procura                                                                                                   | O que acontece                                                                                                                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "não contatar"           | `contactBlock(db, 'instagram', { instagramUser })`                                                             | não vira prospect; conta em "não contatar" na prévia; nada é gravado sobre a pessoa                                                                                                                                                                                                            |
| já é **cliente**         | `clients` (redes sociais com o @; CNPJ)                                                                        | não vira prospect; conta em "já é cliente"; nada é gravado                                                                                                                                                                                                                                     |
| já é **lead**            | `leads.instagram`, `ig_people.lead_id` (parte 1), telefone ou e-mail (só quando a pessoa os escreveu, parte 1) | não vira prospect. Parte 1: a evidência entra no lead e o dono é avisado. Parte 2: a prévia mostra "já é lead de X"; a vendedora pode **anexar o comentário ao lead** (evento `prospect.instagram_comment_seen` na linha do tempo, só se ela tiver acesso ao lead, como em "Criar negociação") |
| já é **prospect aberto** | `prospect_opportunities` aberta com o mesmo @                                                                  | não cria outro; a nova evidência é ligada à oportunidade existente e o dono atual continua; a prévia mostra "já está na lista de Y"                                                                                                                                                            |
| o mesmo comentário       | `prospect_evidence` unique `(tenant_id, source, external_id)`                                                  | descartado em silêncio (colagem repetida)                                                                                                                                                                                                                                                      |

O @ é rótulo: pode ter mudado de dono. Por isso, na parte 1 a chave forte é o IGSID (spec PA, §2.10), e o "já é lead" pelo @ na parte 2 é mostrado para a vendedora decidir, nunca junta sozinho.

### 2.5 Configuração (`prospect_ai_settings.settings.instagram`, Zod com faixas)

| Chave                                                              | Padrão (proposta) | Faixa                                                                    |
| ------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------ |
| `paste.maxChars`, `paste.maxComments`, `paste.perSellerPerDay`     | 50.000 · 300 · 10 | 1.000–100.000 · 10–500 · 1–50                                            |
| `thresholds.listar`, `thresholds.revisar`                          | 70 · 40           | 50–95 · 0–69                                                             |
| `discovery.cacheDias`, `discovery.porDia`, `discovery.recentPosts` | 7 · 500 · 12      | 1–30 · 0–2.000 · 3–25                                                    |
| `weights.instagram.*`                                              | §6.3              | 0–10 cada                                                                |
| `privateReply.modo`                                                | `clique`          | `desligado`, `clique`, `automatico` (`automatico` só Admin Master)       |
| `privateReply.confiancaAutomatica`                                 | 85                | 70–100                                                                   |
| `retention.instagramSemLeadDias`                                   | 30                | 7–90                                                                     |
| `messages.primeiraAbordagemDirect`, `messages.respostaPrivada`     | §8.2, §5.4        | texto não vazio, até 1.000 caracteres; troca auditada com antes e depois |

### 2.6 Origens novas do lead (só Zod, `LEAD_SOURCES`)

Além das quatro da spec PA (`instagram_comment`, `instagram_dm`, `instagram_ad`, `competitor_radar`): **`instagram_colagem`**, rótulo "Instagram (comentário em concorrente)". Muda junto com os mesmos `Record<LeadSource, …>` que a spec PA lista (anexo 1, §2.12).

### 2.7 Sem dado pessoal no `dw`

O painel por fonte (spec PA, anexo 5) recebe só contagens por dia × fonte × vendedor (id) × sinal × estado: colagens, comentários lidos, ignorados, prospects, abordados, leads, "não contatar", custo da IA. Nenhum @, trecho, link de post ou IGSID entra no `dw`. Teste: o PR que fizer a carga confere que nenhuma coluna do `dw` tem esses nomes.

---

## 3. Classificação de intenção pela IA

### 3.1 Categorias (sinais de compra)

O classificador da spec PA (anexo 2) já devolve **serviço** (categoria) e **intenção**. O pedido do Eric são seis **sinais**; o classificador ganha o campo `sinal`, e a intenção da spec PA continua (é ela que a nota de prioridade usa).

| Sinal          | Quando                                                         | Exemplo inventado                         | Intenção da spec PA                               |
| -------------- | -------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| `quer_comprar` | quer contratar, pede contato, proposta, reunião ou diagnóstico | "quero franquear minha marca, como faço?" | `interesse_declarado`                             |
| `pediu_preco`  | pergunta preço, valor, investimento, taxa                      | "quanto custa?"                           | `interesse_declarado`                             |
| `duvida`       | pergunta como funciona, sem pedir serviço                      | "franquia funciona pra serviço também?"   | `conteudo_educativo` ou `informacao_insuficiente` |
| `elogio`       | elogio, emoji, marcação de amigo                               | "top! 👏"                                 | `comentario_casual`                               |
| `reclamacao`   | reclama de empresa, produto ou atendimento                     | "até hoje ninguém me respondeu"           | `outro_assunto`                                   |
| `spam`         | fornecedor vendendo algo, vaga, sorteio, golpe, link solto     | "ganhe seguidores, chama no direct"       | `outro_assunto`                                   |

Regras sem IA (spec PA, anexo 2, §4.2, sem mudança): vazio, só emoji ou até 2 caracteres → `elogio`; só marcação → `elogio`; elogio curto da lista fixa → `elogio`; e duas novas, só para o **sinal**: texto com "quanto custa", "qual o valor", "qual o preço" ou "qual o investimento" → `pediu_preco` com confiança 75 (o serviço ainda vai à IA, se ligada); texto só com link → `spam` com confiança 80. Ironia é `elogio` com confiança baixa, nunca compra (regra 4 do prompt da spec PA).

### 3.2 Limiar e revisão humana

| Confiança                                | Parte 2                               | Parte 1                                                                                      |
| ---------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| ≥ 85 e sinal de compra                   | lista "Quer comprar"                  | oportunidade `nova`; resposta privada pelo clique, ou sozinha só no modo `automatico` (§5.2) |
| 70–84 e sinal de compra                  | lista "Quer comprar"                  | oportunidade `nova`; resposta privada **só pelo clique**                                     |
| 40–69, ou `duvida`, ou sem classificação | lista "Revisar"                       | oportunidade `em_revisao`, sem resposta automática                                           |
| < 40, ou `elogio`, `reclamacao`, `spam`  | "Outros" (só contagem; dá para mover) | nada é criado                                                                                |

Os limiares 70 e 40 são propostas (70 é o `thresholds.confiancaMinima` da spec PA); 85 para o envio sozinho é proposta nossa. Revisão humana sempre: na parte 2 toda abordagem é humana; na parte 1 nada sai sem clique até o Eric ligar o modo automático; serviço de revisão obrigatória (sucessão, reestruturação, spec PA §4.4) nunca dispara envio.

### 3.3 Entrada e defesa

Iguais à spec PA (anexo 2, §4.3 e §4.9): ao provedor vai **só o texto** do comentário, sem @, link do post ou nome do concorrente; telefone, e-mail, @ e link trocados por `[número]`, `[e-mail]`, `[@]` e `[link]`; corte em 1.000 caracteres; o texto vai como dado (`JSON.stringify`); saída por ferramenta forçada e Zod; a frase que justifica tem de existir no texto; nenhuma ação sai do resultado da IA além de pôr o item numa lista.

### 3.4 Modelo usado hoje e custo por comentário

- **Modelo de hoje:** `anthropic/claude-haiku-4.5` pelo OpenRouter, sem coleta de dados (`api/modules/prospecting/service.ts:192`; `docs/crm/prospeccao.md`, "Sugestão de abordagem"). A spec PA mantém esse padrão (`PROSPECT_AI_CLASSIFIER_MODEL`) e põe o Haiku 5.5 só em modo sombra.
- **Preço no código:** US$ 1 por milhão de tokens de entrada e US$ 5 por milhão de saída (`AGENT_MODEL_PRICING`, `shared/ads/agent.ts:67`). Preço do Haiku 5.5: **—** (não está no código; a spec PA manda conferir na página do OpenRouter no dia do PR).
- **Custo por comentário — estimativa, não medição.** Premissas nossas: prompt de sistema de 1.000 tokens, comentário de 60 tokens já com o envelope, 60 tokens de saída por comentário.
  - um comentário por chamada (parte 1): 1.060 × 1 + 60 × 5 = 1.360 micro-dólares ≈ **US$ 0,0014**;
  - lote de 20 por chamada (parte 2, §3.5): (1.000 + 20 × 60) × 1 + 20 × 60 × 5 = 8.200 micro-dólares por lote ≈ **US$ 0,0004 por comentário**;
  - a reserva antes da chamada da spec PA é de 2.500 micro-dólares (1.500 de entrada e 200 de saída); o custo gravado é o que o provedor informar (`usage.costUsd`). O número real sai do piloto, em `prospect_classifier_runs`.
  - Comentário resolvido pelas regras (emoji, elogio curto, marcação) custa zero. Em reais: **—** (o sistema não tem cotação do dólar para isso).
- **Teto:** o `PROSPECT_AI_DAILY_USD` da spec PA (padrão US$ 1 por dia), com reserva sob trava. Na prévia, a tela mostra o custo estimado da colagem; passou do teto, os que faltam vão para "Revisar" com "Sem classificação automática: teto de IA do dia".

### 3.5 Lote (parte 2)

A colagem pode ter 300 comentários; um por chamada repetiria o prompt 300 vezes. A parte 2 manda **até 20 comentários por chamada**: a ferramenta devolve uma lista `{ i, sinal, categoria, intencao, confianca, frase }`, e o Zod confere cada item (índice existe, frase está no texto daquele item). Item inválido vai para "Revisar" sem derrubar os outros. Cache por comentário, como na spec PA (§4.7). Método gravado: `ia_lote`. O modo sombra também roda em lote.

---

## 4. Parte 2: como ler o texto colado

### 4.1 Os formatos

Os três exemplos abaixo foram **inventados** (nenhum @ é de pessoa real) e mostram o formato que esperamos de cada jeito de copiar. **Não verificado:** nenhuma colagem real foi lida; o primeiro PR da Fase A pede ao Eric 5 colagens reais de teste (de posts da própria Wings, sem guardar) para conferir, e os testes usam só os exemplos inventados.

**Exemplo 1 — Instagram no navegador do computador** (selecionar com o mouse da legenda até o fim dos comentários). Um item por linha; o @ numa linha, o texto na seguinte; tempo, curtidas e "Responder" em linhas próprias.

```text
marca.concorrente.exemplo
Verificado
Quer ter a sua própria rede? Comente QUERO 👇
2 sem
usuario.teste01
quanto custa pra abrir uma unidade?
2 sem
3 curtidas
Responder
Ver respostas (1)
marca.concorrente.exemplo
Autor
@usuario.teste01 te chamamos no direct!
2 sem
Responder
loja_ficticia_02
👏👏👏
1 sem
Responder
Ver tradução
Carregar mais comentários
```

Resultado esperado: 2 comentários (`usuario.teste01`, `pediu_preco`; `loja_ficticia_02`, `elogio`); a legenda e a resposta do dono do post ignoradas; 9 linhas de interface ignoradas.

**Exemplo 2 — Instagram no navegador do celular** (selecionar e copiar um trecho). O @ e o texto vêm na mesma linha, e o tempo e "Responder" no fim dela.

```text
usuario.teste03 Tenho 2 lojas e quero franquear, como funciona? 5 d Responder
usuario_teste04 top demais 4 d 1 curtida Responder
Ver todas as 12 respostas
usuario.teste05 vcs atendem fora de SP? 3 d Responder
```

Resultado esperado: 3 comentários (`quer_comprar`, `elogio`, `duvida`); 1 linha ignorada.

**Exemplo 3 — app do Instagram (manual).** O app não deixa selecionar vários comentários de uma vez; a vendedora copia o texto de cada um (tocar e segurar → Copiar, quando o app oferecer) e escreve o @ que vê na tela, um por linha, como `@usuario: texto` ou `@usuario - texto`. A tela mostra esse formato como dica.

```text
@usuario.teste06: qual o investimento pra formatar minha marca?
@usuario.teste07 - sigo vocês faz tempo, parabéns
@usuario.teste08 quero saber mais, me chama
```

Resultado esperado: 3 comentários (`pediu_preco`, `elogio`, `quer_comprar`).

### 4.2 Como a leitura funciona

Função pura `parseInstagramPaste(text, { postOwner?, wingsUsername })` em `shared/instagram-paste.ts`, sem rede e sem IA, testada com os três exemplos e os casos de borda. Passos:

1. Normaliza quebras de linha, tira espaços das pontas, junta linhas em branco repetidas. Recusa texto acima de `paste.maxChars` antes de qualquer outra coisa (§4.5).
2. **Linhas de interface** (lista fixa, em português e inglês, comparada sem acento e sem maiúscula), que são ignoradas e contadas por tipo: tempo (`^\d+\s?(s|min|h|d|sem|a|w|y)$` e "há N dias"), "N curtida(s)" / "N likes", "Responder" / "Reply", "Ver tradução" / "See translation", "Ver respostas (N)", "Ver todas as N respostas", "Ocultar respostas", "Carregar mais comentários", "Adicione um comentário…", "Publicar", rótulos ("Verificado", "Autor", "Criador", "Fixado", "Editado", "Curtido pelo autor", "Seguir", "Patrocinado", "•").
3. **Formato manual** primeiro: linha que começa com `@usuario` seguido de `:`, `-` ou espaço e texto → um comentário.
4. **Formato em linha** (exemplo 2): linha que começa com um @ válido e tem texto depois; o tempo e as palavras de interface no **fim** da linha são cortados.
5. **Formato em blocos** (exemplo 1): as linhas de interface "Responder" e o tempo fecham um bloco; dentro do bloco, a primeira linha restante tem de ser um @ válido (1 a 30 letras, números, ponto ou sublinhado, a regra de `normalizeInstagram`) e o resto é o texto. Um texto de uma palavra só ("valor") não vira @ porque vem **depois** do @ no mesmo bloco.
6. **Descartes:** o bloco do dono do post (pelo `postOwner` informado, pelo rótulo "Autor" ou "Criador" logo depois do @, ou pelo primeiro bloco quando ele não tem "Responder", que é a legenda); comentários da própria Wings (`wingsUsername`); texto vazio depois de cortar a interface.
7. **Não reconhecidas:** o que sobrar e não encaixar em nenhum formato. A prévia mostra a contagem e as 20 primeiras, para a vendedora corrigir e colar de novo; nada delas é gravado.
8. Comentários repetidos na mesma colagem (mesmo @ e mesmo texto) contam uma vez.

### 4.3 Data do comentário

"2 sem", "5 d", "3 h" e "há 2 dias" viram `occurred_at = hora da colagem − intervalo`, com `occurred_at_precision = 'aproximada'` (o Instagram arredonda). Data escrita ("12 de outubro", "12/10/2026") vira a data com o mesmo selo. Sem nada: a hora da colagem, `aproximada`. A tela escreve "há cerca de 2 semanas".

### 4.4 O que fazer com dados no texto

Telefone, e-mail e link que aparecerem no comentário são **mascarados** no trecho gravado (`[número]`, `[e-mail]`, `[link]`) e **nunca** viram campo do prospect ou do lead. Se a pessoa quiser contato, a vendedora pede pelo Direct e digita o que ela responder (§1.2, passo 5). Isso cumpre "não copiar telefone de forma automática" e "não mandar WhatsApp a quem não deu permissão".

### 4.5 Limites por colagem

| Limite                                     | Padrão (proposta)      | Ao passar                                                                                              |
| ------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| tamanho do texto                           | 50.000 caracteres      | 413 `colagem_grande` — "Cole no máximo 50.000 caracteres por vez."                                     |
| comentários reconhecidos                   | 300                    | 422 `colagem_muitos_comentarios` — "Esta colagem tem N comentários; o limite é 300. Divida em partes." |
| colagens por vendedora por dia (São Paulo) | 10                     | 429 `colagem_limite_dia`                                                                               |
| IA                                         | teto diário da spec PA | os que faltam vão para "Revisar"                                                                       |

São limites nossos, sem fonte externa: seguram o custo da IA e o volume de abordagens à mão. O Eric pode mudar em Ajustes (§2.5).

---

## 5. Parte 1: comentários da Wings, resposta privada e anúncios

### 5.1 Webhook de comentários

- Rota pública `POST /integrations/instagram/webhook` (spec PA, anexo 3), assinatura `X-Hub-Signature-256` conferida com a chave secreta do app antes de tudo, evento gravado em `ig_webhook_events` e resposta 200 na hora; processamento no laço de 60 s.
- Campos assinados: `comments`, `messages` e, da spec PA, `mentions` e `messaging_referral`. **Não** assinar `live_comments`: a resposta privada em Live só vale durante a transmissão (§0), e o laço de 60 s não garante isso.
- Leitura tolerante (Zod) dos campos de §0: `comment_id`, `text`, `from.id`, `from.username`, `parent_id`, `media.id`, `media.media_product_type`, `media.ad_id`, `media.ad_title`, `media.original_media_id`. A spec PA fala em "id do comentário" sem dar o nome do campo; o exemplo oficial do login unificado e do login pelo Facebook usa `comment_id`, e o do login pelo Instagram usa `id`. O Zod aceita os dois. **Não verificado ao vivo** até o primeiro evento de teste.
- Requisitos da Meta (§0): app em modo Live, acesso avançado para `comments`, conta @ da Wings pública.

### 5.2 Quem dispara: clique primeiro, automático depois

| Modo (`privateReply.modo`)                 | O que acontece com um comentário de compra                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `desligado` (padrão até a Fase C ir ao ar) | oportunidade criada; nenhuma resposta                                                                                                        |
| `clique` (padrão do piloto)                | o dono da oportunidade, ou a gerência, clica "Enviar resposta privada"; a tela mostra o texto fixo e o prazo ("até DD/MM HH:MM")             |
| `automatico`                               | sai sozinha quando sinal de compra e confiança ≥ `privateReply.confiancaAutomatica` (85), além dos portões; abaixo disso, continua no clique |

Só o Admin Master muda para `automatico`, e a proposta é ligar só depois de 2 semanas de `clique` com acerto ≥ 90% no "quer comprar / pediu preço" revisado (o critério da spec PA, anexo 2, §4.6). A palavra-chave da spec PA (FRANQUIA e a decisão de UNIDADE, t025) continua disparando como lá.

### 5.3 Uma mensagem só, em até 7 dias

Os portões e o envio são os da spec PA, §3.1, passos 6 e 7, sem mudança: chave `INSTAGRAM_AUTO_REPLY_ENABLED` e fonte ligadas; comentário com menos de 7 dias, com 1 hora de margem; `contactBlock` canal `instagram`; uma resposta por pessoa a cada 7 dias (cuidado nosso, não regra da Meta); até 600 por hora (proposta da spec PA, abaixo das 750 por hora da Meta); unique `(tenant_id, comment_id)` em `ig_private_replies` antes da chamada; uma chamada `POST /<IG_ID>/messages`; tempo esgotado ou 5xx = `unknown`, **nunca reenviado**. O texto é fixo, nunca escrito pela IA.

### 5.4 Texto da primeira mensagem (proposta para o Eric aprovar)

Até 1.000 caracteres. `{link_politica}` é trocado pela URL da política (§8.2). Depois do Jurídico (t066, t067).

> Oi! Aqui é a Wings Company, consultoria de franquias e gestão. Vimos o seu comentário no nosso post e queremos te responder direitinho.
> Qual o melhor jeito de um consultor falar com você: por aqui, por telefone, por WhatsApp ou por e-mail? Se for telefone, WhatsApp ou e-mail, pode mandar o contato nesta conversa.
> Usamos só o que você enviar aqui para responder ao seu pedido. Para não receber mais mensagens, responda PARAR. Privacidade: {link_politica}

Variante para comentário em anúncio: troca "no nosso post" por "no nosso anúncio".

### 5.5 Se a pessoa responder

- A resposta chega pelo webhook `messages` e segue a spec PA, §3.2: abre a janela de 24 h, "PARAR" (e as outras palavras de `isOptOut`) grava o "não me contate" e fecha as oportunidades dela, o resto é classificado.
- **O sistema não manda mais nada sozinho.** O dono da oportunidade continua a conversa no Instagram (app ou Meta Business Suite), dentro de 24 h da última mensagem dela (§0). O prazo da oportunidade passa a `min(prazo, última mensagem + 24 h)` e a fila mostra a contagem regressiva.
- Telefone ou e-mail que **ela escreveu** entram no lead (`fields` do `upsertLead`, spec PA §3.6). **WhatsApp:** só vira `consent` se a vendedora marcar "A pessoa pediu contato por WhatsApp" depois de ler a conversa; a máquina não deduz consentimento. Sem isso, a trava `whatsappOptInMissing` bloqueia o WhatsApp do lead, como na busca do Google.
- Ela não respondeu: nada mais sai; a oportunidade vence (`prazo_vencido`) e é apagada em 30 dias sem lead (§8.4).

### 5.6 Comentários de anúncios

- O mesmo webhook `comments` entrega comentário em anúncio com `media.ad_id` (§0). A evidência vira `instagram_ad_comment` e o lead nasce `instagram_ad` com `attribution = { adPlatform: 'meta', adExternalId }` (spec PA, §3.3). Campanha e conjunto vêm de `ad_ads`, quando o anúncio já foi lido.
- Anúncio dinâmico não traz `ad_id` (§0): o comentário entra como de post, sem atribuição.
- Post impulsionado pode gerar dois avisos do mesmo comentário: a unique de `ig_webhook_events` descarta o segundo.
- A resposta privada vale para "ad post" (§0), com a mesma regra de 7 dias e uma mensagem. Nada aqui cria, liga ou muda anúncio: só lê o comentário.
- Rede de segurança (não no MVP): `GET /<IG_MEDIA_ID>/comments` (50 por chamada) só se o webhook ficar fora; a Meta recomenda webhook para não bater no limite.

---

## 6. Parte 3: Business Discovery na nota de 0 a 100

### 6.1 Chamada

```text
GET /v23.0/{INSTAGRAM_DISCOVERY_ACCOUNT_ID}?fields=business_discovery.username(<@>){username,followers_count,media_count,media.limit(12){like_count,comments_count,timestamp}}
```

Token no cabeçalho, nunca na URL ou no log (como `worker/lib/instagram-check.ts:65-75`). **Não** pede `name`, `biography`, `website`, `profile_picture_url`, `caption`, `media_url` nem `permalink`: a nota não precisa deles. A conferência de Instagram do lead do site (`docs/leads/instagram.md`) continua com a chamada dela; o cliente HTTP e o mapa de erros (`instagram-check.ts:96-112`) são reaproveitados, com o campo `media` a mais.

### 6.2 Campos que entram na nota

| Medida      | Como sai                                                       | Sem dado quando                                                                                                                                         |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| seguidores  | `followers_count`                                              | não veio                                                                                                                                                |
| posts       | `media_count`                                                  | não veio                                                                                                                                                |
| frequência  | posts com `timestamp` nos últimos 30 dias, entre os 12 lidos   | `timestamp` não veio (§0)                                                                                                                               |
| engajamento | média de (`like_count` + `comments_count`) dos 12 ÷ seguidores | sem seguidores; ou nenhum post trouxe `like_count` (a pessoa pode esconder curtidas: a documentação não diz como a API responde; tratado como sem dado) |
| conversa    | média de `comments_count` dos 12                               | nenhum post trouxe o campo                                                                                                                              |

### 6.3 Nota de 0 a 100 e pesos propostos

A nota ICP de hoje é uma soma de pontos (`icpScore`, `shared/prospecting.ts:276`; pesos de `ICP_WEIGHT_KEYS`, :220, máximo de 9 pontos com os padrões). Proposta:

`nota = round(100 × pontos obtidos ÷ pontos possíveis)`

- **Pontos possíveis** = soma dos pesos do Google (como hoje) + soma dos pesos do Instagram **que têm dado**. Critério do Instagram sem dado sai da conta dos dois lados: nunca vale zero (mesma regra da spec PA, §3.7). Empresa sem Instagram conhecido fica só com a parte do Google, também de 0 a 100.
- A parte do Google não muda de regra (nota, avaliações, site, Instagram achado no site, várias unidades).
- Pesos novos em Ajustes, no mesmo formato (inteiro de 0 a 10), faixas exclusivas como as de nota e avaliações:

| Chave                              | Critério                             | Peso proposto |
| ---------------------------------- | ------------------------------------ | ------------- |
| `igFollowers10k` / `igFollowers1k` | seguidores ≥ 10.000 / ≥ 1.000        | 2 / 1         |
| `igActive30d`                      | ao menos 4 posts nos últimos 30 dias | 2             |
| `igPosts100`                       | ≥ 100 posts                          | 1             |
| `igEngagement1pct`                 | engajamento ≥ 1%                     | 2             |
| `igComments5`                      | média ≥ 5 comentários por post       | 1             |

As faixas e os pesos são **propostas sem fonte de mercado**, para calibrar no piloto pela taxa de lead por faixa (painel da spec PA). O detalhe da nota mostra cada critério que contou, os que ficaram fora por falta de dado e a data da leitura.

### 6.4 Limites de chamada

| Limite                                          | Valor                                                                                                                                                                                                    | Fonte                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Instagram Platform (24 h)                       | 4.800 × impressões da conta da Wings nas últimas 24 h                                                                                                                                                    | Meta (§0). O número de impressões da conta: **—** (não lido pelo sistema) |
| Business Discovery, token de app                | 200 × usuários do app por hora                                                                                                                                                                           | Meta (§0)                                                                 |
| Business Discovery, token de usuário do sistema | **—**                                                                                                                                                                                                    | a Meta não divulga                                                        |
| Nosso teto                                      | `discovery.porDia` = 500 por dia (proposta), contado por linha gravada antes da chamada, como a cota do Google (`prospect_calls`)                                                                        | nosso                                                                     |
| Nossa trava                                     | cabeçalhos `X-App-Usage` e `X-Business-Use-Case-Usage` ≥ 80% param as chamadas e a tela mostra "Instagram em espera até HH:MM"; erros 4, 17, 32, 613, 80002 → espera; 10, 190, 200 → "aguardando a Meta" | spec PA, anexo 3                                                          |
| Cache                                           | 7 dias por @: a mesma empresa em buscas seguidas não gasta outra chamada                                                                                                                                 | nosso                                                                     |

A Business Discovery não tem custo em dinheiro na documentação lida; o custo é a cota.

### 6.5 Conta pessoal ou sem perfil comercial

A Business Discovery só devolve conta comercial ou de criador e não devolve conta com restrição de idade (§0). Os códigos de "não é conta comercial" já tratados no código (110, 24, subcódigo 2207013 e 100 "invalid user id", `instagram-check.ts:96-101`) viram `status = 'nao_comercial'`, sem distinguir pessoal, privada, restrita ou inexistente (a Meta não distingue). Na tela: "Instagram: — (a Meta só mostra conta comercial; esta é pessoal, privada ou não existe)". A parte do Instagram sai da nota (não zera), e isso **não** marca a empresa como suspeita. Erro de permissão (10, 190, 200): "—, a Meta recusou a consulta", e a Central de fontes avisa a gerência.

---

## 7. Meta e 8. LGPD

Em [instagram-meta-lgpd.md](instagram-meta-lgpd.md): §7 Meta (qual app, permissões com o nome exato, passo a passo da revisão do app, o que muda no Wings Traffic Agent, roteiro dos vídeos; nada disso é feito agora) e §8 LGPD (base legal a validar, avisos, "não contatar" permanente, expurgo em 30 dias, nada pessoal no `dw`).

---

## 9. Permissões no sistema (RBAC)

Permissões novas (em `shared/rbac/permissions.ts`, com teste de rota em `route-access.test.ts`) somadas às da spec PA (`prospect_ai.review`, `prospect_ai.configure`, `prospect_ai.dashboard`) e às da Prospecção Google (`prospecting.use`, `.configure`, `.quota`, `.export`):

| Permissão                          | O que libera                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `prospecting.instagram_paste`      | colar comentários, ver e trabalhar as próprias listas (own) ou todas (all)       |
| `prospect_ai.instagram_auto_reply` | mudar `privateReply.modo` para `automatico` e trocar o texto da resposta privada |

| Nível               | Configura                                          | Cola (parte 2)             | Aprova / cria lead             | Vê                                                  | Parte 3                              |
| ------------------- | -------------------------------------------------- | -------------------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------ |
| Vendedor Formatação | —                                                  | own                        | só os seus (com `leads.write`) | as suas listas e as oportunidades em que é dono     | vê a nota (`prospecting.use` own)    |
| Gerente Comercial   | `prospect_ai.configure` (limites, pesos, limiares) | all                        | todos; transfere               | tudo, Central de fontes                             | muda pesos (`prospecting.configure`) |
| Diretoria           | —                                                  | all, só leitura (não cola) | não (sem `leads.write`)        | tudo, painel                                        | vê                                   |
| Marketing           | —                                                  | —                          | —                              | só o painel com contagens (`prospect_ai.dashboard`) | —                                    |
| Admin Master        | tudo, inclusive `prospect_ai.instagram_auto_reply` | all                        | todos                          | tudo                                                | tudo                                 |
| Vendedor Expansão   | —                                                  | —                          | —                              | — (403)                                             | —                                    |

Um prospect fora do alcance responde 404, como na Prospecção Google. O vendedor nunca vê o @, o trecho ou o dono de prospect que outra pessoa segura: só a etiqueta "já está na lista de outro vendedor" na prévia. A decisão é sempre da API; a tela só esconde.

---

## 10. Fases, critério de pronto e tarefas para os agentes

Cada tarefa é um PR pequeno, com testes (rede travada, banco descartável), revisão independente e as chaves desligadas. Nenhum PR liga nada sozinho.

### Fase A — parte 2 (não depende da Meta, vem primeiro)

Pré-requisito: PRs C1 (tabelas base) e C3 (classificador) da spec PA mesclados, ou feitos junto, na forma de lá.

| Tarefa | Entrega                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1     | `shared/instagram-paste.ts`: `parseInstagramPaste` (§4.2), datas (§4.3), máscara (§4.4); testes com os 3 exemplos e as bordas (texto de uma palavra, @ inválido, dono do post, Wings, repetidos, 300+1 comentários, 50.000+1 caracteres)                     |
| A2     | Migration: `ig_paste_batches`; `instagram_colagem` em `prospect_evidence.source`; `abordada` em `state`; `buy_signal`, `paste_batch_id`, `occurred_at_precision`; Zod; origem do lead `instagram_colagem`                                                    |
| A3     | Classificador: campo `sinal` (§3.1), regras novas, modo lote de 20 (§3.5), método `ia_lote`; testes com IA falsa, inclusive injeção por item e item inválido no meio do lote                                                                                 |
| A4     | API: `POST /prospect-ai/instagram/pastes/preview` (lê e cruza, não grava, sem IA), `POST /prospect-ai/instagram/pastes` (grava e classifica), listas, "Abordei", "Criar lead", "Não contatar", "Descartar", transferir; limites (§4.5); RBAC (§9); auditoria |
| A5     | Tela: Prospecção → Instagram → Colar comentários e Minhas listas (§1.2), "Copiar mensagem" com o texto de §8.2                                                                                                                                               |
| A6     | Expurgo de 30 dias no agendador (§8.4) e contagens no `dw` (§2.7)                                                                                                                                                                                            |

**Pronto quando** (todos com teste automático):

- colar o exemplo 1 dá 2 comentários, 9 linhas de interface ignoradas e 0 não reconhecidas; o exemplo 2 dá 3 e 1; o exemplo 3 dá 3 e 0;
- nenhuma tabela tem o texto colado (teste procura o texto inteiro no banco depois da colagem);
- telefone e e-mail fictícios num comentário não aparecem em nenhuma coluna, só `[número]` e `[e-mail]` no trecho;
- @ com "não contatar", @ de lead e @ de cliente não viram prospect;
- a mesma colagem duas vezes não duplica nada;
- 301 comentários → 422; 11ª colagem do dia → 429; IA desligada → tudo em "Revisar" com o motivo;
- vendedora não vê lista de outra (404); Diretoria lê e não cola (403); Vendedor Expansão 403;
- relógio + 31 dias → o @ some de todas as tabelas, menos `contact_opt_outs`;
- e, fora da CI: 5 colagens reais conferidas pelo Eric (§4.1) e o Jurídico de acordo (t066) antes de abordar pessoas reais.

### Fase B — parte 3

| Tarefa    | Entrega                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B0 (Eric) | Resolver o erro #10 (§7.1): conferir as permissões do `INSTAGRAM_DISCOVERY_TOKEN` e fazer uma Business Discovery de teste                                                                              |
| B1        | Migration `instagram_business_snapshots`; cliente da Business Discovery com o campo `media` (§6.1), reaproveitando o mapa de erros; teto diário com reserva antes da chamada; cabeçalhos de uso (§6.4) |
| B2        | `shared`: nota de 0 a 100 (§6.3), pesos novos com padrão e Zod; testes da conta (critério sem dado sai dos dois lados)                                                                                 |
| B3        | API `POST /prospecting/instagram/discovery` (até 20 @, cache de 7 dias); Ajustes com os pesos; expurgo de 30 dias                                                                                      |
| B4        | Tela: coluna Instagram, nota 0–100, detalhe com os critérios e "—" com o motivo (§6.5)                                                                                                                 |

**Pronto quando:** com a Graph falsa, uma conta comercial dá os números e a nota certa; conta pessoal (110, 24, 2207013) dá "—" e a nota só do Google; curtidas ausentes tiram só o critério de engajamento; erro 10 dá "a Meta recusou"; o 501º pedido do dia não chama a Meta; a mesma empresa em duas buscas faz uma chamada; nenhuma coluna guarda nome, bio, site ou `place_id`; o token nunca aparece em log; e, no staging, o Eric vê a coluna preenchida para uma empresa real de teste.

### Fase C — parte 1

Pré-requisito: PRs D1 a D5 da spec PA (webhook, laço, cliente Graph, lead pelo Direct, "não me contate" pelo Direct).

| Tarefa    | Entrega                                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1        | O laço da spec PA chama o classificador com `sinal`; regras de §1.4 e §3.2 (o que abre oportunidade, o que não)                                                              |
| C2        | `privateReply.modo` (`desligado`, `clique`, `automatico`), botão "Enviar resposta privada" com prazo, permissão `prospect_ai.instagram_auto_reply`, texto de §5.4 em Ajustes |
| C3        | Leitura de `comment_id` e `id` (§5.1); anúncio, anúncio dinâmico e post impulsionado (§5.6)                                                                                  |
| C4        | Prazo de 24 h na fila depois da resposta da pessoa; "pediu contato por WhatsApp" na criação do lead (§5.5)                                                                   |
| C5 (Eric) | Passos de §7.3 e os vídeos de §7.5                                                                                                                                           |

**Pronto quando:** com a Meta falsa, "quanto custa?" abre oportunidade e "top!" não; no modo `clique` nada sai sem o botão; no `automatico`, confiança 84 não sai e 85 sai uma vez; o segundo clique no mesmo comentário não chama a Meta; comentário de 7 dias e 2 horas é bloqueado; "não contatar" bloqueia; tempo esgotado fica `unknown` e não é reenviado; comentário da própria Wings é ignorado; anúncio grava `ad_id` e o lead nasce `instagram_ad`; a resposta da pessoa com telefone fictício cria o lead sem consentimento de WhatsApp; e, no staging, com as contas de teste, uma testadora recebe exatamente uma mensagem.

---

## 11. Perguntas para o Eric (com a opção segura já adotada no texto)

| #   | Pergunta                                                                                              | Opção adotada até a resposta                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Instagram no app **Wings Traffic Agent** (t024) ou no **Wings CRM Vendas** (recomendação da spec PA)? | Passo a passo escrito para o Traffic Agent, mas com token e variáveis só de Instagram, sem permissão de anúncio (§7.1) |
| 2   | Login pela Página ou login unificado?                                                                 | Permissões dos dois listadas; a Business Discovery com as três da referência (§7.2)                                    |
| 3   | Pessoas físicas na parte 2 (a spec PA deixava só empresas)                                            | Construir, mas abordar pessoas reais só com o OK do Jurídico (t066)                                                    |
| 4   | O texto da resposta privada (§5.4) e o da primeira abordagem manual (§8.2)                            | Rascunhos; nada sai antes do OK do Eric e do Jurídico                                                                  |
| 5   | Resposta privada sozinha ou com clique?                                                               | Clique no piloto; automático só depois de 2 semanas com acerto ≥ 90% e o OK do Eric (§5.2)                             |
| 6   | Limiares 70 / 40 e 85 para o automático                                                               | Os da tabela (§3.2), em Ajustes                                                                                        |
| 7   | Limites da colagem (50.000 caracteres, 300 comentários, 10 por dia)                                   | Os da tabela (§4.5)                                                                                                    |
| 8   | Faixas e pesos do Instagram na nota (§6.3) e o teto de 500 consultas por dia                          | Os propostos, calibrados no piloto                                                                                     |
| 9   | Vendedor Expansão usa a parte 2 (comentários de quem quer comprar uma franquia)?                      | Não: só Formatação e gerência, como a Prospecção Google (§9)                                                           |
| 10  | Reclamação em post de concorrente vira prospect?                                                      | Não entra na lista; fica em "Outros", e a vendedora pode mover (§1.2)                                                  |
| 11  | Apagar em 30 dias quem não virou lead (a spec PA propõe 90)                                           | 30 para as origens do Instagram (§8.4)                                                                                 |
| 12  | De onde vem o erro #10 da t024?                                                                       | Tratado como permissão do token da Business Discovery, a conferir na Fase B (B0)                                       |
