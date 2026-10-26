# Sofia (SDR IA) e o WhatsApp Web de cada pessoa

Versão de 07/10/2026. Pedido do Eric (07/10, 16:18, 16:35, 16:50 e 17:06) sobre o pacote da Sofia de 04/10
(`requisitos.md`, `regras-negocio.md`, `flow-*.json`). O WhatsApp oficial em si (webhook, envio, status, janela
de 24 h, ligação) está em `cloud-api.md`.

## Quem atende cada mensagem

1. **Negociação aberta do telefone com dono:** a mensagem vai direto para o dono, sem a Sofia (estado
   "Aguardando vendedor" até ele responder, depois "Com vendedor").
2. **Qualquer outra conversa nova (ou que tinha sido encerrada):** é da Sofia, se ela estiver ligada. Desligada,
   a conversa fica "Aguardando atendente" (Admin e Diretoria) e nada sai do sistema.
3. **Uma pessoa escrevendo na conversa assume:** a Sofia para (estado "Com vendedor"). O vendedor ou o Admin
   pode **devolver para a Sofia**; ela responde a próxima mensagem da pessoa (nunca as que chegaram enquanto
   uma pessoa tinha a conversa).

Estados (`wa_conversations.attendance`): `sofia` Sofia atendendo · `waiting_seller` Aguardando vendedor ·
`waiting_human` Aguardando atendente · `with_person` Com vendedor · `closed` Encerrada.

## O que a Sofia faz

- **Apresentação:** sempre "atendente virtual". Nunca se passa por pessoa.
- **Por quem ela fala (regra de 07/10, 17:06):** lead de franquia nunca ouve falar da Wings.
  - Expansão com a marca conhecida (link rastreável de marca, negociação aberta da marca, ou marca que a pessoa
    citou): "atendente virtual do time de expansão da <marca>", e nenhuma mensagem cita a Wings.
  - Formatação, ou antes de saber a marca: "atendente virtual da Wings Company". Ao descobrir a marca, passa a
    falar pelo time de expansão dela dali em diante.
  - Os textos usam marcadores: `{quem}` ("da Wings Company" / "do time de expansão da <marca>"), `{empresa}`
    ("Wings Company" / "<marca>") e `{marca}`. A configuração recusa "Wings" escrito à mão nos textos e nas
    perguntas de Expansão.
  - O vendedor e os modelos numa negociação de Expansão de marca: o servidor recusa texto ou modelo que cite a
    Wings (422 `brand_voice`), a conversa avisa "você fala pelo time de expansão da <marca>", e o pedido de
    permissão de ligação diz "A <marca> gostaria de poder te ligar…".
- **Objetivo:** sem marca conhecida, pergunta com três botões: Franquear negócio · Abrir uma franquia · Outro
  assunto. Texto livre também vale (a IA interpreta; "crescer sem franquear" vai para Formatação).
- **Formatação:** as perguntas da lista, uma por vez (nome, empresa, segmento, cidade, faturamento mensal,
  Instagram, site, como conheceu). Perguntas de opções vão como lista do WhatsApp. No fim, a negociação nasce no
  funil Formatação pela regra de entrada (`upsertLead`): rodízio do funil (Daniele/Luana), tarefa de primeiro
  contato e aviso "Novo lead para você" ao dono. As respostas ficam em "Dados do formulário" e, quando a
  pergunta diz, no campo próprio (nome, empresa, Instagram, site, cidade).
- **Expansão:** com a marca do link, confirma com botões (Sim · Outra marca · Outro assunto); sem marca,
  pergunta qual e reconhece o nome de um cliente ativo. Faz as perguntas do flow de Expansão e cria a
  negociação no funil Expansão com a marca, pelo rodízio do funil (Fernando).
- **Telefone com negociação:** se a conversa já é de uma negociação aberta sem dono, a Sofia completa essa
  negociação e dá o dono. Se o telefone tinha uma negociação fechada, ela é reaberta em vez de duplicada.
- **Passa para uma pessoa, sem criar negociação:** cliente atual, fornecedor, emprego, reclamação, pediu uma
  pessoa, não entendeu duas vezes, mandou áudio ou arquivo duas vezes, "Outro assunto" que não é Formatação nem
  Expansão, IA fora do ar ou teto diário. Admin, Diretoria e Gerente comercial recebem um aviso no painel.
- **Encerra sozinha só em três casos:** pediu para não ser contatado (SAIR/PARAR, regra fixa, sem IA; bloqueia
  mensagens ativas), spam, número errado. Uma negociação aberta sem dono da conversa vira perda com esse motivo;
  com dono, nunca é tocada.
- **Limites:** não informa valores, não promete nada, mensagens curtas. Fora do horário (seg–sex 9h–18h, São
  Paulo) a transferência leva o texto de fora do horário.

## A IA

- DeepSeek V4 Flash (`deepseek/deepseek-v4-flash`) pelo OpenRouter, com `data_collection: deny`, a mesma
  `OPENROUTER_API_KEY` do sistema. A IA **só interpreta**: diz o que a pessoa quer, quais respostas deu e se
  cabe uma frase curta de reconhecimento. O roteiro (código) escolhe e envia a próxima pergunta.
- Sem IA: botões, listas, o nome, "sim/não" da marca e "não tenho" das perguntas opcionais.
- **Nome, telefone e e-mail não vão para a IA:** a resposta do nome é lida por regra; o nome e o nome do perfil
  são trocados por "[nome]" no histórico enviado; números e e-mails são removidos.
- A frase da IA só sai se for curta, sem pergunta, sem número, sem palavra de preço, sem promessa, sem link,
  sem dizer que é pessoa e, em conversa de marca, sem citar a Wings. Senão, vai só a pergunta.
- **Teto:** `SOFIA_DAILY_USD` (padrão 1) por dia UTC. Cada chamada reserva US$ 0,01 sob trava antes de ser feita
  e fica com o custo real que o OpenRouter informa (`sofia_ai_runs`). Uma chamada fica bem abaixo de um
  centavo. Passou do teto, falhou ou demorou mais de 15 s: mensagem fixa e a conversa vai para uma pessoa.
- **Avaliação:** 87 conversas de teste e um executor medem o cérebro com modelo simulado (nos testes) ou, por outro
  comando e só quando o Eric mandar, com um modelo real: `sofia-avaliacao.md`.

## Funcionamento

- A cada mensagem da pessoa, a conversa da Sofia ganha um "turno" para daqui a 4 s; mensagens seguidas empurram
  o turno, e uma rajada recebe uma resposta só. A cada 2 s o servidor pega os turnos vencidos com trava na
  linha (dois servidores nunca respondem a mesma vez).
- O estado é gravado **antes** do envio; o envio é feito uma vez e nunca repetido (`whatsapp/outbox.ts`, o mesmo
  caminho do vendedor). "Lido até aqui" é comparado pelo relógio do banco.
- Toda mensagem da Sofia entra no registro de auditoria (`whatsapp.message_sent`, autor `sofia`); transferência
  `sofia.handed_over`, encerramento `sofia.closed`; ações de pessoas `sofia.take`, `sofia.give_back`,
  `sofia.close`; configuração `sofia.enabled`, `sofia.disabled`, `sofia.settings_changed`.

## Telas

- **CRM Vendas → Sofia (SDR IA):** todas as conversas com o estado, filtro por estado e por funil (Expansão,
  Formatação), busca; a conversa inteira, "O que a Sofia descobriu", a origem (código, anúncio) e a negociação
  criada; Assumir · Devolver para a Sofia · Encerrar; a configuração (ligar/desligar, textos e as perguntas de
  cada funil, editáveis). Ver e agir seguem `leads.whatsapp` no escopo do dono; configurar exige `sofia.manage`
  (Admin Master, Diretoria, Gerente comercial). **A Sofia nasce desligada.**
- **CRM Vendas → WhatsApp:** o WhatsApp Web de cada pessoa: conversas à esquerda (busca, não lidas por pessoa,
  status da última mensagem), conversa à direita. O vendedor vê as conversas das negociações dele; Admin e
  Diretoria veem todas (as da Sofia aparecem marcadas). **Nova conversa:** negociação ou contato do escopo, ou um
  número; número novo vira negociação pela regra do cadastro manual (`POST /leads`, exige `leads.write`); sem
  janela de 24 h, a primeira mensagem é um modelo aprovado (a tela avisa e abre a escolha do modelo).
- **Aba WhatsApp da negociação:** continua; mostra as mensagens da Sofia marcadas e o aviso de voz da marca.

## Rotas (com sessão)

| Rota | Permissão | O quê |
| --- | --- | --- |
| `GET /sofia/overview` | `leads.whatsapp` | ligada, IA configurada, gasto do dia, contagem por estado |
| `GET /sofia/conversations?state=&segment=&q=` | `leads.whatsapp` | lista no escopo |
| `GET /sofia/conversations/:id` | `leads.whatsapp` | conversa, o que ela descobriu, origem, negociação |
| `POST /sofia/conversations/:id/attendance` | `leads.whatsapp` | `take` · `give_back` · `close` |
| `GET /sofia/settings` · `PUT /sofia/settings` | `leads.whatsapp` · `sofia.manage` | textos e perguntas |
| `GET /whatsapp/conversations?filter=&q=` | `leads.whatsapp` | WhatsApp Web: não lidas por pessoa, status |
| `GET /whatsapp/conversations/:id` · `POST …/read` | `leads.whatsapp` | abrir qualquer conversa do escopo; marcar lida |
| `GET /whatsapp/targets?q=` | `leads.whatsapp` | "Nova conversa": negociações e contatos do escopo |

## Dados (migração 0080)

- `wa_conversations`: `attendance`, `state_changed_at`, `reason`, `segment`, `brand_client_id`, `sofia_facts`
  (respostas e passo do roteiro: dado pessoal, lido só pela regra do lead), `sofia_misses`, `sofia_due_at`,
  `sofia_claimed_at`, `sofia_read_until`. Conversas de antes: com negociação ficam com o vendedor; sem, ficam
  "Aguardando atendente".
- `sofia_settings` (uma linha: ligada, textos, perguntas) e `sofia_ai_runs` (ids, modelo, versão do prompt,
  ferramentas, tokens, reserva e custo; nunca texto; `tools` e os tokens vêm da migração 0096).
- `wa_conversation_reads`: até onde cada pessoa leu cada conversa.
- Nenhuma tabela nova é lida pelo `wings_ro`.

## Variáveis

`SOFIA_DAILY_USD` (opcional, padrão 1). Usa as que já existem: `OPENROUTER_API_KEY` e as do WhatsApp
(`cloud-api.md`).

## Não verificado ao vivo

- Botões e listas interativas no número de teste (formato da Meta seguido à risca; respostas `button_reply` e
  `list_reply` já são lidas pelo webhook).
- A forma real da resposta do DeepSeek com ferramenta pelo OpenRouter (o leitor recusa o que não seguir o
  esquema, e a conversa vai para uma pessoa).
- Referral de anúncio de clique para WhatsApp → marca: hoje o anúncio fica gravado na conversa e na
  negociação (`adExternalId`), mas a marca vem do link ou da resposta da pessoa.
