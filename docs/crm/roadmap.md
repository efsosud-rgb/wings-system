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
Platform → Private Replies_, _Webhooks_ e _Overview_. Quem for construir lê as
três de novo antes: a Meta muda essas regras, e a leitura de hoje foi um resumo
da página, não uma cópia dela.

| Requisito                    | O que a documentação diz                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private Replies              | Só uma mensagem pode ser enviada à pessoa que comentou, e **em até 7 dias** depois do comentário, em publicação ou reel. Em Live, só durante a transmissão. Mensagens seguintes só se a pessoa responder, e em até 24 horas da resposta.                                                                                            |
| Como envia                   | `POST /<versão>/<id do Instagram>/messages` com `recipient.comment_id` e `message.text`. Token de usuário do Instagram (Instagram Login) ou token de Página (Facebook Login).                                                                                                                                                       |
| Webhook de comentários       | Campos `comments` (e `live_comments`). Exige **Advanced Access**, o app em modo **Live**, e a conta profissional do Instagram **pública**.                                                                                                                                                                                          |
| Permissões (Instagram Login) | `instagram_business_basic` e **`instagram_business_manage_comments`**: as duas que a página de Private Replies lista. **`instagram_business_manage_messages`** também existe entre as permissões do Instagram Login e entra neste plano para as DMs; a página de Private Replies não a cita (ver "O que a documentação não fecha"). |
| Revisão do app               | O Advanced Access exige que o app passe pela **revisão do app** (App Review) da Meta.                                                                                                                                                                                                                                               |
| Verificação da empresa       | O Advanced Access exige também a **verificação da empresa** (Business Verification).                                                                                                                                                                                                                                                |
| Advanced Access              | Necessário para receber o webhook de comentários e para atender contas que não são do próprio app. O Standard Access, o padrão, basta só para contas profissionais próprias.                                                                                                                                                        |

### O que a documentação não fecha

Antes de construir, confirmar com a Meta ou com um teste real, e marcar "não
verificado" em `docs/integracoes/` até ver a resposta de verdade (regra do
projeto para integrações):

- Se a **primeira** DM do Private Reply precisa de `instagram_business_manage_messages` além de `instagram_business_manage_comments`. A página de Private Replies não cita a de mensagens.
- Se a DM aceita **anexo ou link** para o material, e quais formatos.
- Limites de taxa do envio.
- O **formato real** do payload do webhook `comments` (a página de Webhooks manda ler a referência de cada objeto).
- Se as contas de Instagram das marcas atendidas são do próprio app (Standard Access) ou de terceiros (Advanced Access).

### Perguntas em aberto para o Eric

- Qual comentário dispara: qualquer um, uma palavra-chave por publicação, ou só em publicações marcadas?
- Qual material sai, por marca, e quem aprova o texto da DM.
- Base legal e aviso de privacidade: a pessoa comentou, mas não pediu para ser contatada. Isso precisa passar por `docs/lgpd.md` antes de qualquer envio.
- Dono do lead e funil: vale a regra da marca na Expansão, que vale para canal novo (o lead de uma marca nunca vê a Wings; só o canal da marca).

### Onde isso se encaixa

- É uma porta nova de entrada de lead: ver `docs/leads/intake.md` (origem, base legal, pesquisa) e `docs/leads/formularios.md`.
- Dado pessoal fica só na tabela de leads; log e auditoria citam o lead pelo id.
- Nenhuma DM sai sem pedido: ligar o envio é decisão do Eric, como em todo canal (`AGENTS.md`, seção 3).
