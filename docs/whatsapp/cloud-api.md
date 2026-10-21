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
- **Arquivos recebidos:** copiados da Meta para o nosso armazenamento (R2) logo depois de chegar
  (`modules/whatsapp/media-store.ts`, a cada minuto, na API; liga sozinho quando o WhatsApp e o armazenamento
  estão configurados). Cada arquivo vai uma vez; uma falha é tentada de novo depois de 1, 5 e 30 minutos, 2, 6
  e 12 horas e depois uma vez por dia, enquanto a Meta ainda guarda o arquivo (30 dias desde a mensagem): um
  token vencido ou o armazenamento fora do ar, consertados dentro desse prazo, não perdem nada. Só arquivo
  grande demais (mais de 100 MB) fica `failed` na hora. Só entra na fila mensagem dos últimos 30 dias.
  `GET /whatsapp/messages/:id/media`, com a mesma regra de acesso, responde com um endereço assinado de 5
  minutos para o arquivo guardado; antes da cópia (ou se ela falhou), busca na Meta na hora, como antes.
  Imagem, áudio (menos AMR), vídeo MP4 e PDF abrem no navegador; qualquer outro tipo só baixa
  (`application/octet-stream`, e com `Content-Security-Policy: sandbox` quando vem da Meta), para nada rodar
  na origem do sistema. O token só vai para os servidores da Meta. Na tela, a foto e a figurinha aparecem no
  balão, áudio e vídeo têm o player do navegador (só baixam no play), AMR, 3GPP e documento são um link; o
  que não abre mostra "—" e o motivo. Trocar o armazenamento (do volume local para o R2, ou de bucket) deixa
  os arquivos já guardados no lugar antigo: copiar antes, como no `drive:migrate-media`.
- **O que mais o balão mostra (b1, mesmo PR):** a resposta citada traz no topo a mensagem respondida
  (`context.id`); a reação aparece no balão da mensagem a que é (a última de cada lado; a reação sem emoji
  tira a anterior), e vira uma linha quando essa mensagem não está na lista da tela; o cartão de contato
  mostra o nome e os números de cada contato (guardados em `content.contacts` desde esta versão; um cartão de
  antes só tem a quantidade); a localização mostra nome, endereço e um link para o Google Maps. A API acha a
  mensagem citada ou reagida **só na mesma negociação** (ou na mesma conversa sem negociação), nunca em
  outra. O que não dá para mostrar aparece com "—" e o motivo, nunca some.
- **Ordem de entrada da migração 0096:** depois da 0094 (pacote de 20/10) e da 0095 (PR #8, `wa_numbers`),
  nesta ordem. O drizzle aplica pela data: a 0096 aplicada antes da 0095 faz a 0095 ser pulada para sempre, e
  a fila do webhook passa a falhar na tabela `wa_numbers` que não existe. O snapshot da 0096 já contém
  `wa_numbers`.
- **Números dos vendedores (próximo bloco):** a fila e a rota usam o token do número oficial. Antes de guardar
  mensagens dos números dos vendedores, a mensagem precisa dizer de qual número veio, e a cópia usar o token
  desse número (`wa_numbers`); senão a Meta recusa e o arquivo se perde nos 30 dias.
- **Quanto tempo o arquivo fica:** o mesmo que a mensagem, e a mensagem o mesmo que a negociação (o banco não
  apaga uma negociação com conversa). Quem apagar mensagens deixa o arquivo sem mensagem, e a fila apaga o
  objeto e depois a linha (`wa_message_files.message_id` fica nulo com `ON DELETE SET NULL`).

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

## Caixa como o WhatsApp Desktop (b2, 20/10)

- **Tela:** uma janela da altura da tela, a lista à esquerda e a conversa à direita, cada uma rolando por si.
  Linhas lisas com as iniciais num tom fixo por conversa, hora de hoje pelo relógio e as outras por dia
  ("Ontem", dia da semana, data; `pages/crm/whatsapp-time.ts`), e a marca do dia sobre a primeira mensagem
  de cada dia (também na aba da negociação).
- **Busca no texto:** `GET /whatsapp/conversations?q=` procura no nome, no telefone (4+ dígitos) e, a partir
  de 3 letras (`WA_TEXT_SEARCH_MIN`), no texto das mensagens, nas mesmas conversas que a pessoa já alcança
  (vendedor: as das suas negociações; sem negociação, só quem vê tudo). A linha traz a última mensagem achada,
  cortada em volta do termo (`match`). Reação não conta; `%` e `_` valem como digitados. O log da requisição
  corta a query string; mas, se o banco falhar no meio da busca, a mensagem de erro do drizzle leva o termo
  para o log, como acontece em toda rota com consulta (pendência à parte: um tratador de erro que registre só o
  nome e o código). Sem índice: `ILIKE` em `wa_messages.text` das conversas alcançadas; se ficar lento com
  muitas conversas importadas, o próximo passo é um índice trigram (migração). O filtro "Não lidas" roda na
  consulta, antes do limite de 200, para achar o que o menu conta.
- **Não lidas no menu:** `GET /whatsapp/inbox/summary` (`modules/whatsapp/inbox.ts`) diz quantas conversas
  do alcance de quem lê têm mensagem da pessoa ainda não aberta (a mesma regra da lista, `unreadMessageOf`) e
  um carimbo que muda quando uma delas recebe mensagem, troca de mãos ou é lida. O item WhatsApp do menu mostra
  o número (99+ acima de 99); vendedor vê "em breve" até o número oficial ligar.
- **Mensagem nova na hora:** o mesmo stream das ligações (`GET /whatsapp/calls/stream`) manda também
  `event: inbox` com esse resumo, na conexão e quando muda. O webhook com mensagem ou status, todo envio
  (`outbox.ts`, equipe e Sofia) e a abertura de uma conversa avisam os streams (`inbox-signal.ts`, só no
  processo da API, sem dado da mensagem); a batida de 15 s cobre o resto (troca de dono, a Sofia passando a
  conversa). Quando o carimbo muda, a tela busca de novo a lista e a conversa aberta
  (`api/whatsapp-inbox.ts`). Com o stream fora, o resumo é perguntado a cada 30 s e as telas seguem com as
  próprias atualizações (conversa 5 s, lista 10 s). Status de entrega sozinho não move o carimbo: os vistos
  aparecem pela atualização da própria tela.

## Enviar arquivo (b3, 21/10)

- **Tela:** 📎 e 😊 à esquerda do campo (`pages/crm/WhatsAppAttach.tsx`). O arquivo escolhido aparece acima
  do campo com nome, tamanho e como vai, e o campo vira a legenda. Um arquivo por vez. O 😊 abre uma grade
  fixa de 48 emojis que entram onde está o cursor (sem biblioteca; o teclado de emoji do computador continua
  valendo).
- **O arquivo fica na negociação:** primeiro ele sobe para os Arquivos da negociação pelo caminho que já
  existe (`POST /leads/:id/files/uploads` → envio direto ao R2 → `…/complete`, que pede `leads.write`), e
  depois a conversa o envia pelo id (`POST …/media` com `{ fileId, caption? }`). Se a negociação já tem um
  arquivo com o mesmo nome, a tela oferece "Enviar o que já está lá" (vai pelo id, sem subir de novo) ou
  "Enviar com outro nome". Se o envio falha depois da subida, a nova tentativa não sobe o arquivo outra vez.
  Numa conversa sem negociação, ou para quem não edita a negociação, o 📎 fica desligado e o motivo aparece
  embaixo do campo.
- **Como vai:** uma regra só, `waSendKindOf` em `packages/shared`; a tela confere antes de subir e a API
  confere de novo antes de enviar.

  | Arquivo                                              | Vai como  | Até    |
  | ---------------------------------------------------- | --------- | ------ |
  | JPG, PNG                                             | foto      | 5 MB   |
  | MP4, 3GP                                             | vídeo     | 16 MB  |
  | AAC, AMR, MP3, M4A (`audio/mp4`, `audio/x-m4a`), OGG | áudio     | 16 MB  |
  | qualquer outro, ou acima do limite do seu tipo       | documento | 100 MB |

  Acima de 100 MB não vai. Os limites são em megabytes decimais (5 MB = 5.000.000 bytes, `WA_SEND_LIMITS`),
  para nunca esbarrar no limite da Meta por arredondamento; a tela mostra o tamanho como o Drive (base 1024),
  então uma foto que aparece com 4,8 MB pode ir como documento. Legenda de até 1024 caracteres em foto, vídeo
  e documento; áudio vai sem legenda e o texto fica no campo para a próxima mensagem. Documento leva o nome
  do arquivo.

- **Regras do envio** (as do texto, em `send()` de `routes.ts`): só dentro da janela de 24 h (fora dela, 409
  `window_closed`: só modelo) e com a trava do vendedor (403 `whatsapp_soon`). O arquivo tem de ser da própria
  negociação e estar fora da lixeira (`leadHasFile`; senão 404 `file_not_found`). Conversa sem negociação: 422
  `no_deal`. Acima de 100 MB: 413 `too_large`. Legenda em áudio: 422 `caption_not_allowed`. A voz da marca
  (`brand_voice`) confere a legenda **e o nome do arquivo**, porque um documento mostra o nome à pessoa: um
  arquivo cujo nome cite a Wings não vai para um lead de marca; envie com outro nome.
- **Na Meta:** o arquivo sobe uma vez por número (`driveFileMediaId` em `art.ts`, o mesmo caminho da arte) e
  o id fica em `wa_media_uploads` por até 25 dias, para aquela versão do arquivo; o segundo envio usa o id
  guardado. Se um status disser depois que o arquivo sumiu (códigos 100, 131009, 131052 ou 131053), o id é
  descartado e o próximo envio sobe de novo. Falha na subida responde 502 `media_upload_failed` e nada é
  enviado (o código 100 na subida vira "a Meta não aceita este tipo de arquivo"). Como todo envio, vai uma vez
  e nunca é repetido sozinho. A subida espera até 60 s: um documento grande numa conexão lenta pode passar
  disso, e então responde 502 e nada é enviado.
- **O que fica gravado:** a mensagem guarda `{ media: { id, mimeType, filename }, file: { fileId, version } }`.
  A auditoria `whatsapp.message_sent` leva `kind: 'media'`, `fileId` e `sentAs` (foto, vídeo, áudio ou
  documento), nunca o nome do arquivo nem a legenda. Sem migração.
- **No balão:** o arquivo enviado abre do Drive, na versão que foi (se o arquivo ganhou versão nova depois, o
  balão mostra a enviada, lida de `drive_file_versions`), por um endereço que vale 5 minutos. Cada abertura
  grava `drive.file_previewed` ou `drive.file_downloaded` com `purpose: 'whatsapp_message'`. Com o arquivo na
  lixeira, o balão busca na Meta, como um arquivo recebido ainda não copiado. A fila que copia os arquivos
  recebidos (`media-store.ts`) pula as mensagens com `file`: o que a equipe mandou já está no Drive.
- **Fora desta entrega:** gravar áudio no navegador, figurinha, localização, contato, vários arquivos de uma
  vez, arrastar ou colar, arquivo fora das 24 h (só modelo) e responder citando uma mensagem.

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

| Rota                                                                     | O quê                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `GET /leads/:id/whatsapp`                                                | Conversa da negociação, janela, opt-out, `configured`   |
| `POST /leads/:id/whatsapp/text`                                          | Texto livre (só dentro das 24 h)                        |
| `POST /leads/:id/whatsapp/template`                                      | Modelo aprovado com os campos `{{n}}`                   |
| `GET /whatsapp/conversations[?filter=&q=]`                               | Lista no escopo de quem lê, com busca no texto          |
| `GET /whatsapp/inbox/summary`                                            | Conversas não lidas (menu) e o carimbo da caixa         |
| `GET /whatsapp/conversations/:id` e `POST …/text`, `…/template`          | Conversa sem negociação (escopo total)                  |
| `GET /whatsapp/templates[?refresh=1]`                                    | Modelos aprovados                                       |
| `POST /leads/:id/whatsapp/media`, `…/conversations/:id/media`            | Arquivo da negociação, por id (ver "Enviar arquivo")    |
| `GET /whatsapp/messages/:id/media`                                       | Arquivo recebido ou enviado                             |
| `POST /leads/:id/whatsapp/template-preview`, `GET …/art`                 | O que o modelo vira agora e a arte (`arte-modelos.md`)  |
| `POST /leads/:id/whatsapp/imports[/preview]`, `GET`, `DELETE …/:batchId` | Conversa exportada do celular (`importar-conversa.md`)  |
| `GET /leads/:id/whatsapp/messages?before=<id>`                           | Mensagens anteriores às 500 da tela, uma página por vez |

A tela da conversa se atualiza a cada 5 s e a lista a cada 10 s (e na hora, pelo stream, quando chega
mensagem), com o cabeçalho `x-wings-passive: 1`: o servidor responde sem contar como atividade da pessoa, para
uma tela aberta não segurar uma sessão ociosa nem mexer na hora de saída do ponto.

## Dados

Migrações 0077, 0079 (`wa_calls`; permissão de ligação no contato) e 0081 (`wa_media_uploads`: o id da arte na
Meta, só ids e datas, legível pelo `wings_ro`; arte e artigo em `clients`): `wa_contacts` (telefone único, `wa_id`, nome do perfil, última mensagem recebida, opt-out),
`wa_conversations` (uma por telefone e negociação; a sem negociação é única por telefone), `wa_messages`,
`wa_webhook_events`, `wa_templates`; 0093 (`wa_import_batches`, as importações do celular; visão
`wa_imports_analysis` para o `wings_ro`, ver `importar-conversa.md`); 0096 (`wa_message_files`, a fila e o
endereço no armazenamento de cada arquivo recebido; visão `wa_message_files_analysis` para o `wings_ro`, sem a
chave do arquivo). Telefone e texto são dados pessoais: sem GRANT ao `wings_ro`, nada disso
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
A cópia dos arquivos para o R2 só rodou contra a Meta simulada e o armazenamento local: o primeiro arquivo real
(foto ou áudio mandado ao número de teste) confere o tipo, o tamanho e o player do navegador no endereço do R2;
a fila aparece no log como `whatsapp_media` (só contagens) e na visão `wa_message_files_analysis`.
Resposta citada, reação (em especial a tirada, que a Meta manda sem emoji), cartão de contato e localização
seguem só o formato publicado.
A caixa como o WhatsApp Desktop foi vista num navegador de verdade só com a API simulada; o aviso de mensagem
nova pelo stream e a velocidade da busca no texto com as conversas reais (importações do celular incluídas)
ficam para o staging.
O envio de arquivo (b3) foi testado com a Meta simulada e visto num navegador só com a API simulada. Sem um
envio real (que só acontece a pedido), não se sabe ainda: quais tipos de documento a Meta aceita (a lista
publicada fala em PDF, TXT e Office; um ZIP provavelmente é recusado na subida, e a tela mostra a mensagem);
se o áudio chega como mensagem de voz ou como arquivo; se a legenda aparece num documento; e o tempo de
subida de um arquivo grande para o R2 e para a Meta.

## Custos (página de preços da Meta, 30/09/2026)

Desde 01/10/2026 a Meta cobra também as mensagens de atendimento (dentro das 24 h), com 1.000 grátis por
número por mês; sem forma de pagamento, ela para de entregá-las. Brasil: atendimento e utilidade R$ 0,035,
marketing R$ 0,3217.
