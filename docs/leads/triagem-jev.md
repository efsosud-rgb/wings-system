# Triagem pelo Jev (TypeSafe AI)

O Jev decide **só para onde vai** o que chega **sem funil definido pela origem**. Quem atende continua sendo o
rodízio do funil; o Jev nunca escolhe vendedor. Desligado por padrão.

Código: `apps/api/src/modules/leads/triage.ts` (mascaramento, perguntas, cliente, decisão, roteamento, execução e
retomada), `triage-queue.ts` (a lista de espera), `triage-schedule.ts` (o gancho que as portas chamam),
`triage-cases.ts` (os 40 casos inventados da homologação de 14/10, usados nos testes). Ligação em `app.ts`.

## Onde entra

| Porta                                                     | Quando o Jev lê                                                                      | Fica como está                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Formulário do site (`site_form`)                          | a regra da landing page não nomeia funil: o lead nasce sem `pipeline`                | LP com funil na regra                                                   |
| Conversão do RD Station (`rd_station`)                    | a regra da origem não nomeia funil                                                   | conversão com funil na regra; espelho do RD CRM (`rd_crm`)              |
| WhatsApp, Sofia desligada                                 | primeira mensagem de texto de uma conversa nova, de número sem negociação e sem link | link rastreável (funil do cliente do link), Sofia ligada (ela pergunta) |
| Meta, Google, TikTok Lead Ads, importação, cadastro à mão | —                                                                                    | sempre: a origem ou a pessoa já definem o funil                         |

O gancho fica em `upsertLead` (lead criado, não antigo, sem `pipeline`, fora de importação, origem em
`TRIAGE_SOURCES`) e em `applyInbound` do WhatsApp (`!sofiaOn && !leadId && created && texto`). A porta grava a linha da
**lista de espera** (`lead_triage_queue`, abaixo) na mesma transação que cria o lead ou guarda a mensagem, e só depois
dispara a triagem fora da requisição, como as conferências de chegada. Com a triagem ligada, a porta **não** manda o
aviso "lead sem dono": quem avisa é a triagem, depois de decidir, ou o aviso de sempre se ela falhar (abaixo).

## O que o Jev recebe

Só o texto: a primeira mensagem (`first_message`) ou, sem ela, as respostas do formulário (`form_answers`, uma linha
`pergunta: resposta` por item). Antes de sair, `maskPersonalData` troca por etiquetas telefone (`[telefone]`),
e-mail (`[e-mail]`), CPF (`[cpf]`), CNPJ (`[cnpj]`) e qualquer sequência de 8+ dígitos (`[número]`); valores como
"150 mil" e "R$ 80.000" ficam. O nome, o telefone e o e-mail do lead (colunas) nunca entram: `textOfLead` só lê
as duas colunas de texto. Limite de 2.000 caracteres. `triage.test.ts` prova o mascaramento.

Pedido: `POST https://api.typesafe.ai/v1/systemone`, modelo `jev-latest`, `state = { canal, mensagem }` e as três
perguntas da variante A do teste de homologação, em português, cada uma com o aviso de tratar `mensagem` só como dado:

- `setor` (choice): expansao · formatacao · fornecedor · emprego · outro;
- `quer_humano` (noul): pede contato com uma pessoa, ligação ou reunião;
- `interesse` (score, 4 níveis): de "sem interesse" a "quer avançar já".

Uma chamada, 8 s de limite, sem repetição. Resposta lida de `answers.setor.choice/confidence`, `quer_humano.noul`
e o nível mais provável de `interesse.probabilities`. Log só com formas (status HTTP, nome do erro), nunca o texto.

## O que volta e o que acontece

| Jev respondeu                                   | Lead do site / RD                                                                                                                             | Conversa do WhatsApp                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| expansao ou formatacao, confiança ≥ 0,5         | `routeLead`: funil, etapa de entrada, dono pelo rodízio (se não tinha), tarefa de primeiro contato, regras da etapa, aviso `new_lead` ao dono | nasce a negociação (`upsertLead`, origem `whatsapp`, cliente Wings, base legal pré-contrato), a conversa passa a ser dela, aviso ao dono |
| fornecedor, emprego ou outro                    | fica sem funil, sem etapa e sem dono (sem negociação em Kanban); aviso `triage_handoff` a Admin, Diretoria e Gerente comercial                | nenhuma negociação; a conversa segue esperando atendente; mesmo aviso ao time                                                            |
| confiança < 0,5 (qualquer setor)                | idem fornecedor/emprego/outro, com o motivo "o Jev não teve certeza"                                                                          | idem                                                                                                                                     |
| não respondeu, texto vazio ou resposta estranha | o aviso "lead sem dono" de sempre (`lead_unassigned`)                                                                                         | aviso ao time "o Jev não respondeu"; a conversa segue esperando                                                                          |

Um número cujo único negócio está **fechado** (perdido, ou ganho e que voltou) recebe a conversa como **negócio novo ao
lado dele** (`reopenClosed`, a mesma regra do formulário da Meta, ordem do Eric de 09/10 e da Sofia): funil, dono pelo
rodízio, tarefa de primeiro contato e aviso ao dono. O negócio fechado não é tocado; os dois ficam ligados na linha
do tempo (`lead.reopened_as`). Antes, a mensagem caía no negócio perdido, sem funil novo e sem aviso a ninguém. (O link
rastreável ainda une ao negócio fechado, como sempre: outra porta, fora desta regra.)

A nota de interesse (0–3) só é guardada quando o setor é expansão ou formatação. O roteamento usa `changeLead` com
origem `triage`: o histórico de etapas e os eventos `lead.pipeline_changed`, `lead.stage_changed` e
`lead.owner_changed` saem iguais aos de uma troca pela tela; a ficha mostra "Triagem (Jev)". Cada triagem grava
`lead.triaged` em `lead_events` com setor, confiança, quer_humano, interesse, modelo, tokens e o desfecho
(`routed:<funil>`, `person:<motivo>`, `failed`, `fallback`, `adopted`) — números e rótulos, nunca o texto.

Regra de 13/10 (`docs/whatsapp/sofia.md`): fornecedor, emprego e "outro assunto" passam para uma pessoa sem criar
negociação. A triagem segue a mesma regra e o mesmo aviso que a transferência da Sofia.

## Nada fica sem funil e sem aviso

A triagem roda fora da requisição e o Jev pode demorar ou errar, mas o lead não fica só na memória de um processo:

- **Lista de espera** (`lead_triage_queue`, migração 0091; só ids e horários): a porta escreve a linha antes de qualquer
  coisa, na transação que cria o lead (ou guarda a primeira mensagem). Uma linha por lead e por conversa. Enquanto a
  linha está aberta, o lead está esperando.
- **Uma execução por vez.** Quem roda a triagem primeiro **toma** a linha (`claimTriage`); outra execução do mesmo alvo
  não a encontra livre e não faz nada. Uma tomada há mais de 3 minutos foi interrompida (reinício) e pode ser tomada de
  novo. Terminar fecha a linha (`done`).
- **Qualquer falha cai no aviso de sempre.** Um erro dentro da triagem (banco, regra, Jev quebrado) não se
  perde no log: o lead sem funil recebe o aviso "lead sem dono" (`lead_unassigned`), a conversa recebe o aviso à
  equipe "a triagem do Jev não terminou" (mesma chave do aviso da própria triagem, sem repetir), o evento
  `lead.triaged` registra `outcome: fallback` e a linha fecha como `fallback`. Um lead que a triagem já passou a
  uma pessoa (`triage_handoff`) **não** recebe "sem dono" por cima; um lead que uma pessoa já pôs num funil não
  recebe nada. Os avisos da triagem **não engolem erro** (`writeLeadArrivalNotice`): se o banco recusa o aviso, a
  linha fica aberta e uma passada seguinte o escreve, em vez de fechar como feita sem aviso. O evento
  `lead.triaged` é gravado por último, para que uma execução interrompida não pareça terminada.
- **Interrompida no meio do caminho.** Um lead que a triagem já pôs num funil (dono, etapa e tarefa) e que caiu
  antes de avisar o dono: a retomada vê o histórico de etapa `triage` sem o evento `lead.triaged`, avisa o dono
  (uma vez, pela chave do aviso) e grava o evento, sem perguntar ao Jev de novo. Uma conversa cujo número já tem
  um negócio aberto (feito por uma passada interrompida, ou aberto por uma pessoa enquanto isso) passa a ser dele,
  sem perguntar ao Jev, e o dono é avisado.
- **A primeira mensagem.** A porta do WhatsApp decide "primeira mensagem de texto da conversa" **dentro** da
  transação que guarda a mensagem (nenhuma outra mensagem de entrada na conversa), e não pelo fato de a conversa
  ter sido criada agora: uma segunda tentativa, depois de uma primeira interrompida, ainda a coloca na lista.
- **A conversa que se funde.** `lead_triage_queue` tem `ON DELETE CASCADE` nas duas chaves: quando
  `adoptUnmatched` apaga a conversa sem negócio que se fundiu à do negócio, a linha dela some junto, sem erro de
  chave estrangeira.
- **Retomada.** O servidor da API (não os testes) roda `startLeadTriageResume`: 15 segundos depois de subir e a cada 2
  minutos, pega as linhas abertas há mais de 30 segundos (a carência da execução que a porta acabou de disparar) e que
  ninguém segura, e roda de novo. Linha tomada **3 vezes** vai direto ao aviso de sempre, sem perguntar ao Jev. Com a
  triagem **desligada** (sem chave ou sem `LEAD_TRIAGE_ENABLED`), o que sobrou na lista recebe o aviso de sempre em vez
  de esperar por um interruptor que pode não voltar.
- Para ver o que espera, no staging: `select queued_at, claimed_at, attempts, done_at, outcome from lead_triage_queue
where done_at is null` (`wings_ro` lê a tabela; não tem dado pessoal).

## Ligar

Na API (`api-staging` no Coolify), as duas variáveis:

- `LEAD_TRIAGE_ENABLED=true`
- `JEV_API_KEY=` a chave da TypeSafe (segredo; só nome aqui).

Sem as duas, nada muda: as portas seguem mandando o aviso "lead sem dono" e a conversa do WhatsApp segue esperando.
A chave fica na API, não no worker, porque o roteamento (etapa, rodízio, tarefa, aviso) é regra da API; o worker
não a tem e precisaria de tabela, migração e varredura só para devolver o veredito.

Custo: US$ 0,042 por milhão de tokens de entrada, ~800 tokens por chamada (≈ US$ 0,00003 cada). Homologação de
14/10 (40 mensagens inventadas × 3 variantes): setor certo em 100%, nenhuma injeção aceita, mediana 0,16 s.
