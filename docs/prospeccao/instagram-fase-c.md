# Prospecção Instagram — Fase C construída (parte 1: comentários nos posts e anúncios da Wings)

Construída em 01/11/2026 (tarefa ig04) a partir da [especificação](instagram.md), §1.4, §2, §3.2, §5, §8 e §10 (Fase C). Esta página diz o que existe, onde está e o que ficou diferente da especificação. **Nada liga sozinho:** o webhook, a resposta privada e o modo da resposta estão desligados até o Eric seguir os passos da Meta ([instagram-meta-lgpd.md](instagram-meta-lgpd.md) §7.3) e ligar.

## Como funciona

1. **Webhook** (`POST /integrations/instagram/webhook`): a Meta avisa cada comentário num post ou anúncio da Wings e cada mensagem do Direct. A API confere a assinatura (`X-Hub-Signature-256`, HMAC do corpo bruto com a chave do app), grava o evento em `ig_webhook_events` e responde na hora. Nada é lido da Meta nem vai à IA dentro da requisição.
2. **Laço de 60 s** (`modules/instagram/intake.ts`), para cada comentário:
   - da própria Wings: ignorado;
   - de quem está em "não contatar" (pelo @ ou pelo IGSID) ou é cliente: nada é guardado;
   - de quem já é lead (pelo IGSID ligado ao lead): o comentário mascarado entra na linha do tempo do lead e o dono recebe o aviso;
   - de quem já tem oportunidade aberta: o comentário entra nela;
   - senão, regras fixas e IA (a mesma da Fase A, um comentário por chamada, método `ia`): "quer comprar" ou "pediu preço" com confiança ≥ 70 → oportunidade **Nova**; 40 a 69, "dúvida" ou sem classificação → **Revisar**; elogio, reclamação, spam ou menos de 40 → **nada é criado**. Prazo: 7 dias do comentário.
3. **Resposta privada** (`modules/instagram/private-reply.ts`), conforme `privateReply.modo` em Ajustes:
   - `desligado` (padrão): só a oportunidade, nenhuma resposta;
   - `clique`: a dona da oportunidade ou a gerência clica **"Enviar resposta privada"** (com confirmação) num prospect em "Nova";
   - `automatico`: sai sozinha quando "quer comprar" ou "pediu preço" com confiança ≥ `confiancaAutomatica` (85); abaixo disso continua no clique.
   - Portões, nesta ordem, e o primeiro que falha encerra sem gravar nada e sem chamar a Meta: chave `INSTAGRAM_AUTO_REPLY_ENABLED` com token e conta, modo diferente de `desligado`, link da política em Ajustes, menos de 7 dias do comentário (com 1 hora de margem), "não me contate" (IGSID, @ e lead), uma resposta por pessoa a cada 7 dias, 600 por hora. Os dois limites são contados e a linha gravada sob a mesma trava; a linha é única por comentário, então o segundo clique não chama a Meta.
   - Uma chamada `POST /<IG_ID>/messages` com `recipient.comment_id`. Tempo esgotado, 5xx ou resposta sem `message_id` = `unknown`, **nunca reenviado** ("Envio não confirmado; confira no Instagram"). Só o erro certo de limite da Meta (a mensagem não foi) volta a tentar, dentro dos 7 dias.
   - O texto é o fixo de Ajustes (§5.4, com `{link_politica}` trocado; "no nosso anúncio" num anúncio), nunca escrito pela IA. Guarda-se só o hash do texto enviado.
4. **A pessoa respondeu no Direct** (webhook `messages`):
   - o prazo da oportunidade vira `min(prazo, última mensagem + 24 h)`; vencida, volta a "Revisar" com o prazo novo;
   - "PARAR" (e sair, pare, stop, cancelar, descadastrar) grava o "não me contate" (canal Instagram, pelo IGSID e pelo @) e fecha as oportunidades dela;
   - telefone ou e-mail que **ela escreveu** criam o lead (`instagram_comment`, ou `instagram_ad` com o id do anúncio e, se o anúncio já foi lido, campanha e conjunto), base `pre_contract`, origem `instagram`, funil da categoria, dono da oportunidade ou o rodízio. **Sem consentimento de WhatsApp**: a trava `whatsappOptInMissing` vale para toda origem do Instagram, até a vendedora clicar "A pessoa pediu contato por WhatsApp" depois de ler a conversa;
   - o eco (a Wings respondeu pelo app) marca a primeira resposta humana.
   - O sistema não manda mais nada: a conversa continua no Instagram, dentro de 24 h da última mensagem dela.
5. **Expurgo** (a cada hora, junto com o das Fases A e B): oportunidade sem lead apagada 30 dias depois do comentário, com as evidências; `ig_people` sem lead não vista há 30 dias; o corpo bruto do webhook esvaziado em 30 dias (a chave fica, para a Meta não duplicar). Oportunidade sem resposta depois do prazo vira `prazo_vencido`.

## Onde está

| Peça                                                         | Arquivo                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Modos, texto, portões puros, Zod                             | `packages/shared/src/instagram-intake.ts`                                                   |
| Tabelas (migração `0108_instagram_intake`)                   | `apps/api/src/db/schema/prospect-ai.ts`                                                     |
| Leitura do webhook (Zod tolerante, `comment_id` ou `id`)     | `apps/api/src/modules/instagram/payload.ts`                                                 |
| Rota do webhook                                              | `apps/api/src/modules/instagram/webhook-routes.ts`                                          |
| Laço                                                         | `apps/api/src/modules/instagram/intake.ts`                                                  |
| Resposta privada (portões, trava, uma chamada)               | `apps/api/src/modules/instagram/private-reply.ts`, `graph.ts`                               |
| Lead pelo Direct, aviso ao dono                              | `apps/api/src/modules/instagram/lead.ts`                                                    |
| Fila e ações (as mesmas da Fase A, mais o clique e WhatsApp) | `apps/api/src/modules/prospect-ai/prospects.ts`, `instagram-routes.ts`                      |
| Tela                                                         | `apps/web/src/pages/crm/InstagramWingsComments.tsx`; Ajustes em `InstagramProspectList.tsx` |

## Chaves (todas desligadas por padrão)

| Variável                                                 | O que faz                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `INSTAGRAM_WEBHOOK_ENABLED`                              | `true` com `INSTAGRAM_APP_SECRET` e `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`: recebe e processa. Senão, 503 e nada gravado |
| `INSTAGRAM_AUTO_REPLY_ENABLED`                           | `true` com `INSTAGRAM_MESSAGING_TOKEN` e `INSTAGRAM_ACCOUNT_ID`: a resposta privada pode sair (pelo modo)          |
| `INSTAGRAM_APP_SECRET`, `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | segredo do app escolhido; token de verificação (16+ caracteres)                                                    |
| `INSTAGRAM_MESSAGING_TOKEN`, `INSTAGRAM_ACCOUNT_ID`      | token só de Instagram (sem permissão de anúncio; nunca cai para outro token) e o id da conta da Wings              |
| Ajustes → Instagram → Resposta privada                   | `desligado` (padrão), `clique`, `automatico`; confiança para sair sozinha (85); o texto                            |

`automatico`, baixar a confiança no automático e trocar o texto: só `prospect_ai.instagram_auto_reply` (Admin Master). Desligar ou voltar ao clique: quem tem `prospect_ai.configure`.

## Rotas

| Rota                                                                               | Permissão                         | O quê                                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET`, `POST /integrations/instagram/webhook`                                      | pública (segredo próprio)         | handshake; evento assinado → 200 `{ received, queued }`; 401 assinatura, 400 JSON, 503 desligado |
| `GET /prospect-ai/instagram/prospects?parte=1`                                     | `prospecting.instagram_paste`     | a fila: a vendedora vê as dela, gerência, Diretoria e Admin todas                                |
| `POST /prospect-ai/instagram/prospects/:id/private-reply`                          | + `leads.write`, dona ou gerência | o clique; 409 com o motivo do portão, 429 limite da hora                                         |
| `POST /prospect-ai/instagram/prospects/:id/whatsapp-asked`                         | + `leads.write`, dona ou gerência | "A pessoa pediu contato por WhatsApp" no lead que nasceu do Direct                               |
| `POST /prospect-ai/instagram/prospects/:id/{lead,discard,do-not-contact,transfer}` | + `leads.write`                   | as da Fase A, valendo também para a parte 1 (o lead nasce `instagram_comment` ou `instagram_ad`) |

## O que ficou diferente da especificação (opção mais segura; perguntas em DUVIDAS.md da ig04)

- **Base da spec PA feita junto, só o que a Fase C usa** (D1–D5 não existiam): `ig_webhook_events`, `ig_people`, `ig_private_replies`, `ig_person_id` na oportunidade e a chave `instagram_igsid` na trava única. Sem `prospect_source_health` nem Central de fontes: a espera depois de um limite da Meta fica na linha da resposta (`next_attempt_at`).
- **Modo padrão `desligado`**, não `clique` (§5.2 diz "desligado até a Fase C ir ao ar"; §2.5 dizia `clique`).
- **Recusa não grava linha**: a spec PA gravava `blocked`; aqui o portão que falha só fica na auditoria (`prospect_ai.instagram_private_reply`, com o motivo), e o comentário continua livre para um clique depois (por exemplo, quando o link da política for preenchido). `ig_private_replies` ganhou `trigger` e `requested_by` (quem clicou) no lugar de `keyword` e `message_key`.
- **Palavra-chave (FRANQUIA/UNIDADE) não dispara nada**: depende da decisão t025 e de texto aprovado; só a classificação abre oportunidade.
- **Dono ao chegar: nenhum.** A oportunidade nasce sem dono (só gerência, Diretoria e Admin a veem) e a gerência transfere para a vendedora; o dono fixo ou o rodízio da spec PA (`routing.instagramDonoPadrao`, decisão E4) fica para quando o Eric decidir. O lead que nasce do Direct sem dono vai para o rodízio do funil.
- **O botão só em "Nova"** (sinal de compra com confiança ≥ 70): "Revisar" espera a pessoa mover.
- **"Já é lead" só pelo IGSID** ligado ao lead (o @ pode ter mudado de dono, §2.5): um lead com o mesmo @ digitado não junta sozinho.
- **Lead pelo Direct só com telefone ou e-mail** que a pessoa escreveu e categoria com funil; sem isso a vendedora usa "Criar lead". Direct de quem nunca comentou não é guardado (o fluxo "Direct primeiro" é da spec PA, fora da Fase C).
- **"Criar lead" manual na parte 1** usa a mesma regra de consentimento da Fase A (`consent` se a pessoa pediu WhatsApp, senão `legitimate_interest`, origem `prospeccao`).
- **Permalink do post** lido uma vez por mídia (`GET /<media-id>?fields=permalink`) com o mesmo token; falhou, o link fica vazio (não tenta de novo).
- **Sem `GRANT` para `wings_ro`** nas tabelas novas e nada no `dw`.

## Falta para ligar (fora da CI)

C5 (Eric): os passos de [instagram-meta-lgpd.md](instagram-meta-lgpd.md) §7.3 e os vídeos de §7.5, com a política publicada (t063) e o Jurídico de acordo (t066, t067). **Não verificado ao vivo:** o formato do webhook (`comment_id` ou `id`, `from`, `media.ad_id`) e da resposta da Meta seguem os exemplos oficiais; o primeiro evento de teste confirma.
