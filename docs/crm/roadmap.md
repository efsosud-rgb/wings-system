# CRM Vendas — Roadmap: itens registrados, ainda não construídos

Esta lista guarda o que foi decidido registrar e ainda não tem onda, branch nem
documento próprio. **Não é** a tela Administração → Roadmap (`docs/roadmap.md`),
que é o relatório diário de progresso gerado dos commits. Um item sai daqui
quando alguém o constrói e ele ganha o seu próprio documento; este arquivo então
aponta para lá.

Registrar não é autorizar: construir qualquer item pede a ordem do Eric.

## Comentário no Instagram → DM com o material + lead no CRM

**Estado:** registrado em 13/10/2026, aprovado pelo Eric em 12/10. Nada
construído: nenhuma linha de código, nenhuma tabela, nenhuma permissão pedida à
Meta.

**A ideia.** Alguém comenta numa publicação ou reel da marca. O sistema responde
por mensagem direta (DM) com o material combinado, e a pessoa entra no CRM Vendas
como lead, com a origem "Instagram" e o comentário como primeiro toque.

### Requisitos conferidos na documentação da Meta

Conferido em 13/10/2026 nas páginas da Meta para desenvolvedores: _Instagram
Platform → Private Replies_, _Webhooks_ (com _Set up_, _Webhook fields_ e
_Examples_), _Overview_ e _Messaging API_; e _Messenger Platform → Private
Replies_ para o caminho Facebook Login. A página de permissões da Meta foi lida
só nas entradas de `instagram_business_manage_comments` e
`instagram_business_manage_messages`. Quem for construir lê tudo de novo antes: a
Meta muda essas regras.

| Requisito                    | O que a documentação diz                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private Replies              | Só uma mensagem pode ser enviada à pessoa que comentou, e **em até 7 dias** depois do comentário, em publicação ou reel (também em post de anúncio). Em Live, só durante a transmissão. Mensagens seguintes só se a pessoa responder, e em até 24 horas da resposta. A resposta chega na caixa de entrada de quem segue a conta e em Solicitações de quem não segue; a Meta inclui sozinha um link para a publicação comentada. A página não diz se o limite de uma mensagem vale por comentário ou por pessoa. |
| Como envia                   | Nos dois caminhos o corpo leva `recipient.comment_id` e `message.text`. **Instagram Login:** `POST graph.instagram.com/<versão>/<id do Instagram ou me>/messages` com token de usuário do Instagram. **Facebook Login:** `POST graph.facebook.com/<versão>/<id da Página>/messages` com token de Página.                                                                                                                                                                                                        |
| Webhook de comentários       | Campos `comments` (e `live_comments`). Em _Webhooks → Set up_: o app precisa estar em modo **Live**, o **Advanced Access** é exigido para esses dois campos, e a conta profissional do Instagram precisa ser **pública**.                                                                                                                                                                                                                                                                                       |
| Permissões (Instagram Login) | `instagram_business_basic` e **`instagram_business_manage_comments`**: as duas que a página de Private Replies lista. **`instagram_business_manage_messages`** também existe entre as permissões do Instagram Login e entra neste plano para as DMs; a página de Private Replies não a cita (ver "O que a documentação não fecha"). Se a pessoa que conecta tem papel na Página só pelo Business Manager, a página pede também `ads_management` e `ads_read`.                                                   |
| Permissões (Facebook Login)  | A página do Instagram Platform lista `instagram_basic`, `instagram_manage_comments` e `pages_read_engagement`; a da Messenger Platform lista `instagram_manage_comments` e `pages_messaging`. As duas divergem: confirmar.                                                                                                                                                                                                                                                                                      |
| Revisão do app               | O Advanced Access exige que o app passe pela **revisão do app** (App Review) da Meta. Risco: para `instagram_business_manage_comments` a Meta pede um vídeo de tela criando, alterando e apagando um comentário, o que não é o uso receber comentário e mandar DM.                                                                                                                                                                                                                                              |
| Verificação da empresa       | O Advanced Access exige também a **verificação da empresa** (Business Verification).                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Advanced Access              | Exigido pelo webhook de comentários mesmo para contas próprias (_Webhooks → Set up_) e para atender contas de terceiros (_Overview_). O Standard Access, o padrão, serve a contas próprias em geral, mas a documentação não garante que baste para o fluxo comentário → DM: confirmar com um teste.                                                                                                                                                                                                             |
| Limites de taxa              | _Overview → Messaging Rate Limits_: Private Replies, **750 chamadas por hora** por conta profissional (comentários em publicações e reels) e 100 por segundo em Live. Send API: 100 por segundo para texto e link, 10 por segundo para áudio e vídeo.                                                                                                                                                                                                                                                           |

### O que a documentação não fecha

Antes de construir, confirmar com a Meta ou com um teste real, e marcar "não
verificado" em `docs/integracoes/` até ver a resposta de verdade (regra do
projeto para integrações):

- Se a **primeira** DM do Private Reply precisa de `instagram_business_manage_messages` além de `instagram_business_manage_comments`. A página de Private Replies não cita a de mensagens; no caminho Facebook Login a Messenger Platform pede `pages_messaging`. Pedir as duas é o caminho seguro, e a revisão do app pesa isso.
- Se a primeira mensagem aceita **anexo**. No Private Reply só `message.text` está documentado. Numa DM comum a Meta lista link, imagem (png ou jpeg, até 8 MB), PDF (até 25 MB), áudio e vídeo (até 25 MB), com texto de até 1000 bytes. O caminho garantido é texto com link.
- O que acontece acima do limite de taxa: uma publicação que viraliza passa de 750 comentários por hora. O plano precisa de fila, e uma chamada que falhou não se repete às cegas.
- O **formato real** do payload do webhook `comments`. Há exemplos em _Webhooks → Examples_ e em _Comment Moderation_, com formas diferentes para Instagram Login (`value.id`) e Facebook Login (`changes[].value.comment_id`). O envelope só se confirma com um evento de verdade; registrar só a forma (`shapeOf`) quando chegar o primeiro.
- Quais contas de Instagram serão conectadas e se o Wings é dono ou administrador delas. Isso muda o que a revisão pede; o webhook de comentários exige Advanced Access de qualquer forma.
- Se o limite de uma mensagem vale por comentário ou por pessoa.

### Perguntas em aberto para o Eric

- Qual comentário dispara: qualquer um, uma palavra-chave por publicação, ou só em publicações marcadas?
- Qual material sai, por marca, e quem aprova o texto da DM.
- Base legal e aviso de privacidade: a pessoa comentou, mas não pediu para ser contatada. Qual base vale para essa porta é decisão do Jurídico (`docs/leads/intake.md`, "Como um lead entra"); isso se resolve antes de qualquer envio.
- Dono do lead e funil: vale a regra do Eric de 07/10/2026 para Expansão com marca (o lead nunca vê a Wings; só o canal da marca) e vale para canal novo. No código ela é `leadHidesWings`, em `packages/shared/src/meetings.ts`.

### Onde isso se encaixa

- É uma porta nova de entrada de lead: ver `docs/leads/intake.md` (origem, base legal, pesquisa) e `docs/leads/formularios.md`.
- Dado pessoal fica só na tabela de leads; log e auditoria citam o lead pelo id.
- Nenhuma DM sai sem pedido: ligar o envio é decisão do Eric, como em todo canal (`AGENTS.md`, seção 3).
