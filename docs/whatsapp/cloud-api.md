# WhatsApp oficial (Cloud API) no CRM

Versão de 07/10/2026 (branch `feat/whatsapp-oficial`). A conversa do lead pelo WhatsApp oficial da Meta,
dentro do Wings System: receber, responder, modelos, status e arquivos. A ligação pelo WhatsApp (Calling API)
é a etapa seguinte e usa a mesma permissão. O que o Eric faz na Meta e o roteiro da troca do número ficam em
`/root/relatorios/whatsapp-oficial/` (fora do repositório).

## Como funciona

- **Webhook:** `GET/POST /integrations/whatsapp/webhook` (sem sessão). O GET responde o `hub.challenge` só com
  `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. O POST só é aceito com `X-Hub-Signature-256` (HMAC-SHA256 do corpo exato
  com `WHATSAPP_APP_SECRET`, o segredo do app "Wings CRM Vendas" — não o `META_APP_SECRET`, que é de outro
  app). Corpo até 4 MB. O corpo assinado é guardado em `wa_webhook_events` e respondido 200 na hora; a fila
  (`modules/whatsapp/intake.ts`, a cada minuto e logo após cada chegada) faz o resto. Sem as duas variáveis, a
  rota responde 503.
- **Reenvios:** a Meta reenvia por até 7 dias. Cada mensagem tem o id da Meta (`wamid`) único; um reenvio não
  faz nada. O corpo guardado é apagado depois de 90 dias (a linha fica).
- **Mensagem recebida:** vai para a negociação **aberta mais recente** do mesmo telefone (o do lead ou o de um
  contato da negociação), testando o número com e sem o 9º dígito (o `wa_id` da Meta pode vir sem ele). Uma
  mensagem que começa com o código de um link rastreado cria ou junta o lead, como a porta da Z-API. Sem
  negociação, a conversa espera em CRM Vendas → WhatsApp, visível só para quem tem escopo total; quando
  alguém cria a negociação com aquele telefone, as mensagens passam para ela.
- **Janela de 24 h:** abre na última mensagem da pessoa (por telefone, regra da Meta). Dentro dela vai texto
  livre; fora, só modelo aprovado. O servidor confere de novo (409 `window_closed`).
- **Envio:** a linha é gravada antes (`pending`), a Meta é chamada **uma vez**, nunca de novo sozinha. Recusada:
  `failed` com o código e o motivo em português. Sem resposta da Meta (queda, tempo esgotado): fica sem
  confirmação, com o aviso "pode ter ido ou não", e não é reenviada.
- **Status:** enviada → entregue → lida (→ ouvida, para áudio); só avançam. "Falhou" vale só antes da entrega.
  Um status atrasado preenche só a hora.
- **Modelos:** lidos da Meta (`GET /{WABA}/message_templates`) a cada 6 h, ou em "Atualizar lista"; o aviso de
  revisão da Meta (`message_template_status_update`) atualiza a situação. Só os aprovados aparecem.
- **Pedido para parar:** "SAIR", "PARAR", "PARE", "STOP", "CANCELAR" ou "DESCADASTRAR" sozinhos bloqueiam
  modelos para aquele telefone até a pessoa escrever outra coisa.
- **Arquivos recebidos:** não são copiados; `GET /whatsapp/messages/:id/media` busca na Meta na hora (a Meta
  guarda por 30 dias), com a mesma regra de acesso. Imagem, áudio, vídeo e PDF abrem no navegador; qualquer
  outro tipo só baixa, com `Content-Security-Policy: sandbox`, para nada rodar na origem do sistema. O token só
  vai para os servidores da Meta.

## Acesso

Uma permissão, `leads.whatsapp` (ver, enviar e ligar), pela regra única `leadInScope`
(`modules/leads/access.ts`): Admin Master, Diretoria e Gerente comercial em qualquer lead; vendedor só nos
seus. A Diretoria conversa e liga sem editar a negociação. Fora do alcance responde 404.

## Rotas (com sessão)

| Rota                                                            | O quê                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| `GET /leads/:id/whatsapp`                                       | Conversa da negociação, janela, opt-out, `configured` |
| `POST /leads/:id/whatsapp/text`                                 | Texto livre (só dentro das 24 h)                      |
| `POST /leads/:id/whatsapp/template`                             | Modelo aprovado com os campos `{{n}}`                 |
| `GET /whatsapp/conversations[?unanswered=1]`                    | Lista no escopo de quem lê                            |
| `GET /whatsapp/conversations/:id` e `POST …/text`, `…/template` | Conversa sem negociação (escopo total)                |
| `GET /whatsapp/templates[?refresh=1]`                           | Modelos aprovados                                     |
| `GET /whatsapp/messages/:id/media`                              | Arquivo recebido                                      |

A tela da conversa se atualiza a cada 5 s e a lista a cada 15 s, com o cabeçalho `x-wings-passive: 1`: o
servidor responde sem contar como atividade da pessoa, para uma tela aberta não segurar uma sessão ociosa nem
mexer na hora de saída do ponto.

## Dados

Migração 0077: `wa_contacts` (telefone único, `wa_id`, nome do perfil, última mensagem recebida, opt-out),
`wa_conversations` (uma por telefone e negociação; a sem negociação é única por telefone), `wa_messages`,
`wa_webhook_events`, `wa_templates`. Telefone e texto são dados pessoais: sem GRANT ao `wings_ro`, nada disso
em log (o webhook registra só o formato do corpo, `shapeOf`). A auditoria `whatsapp.message_sent` guarda ids,
tipo, nome do modelo e resultado, nunca o texto.

## Variáveis

`WHATSAPP_APP_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_PHONE_NUMBER_ID` (não secretos);
`WHATSAPP_WEBHOOK_VERIFY_TOKEN` (16+ caracteres), `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN` (segredos, só
no Coolify). Sem token e número, a conversa diz que está desligada; sem segredo e token de verificação, o
webhook responde 503. Uma mudança chegada para outro número do mesmo app é ignorada.

## Não verificado ao vivo

Os formatos seguem a referência publicada pela Meta; nenhum corpo real chegou ainda. O primeiro teste é o do
Eric com o número de teste no staging; o log `whatsapp webhook` mostra o formato de cada corpo para conferir.
Versão da Graph API: `v23.0`, num só lugar (`modules/whatsapp/graph.ts`).

## Custos (página de preços da Meta, 30/09/2026)

Desde 01/10/2026 a Meta cobra também as mensagens de atendimento (dentro das 24 h), com 1.000 grátis por
número por mês; sem forma de pagamento, ela para de entregá-las. Brasil: atendimento e utilidade R$ 0,035,
marketing R$ 0,3217.
