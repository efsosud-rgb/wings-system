# Anexo 7 — Checklist da Fase 2 na Meta (o que o Eric faz ou aprova)

Parte da [especificação do Wings Prospect AI](../ESPECIFICACAO.md), seção 10. Começa quando os PRs D1 a D5 estiverem no staging com as chaves desligadas. Nada aqui é feito por agente: são telas da Meta, do Coolify e do Instagram. Fatos da Meta conferidos na documentação oficial em 29/10/2026 (visão geral da Instagram Platform, respostas privadas, campos de webhook e Business Discovery); onde a documentação não disse, está marcado "conferir na tela".

## 10.1 Qual app o código usa hoje

| App | Variáveis no código | O que faz hoje | Situação conhecida |
|---|---|---|---|
| **Wings Traffic Agent** | `META_APP_SECRET` (`apps/api/src/env.ts:519`), `META_LEADGEN_VERIFY_TOKEN` (:520-523), `META_WRITE_TOKEN`, `META_LEADS_ACCESS_TOKEN` (:556) | escreve campanhas e recebe o formulário de leads (`docs/leads/meta-lead-ads.md:51-58`) | portfólio 795770645342879; o passo "passar para Ativo" está escrito (:53), mas nenhum documento confirma que foi feito nem que a empresa desse portfólio é verificada |
| **Wings CRM Vendas** | `WHATSAPP_APP_ID` (:530), `WHATSAPP_APP_SECRET` (:544, comentário :543: "not META_APP_SECRET (another app)"), `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_ES_CONFIG_ID` (:547-554) | WhatsApp Cloud API e cadastro embutido | empresa "Wings Company 01" **verificada**, usuário do sistema "wings-crm" com token permanente (`docs/handoff/opus-crm-2026-09-30.md:34-44`); ainda não é Tech Provider (`docs/whatsapp/conectar-numero.md:87-93`) |
| (desconhecido) | `INSTAGRAM_DISCOVERY_TOKEN` (:607) | conferência do @ do lead pela Business Discovery | o plano diz que esse token tem `instagram_basic` e `instagram_manage_insights`; o repositório não diz de qual app ele é |

Não existe `META_APP_ID` no código.

**Recomendação: usar o "Wings CRM Vendas" para o Instagram.** Motivos: a empresa dele já está verificada (pré-requisito do acesso avançado); ele já tem o produto de login para empresas e um usuário do sistema; e assim o app que conversa com pessoas fica separado do app que mexe em verba de anúncio (um token vazado de um não alcança o outro). **Decisão do Eric.** Antes, conferir na tela: (1) que o app pertence ao mesmo portfólio que tem a Página "Wings Company" e o @wings.companybr; (2) de qual app é o `INSTAGRAM_DISCOVERY_TOKEN`.

## 10.2 Produto Instagram no app

1. developers.facebook.com → app "Wings CRM Vendas" → **Adicionar produto** → **Instagram**.
2. Escolher a configuração **"API setup with Unified login"** (recomendada, 10.3). Se a tela não oferecer, usar **"API com login do Facebook"** (login pela Página).
3. Conferir no Instagram: @wings.companybr é conta profissional (empresa), **pública**, e está ligada à Página Wings Company (o plano diz que já está).

## 10.3 Permissões por configuração e recomendação

| Uso no Prospect AI | Login unificado (recomendado) | Login pela Página (alternativa) |
|---|---|---|
| Receber comentários, menções e responder em privado | `instagram_basic`, `instagram_manage_comments` | `instagram_basic`, `instagram_manage_comments`, `pages_read_engagement`, `pages_show_list`, `pages_manage_metadata` |
| Resposta privada e Direct | `instagram_manage_messages` | `instagram_manage_messages` (o Direct passa pela Messenger Platform) |
| Webhook `messages` e `messaging_referral` | `instagram_manage_messages` | `instagram_basic`, `instagram_manage_messages` + as três `pages_*` |
| Business Discovery (radar) | `instagram_basic` | `instagram_basic`, `pages_read_engagement` |
| Token | usuário do sistema do portfólio | token da Página |
| Exige Página ligada | não | sim |

**Recomendação: login unificado.** É o caminho que a Meta indica para integrações novas; usa token de usuário do sistema, como o WhatsApp já faz (sem token de pessoa que expira); pede menos permissões (nenhuma `pages_*`, menor privilégio); e cobre as três necessidades (comentários, mensagens e Business Discovery) com a mesma rota `POST /{ig-user-id}/messages` em `graph.facebook.com`. **Alternativa:** login pela Página, se o unificado não aparecer para o app; o código é o mesmo, muda só o token e a lista de permissões. **Não usar** o login pelo Instagram (`instagram_business_*`, `graph.instagram.com`): não tem Business Discovery nem busca por hashtag, e por isso o radar não funcionaria (divergência V6 da especificação).

Não pedir: `instagram_manage_insights`, `instagram_content_publish`, `ads_*`, nem a permissão de "atendente humano" (fora do MVP).

## 10.4 Acesso, modo Live e verificação da empresa

| Passo | Onde | Observação |
|---|---|---|
| Modo de desenvolvimento para construir e gravar o vídeo | app → topo da tela | Com acesso padrão, o app só enxerga contas com papel no app (contas da equipe). Clientes reais ficam de fora até a aprovação |
| Papéis de teste | app → Funções do app → Testadores | Daniele, Luana e quem mais for comentar nos testes; cada uma aceita o convite |
| Verificação da empresa | Configurações do negócio → Central de segurança | Exigida para acesso avançado. "Wings Company 01" consta como verificada; conferir que é o portfólio dono do app |
| Revisão do app (acesso avançado) | app → Revisão do app → Permissões e recursos | Uma solicitação por permissão de 10.3, cada uma com descrição em inglês e vídeo (10.8) |
| Modo Live (Ativo) | app → topo da tela | Só depois da aprovação. Exige as URLs de 10.5, ícone e categoria |

## 10.5 URLs exigidas

| URL | Situação hoje | O que fazer |
|---|---|---|
| Política de privacidade | O CRM aponta para `https://wingscompany.com.br/politica-de-privacidade/` (`apps/web/src/components/campaign-builder/LeadFormSection.tsx:48`), mas `docs/ads/fechar-ciclo.md:21` registra que a política "não existe" | Publicar no site a política com o conteúdo do [anexo jurídico §3.5](juridico.md#3-avisos-de-privacidade-textos-propostos--a-validar), revisada pelo advogado. É a mesma URL do `{link_politica}` da resposta automática |
| Exclusão de dados | Não existe rota nem página (`signed_request`, "deauthorize" e "data deletion" não aparecem no código) | Recomendação: **URL de instruções** (a Meta aceita instruções ou callback), uma página no site dizendo como pedir a exclusão (e-mail do encarregado e "responda PARAR no Direct"); a equipe executa pela rota do PR D5. Callback com `signed_request` fica para quando houver login de terceiros no app |
| Termos de serviço | — | Opcional; se o site tiver, informar |

## 10.6 "Permitir acesso a mensagens" no app do Instagram

No celular, na conta @wings.companybr: **Configurações e privacidade → Mensagens e respostas ao story → Ferramentas conectadas → Permitir acesso a mensagens** (ligado). Sem isso, a API não recebe nem envia Direct. Os nomes do menu mudam entre versões do app: conferir na tela.

## 10.7 Webhooks, token e Coolify

1. **Coolify (staging):** gerar e gravar `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` (texto aleatório de 32+ caracteres) e `INSTAGRAM_APP_SECRET` (chave secreta do app, em Configurações → Básico); `INSTAGRAM_ACCOUNT_ID` (id da conta @wings.companybr na Graph). Ainda com `INSTAGRAM_WEBHOOK_ENABLED` e `INSTAGRAM_AUTO_REPLY_ENABLED` desligadas.
2. **Token:** Configurações do negócio → Usuários do sistema → "wings-crm" → atribuir ativos (a conta do Instagram e a Página) → Gerar token do app "Wings CRM Vendas", **sem expiração**, só com as permissões de 10.3 → gravar em `INSTAGRAM_MESSAGING_TOKEN`. Nunca colar o token em chat, e-mail ou documento.
3. Ligar `INSTAGRAM_WEBHOOK_ENABLED` e fazer o deploy do staging (o Eric).
4. **App → Instagram → Webhooks:** URL de retorno `https://staging.wingssystem.online/api/integrations/instagram/webhook` e o token de verificação do passo 1 → "Verificar e salvar" (o CRM responde ao desafio).
5. **Campos a assinar:** `comments`, `messages`, `mentions` e também `messaging_referral` (anúncio que abre o Direct, §3.3 da especificação). Não assinar `live_comments`, `message_reactions` e `messaging_seen`.
6. **Ligar os avisos para a conta:** a inscrição do app na conta (`subscribed_apps` com os mesmos campos). É uma chamada à Graph; quem faz é o Eric pela ferramenta da Meta (Graph API Explorer), ou um agente com autorização explícita no momento. Conferir em seguida na Central de fontes: o Instagram só aparece como "conectada" depois do primeiro evento.
7. Teste em modo de desenvolvimento: uma testadora comenta FRANQUIA num post da Wings → a oportunidade aparece na fila; com `INSTAGRAM_AUTO_REPLY_ENABLED` ainda desligada, a resposta fica "bloqueada: desligado". Ligar a resposta, repetir, conferir que chega uma mensagem só. Responder no Direct → vira lead.

## 10.8 Roteiro do vídeo da revisão, por permissão

Regras gerais: tela do celular gravada (Instagram) + tela do CRM no computador; legendas em inglês; 1 a 3 minutos por vídeo; dados só das contas de teste; mostrar onde o usuário vê e controla o uso. Usar as contas de teste de 10.4. Texto de cada pedido em inglês (rascunho abaixo, para o Eric revisar).

| Permissão | O que o vídeo mostra, em ordem | Texto do pedido (rascunho) |
|---|---|---|
| `instagram_basic` | 1) Login no CRM; 2) Central de fontes mostrando a conta @wings.companybr ligada (nome e id); 3) Radar: cadastrar a conta comercial de exemplo e mostrar a lista de posts públicos (link, data, número de comentários) vinda da Business Discovery | "We read basic data of our own Instagram professional account to connect it to our CRM, and public metadata of business accounts (Business Discovery) so our sales team can see which public posts have more conversation. We do not read comments or personal data of third-party accounts." |
| `instagram_manage_comments` | 1) No celular de teste, comentar "FRANQUIA" num post da Wings; 2) no CRM, a oportunidade aparece na fila com o trecho, o link e a hora; 3) mostrar que um elogio ("top!") não vira oportunidade; 4) mostrar o botão "Não me contate" | "When someone comments a keyword on a post or ad of our own account, we receive the comment via webhook, create an opportunity in our CRM for our sales team, and send one private reply. We only process comments on our own account's media." |
| `instagram_manage_messages` | 1) Continuação: a mensagem privada chega no Direct da conta de teste (mostrar o texto fixo, com o link da política); 2) responder no Direct; 3) no CRM, a pessoa vira lead com dono e prazo de 24 h; 4) responder "PARAR" e mostrar o "não me contate" registrado e que nada mais é enviado | "We send exactly one private reply per comment, within 7 days, with a fixed text approved by our company and a link to our privacy policy. When the person replies, a salesperson continues the conversation within the 24-hour window. People can stop messages by replying STOP." |
| `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata` (só no login pela Página) | Seleção da Página Wings Company ligada à conta; inscrição dos webhooks | "Needed to connect our Instagram account, linked to our Facebook Page, and subscribe to its webhooks." |

Depois de aprovado: passar o app para Live, mudar a URL do webhook para a produção quando a produção receber o módulo (hoje o piloto é no staging, auditoria J16) e manter as chaves ligadas só onde o Eric decidir.

## 10.9 Ordem e responsáveis

| # | Passo | Quem | Depende de |
|---|---|---|---|
| 1 | Advogado valida política, avisos e prazos | Eric + advogado | anexo jurídico |
| 2 | Publicar política e página de exclusão no site | Eric (site) | 1 |
| 3 | Escolher app e modo de login (10.1, 10.3) | Eric | — |
| 4 | Produto Instagram, testadores, "permitir acesso a mensagens" | Eric | 3 |
| 5 | Token, variáveis no Coolify, deploy do staging | Eric | D1–D5 no staging |
| 6 | Webhook e inscrição da conta; testes com as contas da equipe | Eric (com agente, se autorizar) | 5 |
| 7 | Vídeos e pedido de revisão | Eric | 2, 6 |
| 8 | Live e piloto com clientes reais | Eric | aprovação da Meta |
