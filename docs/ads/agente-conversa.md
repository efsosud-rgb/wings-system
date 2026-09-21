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

## Primeira conversa real e o que ela mudou (21/09/2026)

Pedido: "Monte uma campanha de leads no Meta para o RJ, só Instagram, R$ 20 por
dia, 10 dias." As três leituras rodaram, o texto parou em "...se tiver um perfil
mais" e o cartão nunca apareceu.

**Causa (a mais provável; ver a ressalva):** o limite de saída por chamada ao
modelo era de **2.000 tokens**, e esse limite cobre o texto visível, os
argumentos das ferramentas e, nos modelos que pensam antes de responder, o
raciocínio. O modelo escreveu a análise, bateu no limite no meio da frase e
nunca chegou a chamar `propor_campanha`. O cliente ignorava o motivo de parada
(`finish_reason: length`), então a resposta cortada foi entregue como completa.
O log da API mostra as duas mensagens terminando normalmente (a lista de
conversas é recarregada só depois do evento `done`), sem erro do OpenRouter e
sem queda do stream: **o Traefik não cortou nada**.

> Ressalva: as tabelas do agente não puderam ser lidas no staging. O usuário
> somente-leitura `wings_ro` recebeu `grant select` uma vez, à mão, e tabelas
> novas não herdam isso (`permission denied for table agent_messages`). Para
> liberar: `grant select on agent_conversations, agent_messages, agent_proposals
to wings_ro;` e, para as próximas, `alter default privileges for role wings in
schema public grant select on tables to wings_ro;`. A decisão é de quem
> administra o banco, porque as conversas são de cada pessoa.

O que mudou:

- Limite de saída em 8.000 tokens e tempo por chamada em 180 s.
- O motivo de parada de cada chamada fica gravado em
  `agent_messages.diagnostics` (só números e enums) e sai no log como
  `agent turn`, sem texto de ninguém. Da próxima vez dá para saber sem ler a
  conversa.
- Resposta cortada pelo limite recebe o aviso "A resposta ficou longa demais e
  foi cortada antes do fim." e o botão "Tentar de novo".
- Argumentos de ferramenta cortados voltam ao modelo com o pedido de refazer
  mais curto, em vez de sumirem.
- **Proposta recusada nunca passa em silêncio.** Se `propor_campanha` ou
  `propor_alteracao` recusar e o modelo não refizer, o servidor acrescenta à
  resposta "A proposta não virou cartão: a validação do sistema recusou." com os
  motivos.
- Stream: cabeçalhos e um primeiro byte saem na hora, e um comentário
  `: ping` vai a cada 10 s, para nenhuma rodada longa de ferramenta ou de
  raciocínio estourar timeout de inatividade no caminho.
- Tela: stream que cai, erro ou "Parar" deixam "Resposta interrompida." com
  "Tentar de novo". Tentar de novo responde a **mesma** mensagem (`retry: true`):
  ela não é gravada duas vezes e o modelo não vê a tentativa que falhou.
- "O que consultei" nunca mostra item vazio: o rótulo cai para o nome
  compartilhado da ferramenta e item sem nada é descartado. **A origem das duas
  bolinhas vazias não foi reproduzida**; há teste garantindo que toda consulta
  sai do servidor com rótulo e resumo, inclusive proposta recusada.

## Cada campanha pelo próprio objetivo

A ingestão passou a gravar o objetivo da campanha (`ad_campaigns.objective`,
lido da Meta; o Google não tem). `desempenho_campanhas` devolve o objetivo e o
campo `julgar_por`: CPL só para leads e conversão; custo por visualização da
página e por clique para tráfego; alcance e frequência para reconhecimento. O
CPL total e o CPL histórico usado na regra de verba **não contam gasto de
campanha de tráfego**. O prompt manda dizer com todas as letras quando a
campanha não tem o objetivo pelo qual a pessoa perguntou. O objetivo só aparece
depois da próxima ingestão; até lá vem vazio e o agente diz que não sabe.

## Proposta completa e com opinião

`agentCampaignProposalSchema` recusa o que não estiver completo, e a recusa
volta ao modelo com o que falta:

- sempre: cliente ideal, região, página de destino, UTMs, verba, período,
  premissas (`assumptions`) e o motivo de objetivo, cliente ideal, região,
  verba e período;
- Meta: faixa de idade, posicionamentos, formato e 2 ou 3 variações com botão e
  **briefing para o Design** (`mediaBrief`), tudo justificado;
- Google Pesquisa: ao menos 3 palavras-chave com tipo de correspondência, ao
  menos 5 negativas (o prompt parte de `AGENT_JUNK_SEARCH_TERMS`: vaga, emprego,
  currículo, curso, grátis, franquia barata…), 3 títulos e 2 descrições;
- YouTube: título e briefing do vídeo;
- duração mínima de 7 dias;
- verba: precisa caber no teto (a recusa informa a maior verba que cabe). Em
  campanha de leads, abaixo de `CPL dos últimos 90 dias × 10 ÷ 7` por dia a
  proposta só passa com `budgetNote` dizendo o que esperar, o que cobre tanto o
  teto apertado quanto a verba que a própria pessoa pediu.

O cartão lista o que fica **pendente** com a pessoa (mídia, Página, Instagram).
O prompt manda ler a conta antes (melhores CPL e CTR em 30 ou 90 dias, textos
dos anúncios que funcionaram, perfil salvo), assumir o contexto da Wings quando
não houver perfil e dizer que assumiu, e fazer **uma** pergunta só quando faltar
algo que muda tudo. A ingestão **não traz público, horário nem região por
campanha**: o agente é instruído a dizer que não tem esses dados.

## Não verificado

- [x] O OpenRouter respondeu em staging em 21/09/2026 (modelo, streaming e
      ferramentas de leitura funcionaram).
- [ ] Conferir em `agent_messages.diagnostics` da próxima conversa se o motivo
      de parada confirma a causa acima.
- [ ] Painel fixo na coluna direita: CSS segue o padrão do checklist de SEO,
      mas não foi visto num navegador de verdade.
- [ ] (item antigo, em parte respondido) Conferir no staging: o nome
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
