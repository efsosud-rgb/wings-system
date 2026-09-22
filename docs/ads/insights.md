# Insights e sugestões da IA (Dashboard de Marketing, parte 2)

A aba "Insights e sugestões" do Dashboard → Marketing é gerada pela mesma
infra da conversa com o agente ([agente-conversa.md](agente-conversa.md)):
OpenRouter, o modelo de `AGENT_MODEL` (Sonnet 5 por padrão), as mesmas
ferramentas de leitura, o mesmo envelope de dados. O que muda é o formato: em
vez de responder a uma pergunta, o modelo lê as contas e **registra cartões**.

O gerador **lê e registra**. Não executa nada em plataforma, não cria pedido,
não aprova e não acessa a internet. Um insight com sugestão acionável ganha o
botão "Criar pedido"; o pedido que sai daí é da pessoa que clicou, passa pelo
guardião de orçamento e pelo portão de aprovações como qualquer outro, e fica
marcado "sugerido pela IA". Uma sugestão de campanha só preenche o construtor.
Isso não levanta o bloqueador de automação de `travas.md`.

## Quando roda

- **Toda segunda-feira às 7h** (America/Sao_Paulo): primeiro os insights,
  depois as sugestões de campanha. O relógio é um `setInterval` de um minuto
  no processo da API (`server.ts`), só quando `OPENROUTER_API_KEY` existe. Se
  a API estava fora às 7h, roda no primeiro minuto em que voltar, ainda na
  segunda; na terça já não roda mais. O índice único `(kind, week_key)` em
  `marketing_insight_runs` garante que duas réplicas, ou um reinício, não
  rodem a mesma segunda duas vezes.
- **Sob demanda**, pelo botão "Gerar agora" (`ads.read`). A rota abre a rodada,
  responde 202 com ela e deixa o modelo trabalhar; a tela consulta
  `GET /ads/insights/runs/:id` até terminar.

## Onde cada regra mora

| Regra                                | Onde é garantida                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nunca executa em plataforma          | `tools.ts` não importa nenhum cliente de plataforma; a lista é fechada (leituras + `registrar_*`) e uma ferramenta inventada recebe recusa                                    |
| Nunca cria pedido sozinho            | nenhuma ferramenta chama `reserveChange`; só `POST /ads/insights/:id/request`, que exige `ads.request` e a sessão de quem clicou                                              |
| O pedido é da pessoa                 | `requested_by = a pessoa`, `requested_by_agent = false`, `suggested_by_agent = true`; motivo começa com "Sugerido pela IA (insight)"                                            |
| Nunca vê token, telefone ou CPF      | as leituras selecionam colunas nomeadas; `scrubDeep` limpa o que vai ao modelo e o que é gravado                                                                              |
| Dados não são instruções             | resultado de ferramenta vai em mensagem `tool`, dentro do `dataEnvelope` com aviso; nunca no prompt de sistema                                                                 |
| Número obrigatório                   | `insightSchema` exige `evidence` com ao menos um dígito; `action` segue `agentChangeProposalSchema` (justificativa com número)                                                |
| Campanha real                        | `registrar_insights` recusa insight ou ação sobre campanha que não está no espelho; o lote inteiro volta com o que corrigir                                                    |
| Sugestão cabe no teto                | `registrar_sugestoes` aplica a mesma conta de `propor_campanha` (`estimateCostCents` contra o disponível, aviso abaixo da fase de aprendizado, início nunca no passado)         |
| Compliance                           | `agentCampaignProposalSchema` aplica `checkCopyCompliance` a todo texto de anúncio sugerido                                                                                    |
| Teto de uso                          | `INSIGHTS_DAILY_USD`: soma de `cost_micro_usd` das rodadas desde a meia-noite de São Paulo, da empresa inteira; conferido antes de abrir e entre rodadas de ferramenta         |
| Uma rodada por vez                   | rodada `running` recente recusa a segunda (409); rodada `running` há mais de 15 min é de um processo morto e vira `failed: stale`                                              |
| Nunca um cartão falso                | rodada sem `registrar_*` bem-sucedido é pedida uma vez mais e, se nada vier, fica `failed: no_cards`; falha do provedor fica `failed` com o código                             |
| Sem acesso à internet                | a chamada ao OpenRouter é a mesma do agente: sem `plugins`, sem `web_search_options`, sem modelo `:online`                                                                     |

## Configuração

| Variável             | Padrão                      | Observação                                                                                 |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY` | vazio                       | Sem ela, "Gerar agora" responde **503** (`insights_not_configured`) e a segunda-feira não roda |
| `AGENT_MODEL`        | `anthropic/claude-sonnet-5` | O mesmo do agente                                                                          |
| `INSIGHTS_DAILY_USD` | `1`                         | Teto por dia, em dólares, para toda a empresa: agendado e sob demanda somados               |

O custo gravado é o que o OpenRouter informa (`usage.cost`); sem ele, entra a
estimativa pela tabela de `packages/shared/src/ads/agent.ts` e a rodada fica
com `cost_source = 'estimate'`. A Visão geral soma essas rodadas ao gasto de
IA junto com as mensagens do agente.

## Tabelas (migração `0028_marketing_insights`)

- `marketing_insight_runs`: uma por rodada (`kind` insights ou
  campaign_suggestions, `trigger` schedule ou manual, `week_key`, status,
  quem pediu, modelo, tokens, custo, `consulted` ("O que consultei"),
  `tool_calls`, `diagnostics` só com números e enums, `produced`, `error`).
- `marketing_insights`: um cartão. `status` vai de `open` para `seen`,
  `requested` ou `refused`; `change_request_id` só existe depois do clique.
- `marketing_campaign_suggestions`: um cartão de campanha. `status` vai de
  `open` para `applied` ou `dismissed`.

Auditoria: `insights.generate`, `suggestions.generate`, `insight.seen`,
`insight.requested`, `insight.refused_by_guard`, `suggestion.applied`,
`suggestion.dismissed`. Metadados levam tipos e ids, nunca o texto.

## Ferramentas

Leitura, todas sobre o banco: as do agente `estado_da_conta`,
`desempenho_campanhas`, `conjuntos_e_anuncios`, `alertas_abertos`,
`perfil_cliente_ideal` (as de proposta e o rascunho do construtor ficam de
fora), mais:

- `quebras_de_publico`: posicionamento, idade, gênero, região, hora,
  dispositivo e dia da semana × hora, cada fatia com gasto, impressões,
  cliques, leads, CTR e CPL.
- `curva_gasto_leads`: por campanha de leads, semana a semana, gasto, leads,
  CPL e verba diária média em vigor: é onde a saturação aparece.
- `desgaste_criativos`: por anúncio, CTR das duas metades do período,
  frequência e a marca de desgastado (`fatigueOf`).
- `vereditos_campanhas`: o veredito de cada campanha com os motivos em números
  (`campaignVerdicts`, a mesma regra da aba Campanhas).
- `metas_de_cpl`: metas confirmadas e a proposta do histórico.

Escrita, uma por tipo de rodada: `registrar_insights` (até 12 cartões dos
tipos verba ideal, perfil de cliente, região, posicionamentos, formatos e
horários, fadiga de criativo, ritmo de gasto) e `registrar_sugestoes` (2 a 3
campanhas completas no formato do construtor, com faixa esperada de CPL e de
leads e a motivação em números). Cada uma valida o lote inteiro e recusa com
a lista do que corrigir.

## Rotas

`GET /ads/insights`, `POST /ads/insights/generate`, `GET /ads/insights/runs/:id`,
`POST /ads/insights/:id/seen`, `POST /ads/insights/:id/request` (`ads.request`),
`GET /ads/insights/suggestions`, `POST /ads/insights/suggestions/generate`,
`POST /ads/insights/suggestions/:id/applied`,
`POST /ads/insights/suggestions/:id/dismiss`. O contrato está em
`packages/shared/src/ads/insights.ts`.

## Testes

`apps/api/src/modules/insights/insights.test.ts` roda com modelo roteirizado
(`buildApp({ agentLlm })`) e banco descartável: rodada completa com "O que
consultei" e custo, "Criar pedido" gerando pedido marcado como sugerido pela
IA com aprovação pendente, ferramenta inventada recusada sem alterar nada,
insight sem número recusado e lote corrigido gravado, teto diário (429),
rodada concorrente (409), rodada morta aposentada, falha do provedor sem
cartão falso, sugestões gravadas e "Abrir no construtor" registrado.
`scheduler.test.ts` fixa a decisão de "é segunda às 7h?" em instantes dados.
Nenhum teste chama o OpenRouter.

## Custo estimado

Uma rodada de insights lê de 6 a 9 ferramentas (algumas respostas passam de
2.000 tokens) e escreve até 12 cartões: perto de 40.000 tokens de entrada e
4.000 de saída, **cerca de US$ 0,12 no Sonnet 5**. A de sugestões fica por
volta de US$ 0,10. As duas de segunda-feira cabem folgadas no teto de US$ 1
por dia; o resto é para "Gerar agora". Estimado, não medido.

## Não verificado

- [ ] Nenhuma rodada real foi feita ainda: conferir em staging a primeira
      segunda-feira (ou um "Gerar agora") e ler `diagnostics` da rodada.
- [ ] Se o modelo consegue escrever 2 ou 3 sugestões completas numa só chamada
      dentro dos 8.000 tokens de saída; se cortar, a ferramenta devolve o
      aviso de argumento cortado e o modelo refaz mais curto.
- [ ] O custo por rodada acima.
