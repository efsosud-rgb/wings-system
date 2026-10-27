# WhatsApp oficial (Cloud API) no CRM

Versão de 07/10/2026. A conversa do lead pelo WhatsApp oficial da Meta, dentro do Wings System (receber,
responder, modelos, status e arquivos) e a ligação de voz pelo WhatsApp no navegador (Calling API), com a mesma
permissão. O que o Eric faz na Meta e o roteiro da troca do número ficam em `/root/relatorios/whatsapp-oficial/`
(fora do repositório).

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
  contato da negociação), testando o número com e sem o 9º dígito (o `wa_id` da Meta pode vir sem ele). Quem
  responde: o dono, se a negociação tem dono; senão a Sofia (`sofia.md`). Com a Sofia ligada, a mensagem com o
  código de um link rastreado só conta o clique e diz a marca (ela cria a negociação no fim); desligada, o link
  cria ou junta o lead na hora, como a porta da Z-API. Sem negociação, a conversa é da Sofia ou espera um
  atendente; quando alguém cria a negociação com aquele telefone, as mensagens passam para ela.
- **Janela de 24 h:** abre na última mensagem da pessoa (por telefone, regra da Meta). Dentro dela vai texto
  livre; fora, só modelo aprovado. O servidor confere de novo (409 `window_closed`).
- **Envio:** a linha é gravada antes (`pending`), a Meta é chamada **uma vez**, nunca de novo sozinha. Recusada:
  `failed` com o código e o motivo em português. Sem resposta da Meta (queda, tempo esgotado): fica sem
  confirmação, com o aviso "pode ter ido ou não", e não é reenviada.
- **Status:** enviada → entregue → lida (→ ouvida, para áudio); só avançam. "Falhou" vale só antes da entrega.
  Um status atrasado preenche só a hora.
- **Modelos:** lidos da Meta (`GET /{WABA}/message_templates`) a cada 6 h, ou em "Atualizar lista"; o aviso de
  revisão da Meta (`message_template_status_update`) atualiza a situação. Só os aprovados aparecem, um por nome:
  a versão `_arte` é escolhida no envio. Dentro da janela o modelo vira mensagem comum; fora, vai o modelo com a
  arte da marca no cabeçalho (`arte-modelos.md`).
- **Pedido para parar:** "SAIR", "PARAR", "PARE", "STOP", "CANCELAR" ou "DESCADASTRAR" sozinhos bloqueiam
  modelos para aquele telefone até a pessoa escrever outra coisa.
- **Arquivos recebidos:** não são copiados; `GET /whatsapp/messages/:id/media` busca na Meta na hora (a Meta
  guarda por 30 dias), com a mesma regra de acesso. Imagem, áudio, vídeo e PDF abrem no navegador; qualquer
  outro tipo só baixa, com `Content-Security-Policy: sandbox`, para nada rodar na origem do sistema. O token só
  vai para os servidores da Meta.

## Ligação de voz (Calling API)

- **Áudio no navegador:** WebRTC do próprio navegador (`apps/web/src/lib/whatsapp-call.ts`), sem biblioteca e
  sem servidor STUN/TURN (a Meta é ICE-lite com endereço público). Uma faixa Opus, pacotes de 20 ms; a
  descrição de mídia (SDP) é feita uma vez, com os candidatos, e nunca renegociada.
- **Ligar:** o navegador faz a oferta → `POST /leads/:id/whatsapp/calls` → a API grava a ligação e chama a Meta
  uma vez (`connect`, com o nosso id em `biz_opaque_callback_data`) → a resposta da Meta chega pelo webhook
  `calls` e o navegador que ligou a busca em `GET /whatsapp/calls/:id`. Só com as ligações ligadas no número
  (`GET /{phone}/settings`, lido a cada 5 min) e, na prática, com a permissão da pessoa (sem ela a Meta recusa,
  erro 138006).
- **Receber:** o webhook traz a oferta do celular da pessoa; a ligação toca (aviso por stream, abaixo) para
  quem vê a negociação daquele telefone (sem negociação: só escopo total).
  O primeiro a clicar em Atender leva (`pickup`, os outros recebem "já atendida"); o navegador responde e a API
  manda `accept` direto, sem `pre_accept` (o navegador não segura o áudio; regra do FAQ da Meta). A Meta dá 30 a
  60 s.
- **Aviso por stream (`GET /whatsapp/calls/stream`):** a tela não pergunta mais a cada 3 s. Ela abre uma
  resposta `text/event-stream` (por `fetch`, não `EventSource`: o pedido leva `x-wings-passive` e o status
  fica visível) e a API manda a **resposta inteira** (`{ calling, calls }`, a mesma de
  `GET /whatsapp/calls/ringing`) ao conectar e a cada mudança, nunca um pedaço. Quem decide quem vê qual
  ligação é uma função só, `ringingFor` (`modules/whatsapp/ringing.ts`), usada pela consulta e pelo stream.
  - **Quando manda:** o webhook de ligação, o `pickup`, o `reject` e o `hangup` avisam os streams abertos
    (`call-signal.ts`, dentro do processo da API; todo escritor de `wa_calls` está na API). Além disso, um
    batimento a cada 15 s olha de novo (cobre o toque que acabou sem ninguém escrever nada, e outro
    processo) e escreve `: ping`, que impede o Traefik e qualquer proxy no caminho de fechar uma
    resposta quieta; a tela dá a conexão por morta se ficar 45 s sem receber nada.
  - **Eventos:** `ringing` (a resposta), `session_ended` (a sessão acabou; a tela trata como um 401 e a
    resposta fecha). Comentários (`: ping`) não são evento.
  - **Reserva:** com o stream fora do ar (ou antes da primeira resposta) a tela pergunta
    `GET /whatsapp/calls/ringing` a cada **10 s** (60 s com as ligações desligadas, como antes) e para de
    perguntar assim que chega uma resposta pelo stream. O stream volta sozinho: espera 1 s, 2 s, 4 s… até
    30 s (com variação, para abas não voltarem juntas), 60 s se a API disser que há abas demais, e na hora
    em que o navegador volta a ficar online.
  - **Várias abas:** cada aba abre o seu stream (HTTP/2 no staging, sem o limite de 6 conexões do HTTP/1.1).
    A API aceita até 8 por pessoa e responde 429 `too_many_streams` ao nono.
  - **Permissão e escopo** são os de `leads.whatsapp`, vistos na conexão; mudar o nível da pessoa encerra
    as sessões e, com elas, os streams.
- **Recusar e desligar:** `reject` (tocando) e `terminate`; a ligação fecha na hora aqui e o aviso final da Meta
  traz a duração real.
- **Permissão:** `GET /leads/:id/whatsapp/call-permission` pergunta à Meta (sem permissão, temporária de 7
  dias, permanente) e se dá para pedir ou ligar agora; `POST` manda o pedido interativo da Meta, só dentro das
  24 h (fora delas, por um modelo com o componente de pedido de ligação). A resposta da pessoa chega como
  mensagem e atualiza o contato. A Meta limita a 1 pedido por dia e 2 por semana; 4 ligações sem resposta
  revogam.
- **Registro:** toda ligação terminada com negociação entra no histórico dela uma vez (`lead_activities`,
  "Pelo WhatsApp · ligação feita/recebida", atendida com a duração, ou não atendida/recusada). Uma que falhou
  antes de sair não entra. Avisos que não chegam: a ligação que tocou e ninguém fechou vira "não atendida" em
  3 min; a que ficou aberta, "não completou" em 4 h.
- Webhooks repetidos e fora de ordem (o fim pode vir antes do começo) são aceitos.
- A ligação é uma por navegador, e continua ao trocar de tela (fica num cartão no canto).

## Acesso

Uma permissão, `leads.whatsapp` (ver, enviar e ligar), pela regra única `leadInScope`
(`modules/leads/access.ts`): Admin Master, Diretoria e Gerente comercial em qualquer lead; vendedor só nos
seus. A Diretoria conversa e liga sem editar a negociação. Fora do alcance responde 404.

Trava do vendedor (Eric, 19/10): enquanto `whatsapp_settings.official_number_live` estiver desligado, quem tem
`leads.whatsapp` só nos seus leads lê a conversa, mas não envia (texto, modelo, pedido de ligação) nem liga:
a API responde 403 `whatsapp_soon` (`sellerWhatsAppLocked` em `official-number.ts`, conferido em `send()` e em
`POST /leads/:id/whatsapp/calls`), e a tela mostra "em breve" no campo de mensagem, no painel de ligação e na
ação WhatsApp da ficha. Atender uma ligação recebida não é travado: o número de teste só recebe de números
cadastrados na Meta. Os outros níveis não mudam.

## Rotas (com sessão)

| Rota                                                                      | O quê                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| `GET /leads/:id/whatsapp`                                                 | Conversa da negociação, janela, opt-out, `configured`   |
| `POST /leads/:id/whatsapp/text`                                           | Texto livre (só dentro das 24 h)                        |
| `POST /leads/:id/whatsapp/template`                                       | Modelo aprovado com os campos `{{n}}`                   |
| `GET /whatsapp/conversations[?unanswered=1]`                              | Lista no escopo de quem lê                              |
| `GET /whatsapp/conversations/:id` e `POST …/text`, `…/template`           | Conversa sem negociação (escopo total)                  |
| `GET /whatsapp/templates[?refresh=1]`                                     | Modelos aprovados                                       |
| `GET`, `POST /whatsapp/templates/manage`, `PUT …/:id`, `PUT …/:id/fields` | Tela de modelos (`modelos.md`)                          |
| `GET /whatsapp/messages/:id/media`                                        | Arquivo recebido                                        |
| `POST /leads/:id/whatsapp/template-preview`, `GET …/art`                  | O que o modelo vira agora e a arte (`arte-modelos.md`)  |
| `POST /leads/:id/whatsapp/imports[/preview]`, `GET`, `DELETE …/:batchId`  | Conversa exportada do celular (`importar-conversa.md`)  |
| `GET /leads/:id/whatsapp/messages?before=<id>`                            | Mensagens anteriores às 500 da tela, uma página por vez |

A tela da conversa se atualiza a cada 5 s e a lista a cada 15 s, com o cabeçalho `x-wings-passive: 1`: o
servidor responde sem contar como atividade da pessoa, para uma tela aberta não segurar uma sessão ociosa nem
mexer na hora de saída do ponto.

## Dados

Migrações 0077, 0079 (`wa_calls`; permissão de ligação no contato) e 0081 (`wa_media_uploads`: o id da arte na
Meta, só ids e datas, legível pelo `wings_ro`; arte e artigo em `clients`): `wa_contacts` (telefone único, `wa_id`, nome do perfil, última mensagem recebida, opt-out),
`wa_conversations` (uma por telefone e negociação; a sem negociação é única por telefone), `wa_messages`,
`wa_webhook_events`, `wa_templates`; 0093 (`wa_import_batches`, as importações do celular; visão
`wa_imports_analysis` para o `wings_ro`, ver `importar-conversa.md`). Telefone e texto são dados pessoais: sem GRANT ao `wings_ro`, nada disso
em log (o webhook registra só o formato do corpo, `shapeOf`). A auditoria `whatsapp.message_sent` guarda ids,
tipo, nome do modelo e resultado, nunca o texto.

## Variáveis

`WHATSAPP_APP_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_PHONE_NUMBER_ID` (não secretos);
`WHATSAPP_WEBHOOK_VERIFY_TOKEN` (16+ caracteres), `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN` (segredos, só
no Coolify). Sem token e número, a conversa diz que está desligada; sem segredo e token de verificação, o
webhook responde 503. Uma mudança chegada para outro número do mesmo app é ignorada.

Os números dos vendedores em coexistência (`wa_numbers`, migração 0095) têm a própria tela e o próprio token:
ver `conectar-numero.md` (`WHATSAPP_ES_CONFIG_ID`).

## Estado do staging (lido em 26/10/2026)

Leitura sem nenhum envio: Graph API só com GET, dentro do contêiner da API, sem imprimir o token; banco pelo
`wings_ro`; e os logs.

- **O staging usa o número de teste da Meta** (+1 555-669-6643, "Test Number", conta 2116475762622670). Esse
  número só entrega para até 5 números cadastrados no app da Meta. Para um lead de verdade, a Meta recusa com
  o erro 131030, que a tela mostra em português. Token, número CONECTADO e os 31 modelos aprovados estão ok, e o
  app Wings CRM Vendas está assinado no webhook.
- O switch `official_number_live` está desligado desde 19/10, e o vendedor não envia nem liga pelo sistema. Em 3
  dias de log nenhum corpo de webhook chegou, e só 2 mensagens saíram pelo sistema na história toda (14/10).
- As ligações estão ativadas no número (`calling.status` ENABLED); `callback_permission_status` está DISABLED.
- **Para falar com lead real** (passos na Meta, do Eric):
  1. passar o número comercial (final 0288) para a Cloud API na conta Wings Company (558704303984649), com forma de
     pagamento na conta, registro do número com PIN e o app Wings CRM Vendas assinado na conta;
  2. trocar no api-staging `WHATSAPP_WABA_ID`, `WHATSAPP_PHONE_NUMBER_ID` e `WINGS_WHATSAPP_NUMBER`, e reiniciar;
  3. ligar o switch na tela da caixa.

  Os modelos aprovados da conta de teste não passam para a outra conta: a conta Wings Company tem os seus
  (`modelos.md`).

## Não verificado ao vivo

Os formatos seguem a referência publicada pela Meta; nenhum corpo real chegou ainda. O primeiro teste é o do
Eric com o número de teste no staging; o log `whatsapp webhook` mostra o formato de cada corpo para conferir.
Versão da Graph API: `v23.0`, num só lugar (`modules/whatsapp/graph.ts`).

## Custos (página de preços da Meta, 30/09/2026)

Desde 01/10/2026 a Meta cobra também as mensagens de atendimento (dentro das 24 h), com 1.000 grátis por
número por mês; sem forma de pagamento, ela para de entregá-las. Brasil: atendimento e utilidade R$ 0,035,
marketing R$ 0,3217.
