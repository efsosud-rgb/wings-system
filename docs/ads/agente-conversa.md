# Conversa com o agente (Onda 7)

O painel "Conversa com o agente" do studio é um chat de verdade com o Agente de
Tráfego Wings. O agente **lê e propõe**. Ele não executa nada em plataforma, não
cria pedido, não aprova e não acessa a internet. Uma proposta é um cartão na
tela; ela só vira ação quando uma pessoa clica, e todo pedido continua passando
pelo portão de aprovações.

Isso não levanta o bloqueador de automação de `travas.md`: quem pede continua
sendo uma pessoa, uma alteração por vez. O pedido nasce com
`requested_by = a pessoa`, `requested_by_agent = false` e a marca nova
`suggested_by_agent = true`, que aparece nas telas de aprovação como "sugerido
pelo agente".

## Onde cada regra mora

| Regra                              | Onde é garantida                                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nunca executa em plataforma        | `tools.ts` não importa nenhum cliente de plataforma; a lista de ferramentas é fechada e uma ferramenta inventada pelo modelo recebe recusa                |
| Nunca cria pedido sozinho          | nenhuma ferramenta chama `reserveChange`; só `POST /agent/proposals/:id/request`, que exige `ads.request` e a sessão de quem clicou                       |
| Nunca vê token, telefone ou CPF    | ferramentas leem colunas nomeadas; `scrub.ts` limpa texto livre (mensagem da pessoa, rascunho, alertas, nomes) antes de ir ao modelo e antes de gravar    |
| Dados não são instruções           | resultado de ferramenta vai em mensagem `tool`, dentro de um envelope JSON com aviso; nunca entra no prompt de sistema nem na fala da pessoa              |
| Compliance (sem promessa de ganho) | `agentCampaignProposalSchema` aplica `checkCopyCompliance` a todo texto proposto; a recusa volta ao modelo com o motivo                                   |
| Tetos                              | `propor_campanha` recusa o que não cabe no disponível, com a mesma conta do guardião (`estimateCostCents`); o pedido real ainda passa por `reserveChange` |
| Teto diário de uso                 | `usageToday`: soma `cost_micro_usd` da pessoa desde a meia-noite de São Paulo; conferido antes da resposta e entre rodadas de ferramenta                  |
| Conversa é de quem conversou       | toda rota filtra por `employee_id`; a conversa de outra pessoa responde 404                                                                               |
| Sem acesso à internet              | a chamada ao OpenRouter não leva `plugins`, `web_search_options` nem modelo `:online` (há teste travando isso)                                            |

## Configuração

| Variável             | Padrão                      | Observação                                                                                 |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY` | vazio                       | Sem ela as rotas respondem **503** (`agent_not_configured`), nunca uma resposta inventada  |
| `AGENT_MODEL`        | `anthropic/claude-sonnet-5` | Lista fechada: só esse ou `anthropic/claude-haiku-4.5`. Outro valor impede a API de subir  |
| `AGENT_DAILY_USD`    | `2`                         | Teto por pessoa, por dia, em dólares. Ao estourar o agente avisa e para até o dia seguinte |

O custo gravado é o que o OpenRouter informa (`usage.cost`). Quando ele não
informa, entra a estimativa pela tabela de `packages/shared/src/ads/agent.ts`
(Sonnet 5: US$ 2 / US$ 10 por milhão de tokens; Haiku 4.5: US$ 1 / US$ 5), e a
mensagem fica com `cost_source = 'estimate'`.

## Tabelas (migração `0019_agent_chat`)

- `agent_conversations`: uma por conversa, de um funcionário.
- `agent_messages`: append-only. Cada resposta guarda `tool_calls` (nome,
  argumentos, resultado e o resumo mostrado em "O que consultei"), `model`,
  tokens de entrada e saída, `cost_micro_usd` e `notice` quando foi interrompida.
- `agent_proposals`: o cartão. `status` vai de `open` para `applied`,
  `requested` ou `refused`; `change_request_id` só existe depois do clique.
- `ad_change_requests.suggested_by_agent`.

Auditoria: `agent.proposal_created`, `agent.proposal_applied`,
`agent.proposal_requested` e `agent.proposal_refused_by_guard`. Os metadados
levam tipos e ids, nunca o texto da conversa.

## Ferramentas

Leitura, todas sobre o banco (o espelho da ingestão), nunca a plataforma ao vivo:
`estado_da_conta`, `desempenho_campanhas`, `conjuntos_e_anuncios`,
`alertas_abertos`, `termos_de_pesquisa`, `perfil_cliente_ideal`, `rascunho_atual`.

- `rascunho_atual` lê o formulário que o navegador manda junto com a mensagem.
  Vão só os campos do construtor; ids de imagem, Página e Instagram ficam de fora.
- `termos_de_pesquisa` responde que a ingestão **ainda não grava** palavras-chave
  nem termos de pesquisa do Google, e devolve as palavras-chave dos pedidos
  feitos pelo próprio sistema.

Proposta:

- `propor_campanha` devolve um rascunho no formato do construtor (Meta, Google
  Pesquisa, YouTube) com a explicação de cada escolha. **Não é um rascunho
  completo**: imagem, vídeo, Página e Instagram são escolhas de quem está no
  studio. O botão "Aplicar no construtor" preenche o formulário; nada é enviado.
- `propor_alteracao` cobre pausar, mudar verba e negativar termo, sempre com ao
  menos um número na justificativa. Vira botão "Criar pedido" só onde o sistema
  tem esse pedido: **pausa e verba em campanha da Meta com orçamento na
  campanha**. Negativar termo e qualquer coisa em campanha do Google que já
  existe saem como recomendação para fazer à mão, sem botão, com o motivo.

## Rotas

`GET /agent/status`, `GET /agent/conversations`, `GET /agent/conversations/:id`,
`POST /agent/messages` (SSE), `POST /agent/proposals/:id/applied`,
`POST /agent/proposals/:id/request`. Todas exigem `ads.read`; a última exige
`ads.request`. Limite de 12 mensagens por minuto por pessoa. O contrato está em
`packages/shared/src/ads/agent.ts`.

## Testes

`apps/api/src/modules/agent/*.test.ts` rodam com modelo roteirizado
(`buildApp({ agentLlm })`) e banco de teste; nenhum teste chama o OpenRouter. O
caso de injeção usa uma campanha cujo **nome** manda ignorar as instruções e um
modelo que "obedece": as ferramentas que ele tenta (`executar_pausa`,
`criar_pedido`) não existem, e nada é pedido nem alterado.

## Não verificado

- [ ] Nenhuma chamada real ao OpenRouter foi feita. Conferir no staging: o nome
      exato dos modelos, se `usage.cost` vem no último evento do stream e se o
      `cache_control` no prompt de sistema é aceito.
- [ ] O Traefik entrega o SSE sem segurar a resposta? (cabeçalhos
      `no-transform` e `X-Accel-Buffering: no` já vão).
- [ ] O texto sobre a Wings no prompt (`prompt.ts`) foi escrito a partir do
      pedido desta onda. Revisar com quem conhece o negócio.
- [ ] Custo por conversa: estimado, não medido (ver abaixo).

### Custo estimado

Prompt de sistema e ferramentas somam cerca de 3.400 tokens, enviados a cada
chamada ao modelo. Uma pergunta típica faz duas chamadas (consulta e resposta):
perto de 9.400 tokens de entrada e 350 de saída, **cerca de US$ 0,02 no Sonnet
5**. Uma conversa de seis perguntas com uma proposta fica entre **US$ 0,15 e
US$ 0,20** (metade disso no Haiku 4.5). Com o cache de prompt funcionando a
entrada repetida sai mais barata. O teto de US$ 2 por dia dá para umas dez
conversas assim por pessoa.
