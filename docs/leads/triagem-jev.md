# Triagem pelo Jev (TypeSafe AI)

O Jev decide **só para onde vai** o que chega **sem funil definido pela origem**. Quem atende continua sendo o
rodízio do funil; o Jev nunca escolhe vendedor. Desligado por padrão.

Código: `apps/api/src/modules/leads/triage.ts` (mascaramento, perguntas, cliente, decisão, roteamento),
`triage-schedule.ts` (o gancho que as portas chamam), `triage-cases.ts` (os 40 casos inventados da homologação de
14/10, usados nos testes). Ligação em `app.ts`.

## Onde entra

| Porta                                                     | Quando o Jev lê                                                                      | Fica como está                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Formulário do site (`site_form`)                          | a regra da landing page não nomeia funil: o lead nasce sem `pipeline`                | LP com funil na regra                                                   |
| Conversão do RD Station (`rd_station`)                    | a regra da origem não nomeia funil                                                   | conversão com funil na regra; espelho do RD CRM (`rd_crm`)              |
| WhatsApp, Sofia desligada                                 | primeira mensagem de texto de uma conversa nova, de número sem negociação e sem link | link rastreável (funil do cliente do link), Sofia ligada (ela pergunta) |
| Meta, Google, TikTok Lead Ads, importação, cadastro à mão | —                                                                                    | sempre: a origem ou a pessoa já definem o funil                         |

O gancho fica no fim de `upsertLead` (lead criado, não antigo, sem `pipeline`, origem em `TRIAGE_SOURCES`) e no fim
de `applyInbound` do WhatsApp (`!sofiaOn && !leadId && created && texto`). Roda fora da requisição, como as
conferências de chegada; com a triagem ligada, a porta **não** manda o aviso "lead sem dono": quem avisa é a triagem,
depois de decidir.

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

A nota de interesse (0–3) só é guardada quando o setor é expansão ou formatação. O roteamento usa `changeLead` com
origem `triage`: o histórico de etapas e os eventos `lead.pipeline_changed`, `lead.stage_changed` e
`lead.owner_changed` saem iguais aos de uma troca pela tela; a ficha mostra "Triagem (Jev)". Cada triagem grava
`lead.triaged` em `lead_events` com setor, confiança, quer_humano, interesse, modelo, tokens e o desfecho
(`routed:<funil>`, `person:<motivo>`, `failed`) — números e rótulos, nunca o texto.

Regra de 13/10 (`docs/whatsapp/sofia.md`): fornecedor, emprego e "outro assunto" passam para uma pessoa sem criar
negociação. A triagem segue a mesma regra e o mesmo aviso que a transferência da Sofia.

## Ligar

Na API (`api-staging` no Coolify), as duas variáveis:

- `LEAD_TRIAGE_ENABLED=true`
- `JEV_API_KEY=` a chave da TypeSafe (segredo; só nome aqui).

Sem as duas, nada muda: as portas seguem mandando o aviso "lead sem dono" e a conversa do WhatsApp segue esperando.
A chave fica na API, não no worker, porque o roteamento (etapa, rodízio, tarefa, aviso) é regra da API; o worker
não a tem e precisaria de tabela, migração e varredura só para devolver o veredito.

Custo: US$ 0,042 por milhão de tokens de entrada, ~800 tokens por chamada (≈ US$ 0,00003 cada). Homologação de
14/10 (40 mensagens inventadas × 3 variantes): setor certo em 100%, nenhuma injeção aceita, mediana 0,16 s.
