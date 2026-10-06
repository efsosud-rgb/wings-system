# Pesquisa da empresa na chegada (OpenRouter)

Quando um lead chega com dados da **empresa** (nome da empresa, site, Instagram ou CNPJ), o
worker pesquisa a empresa na web e grava o resultado na negociação. Aparece na ficha, no painel
**Pesquisa da empresa**, logo abaixo de "Dados do formulário", com as fontes e a data.

## O que sai do servidor

Só a empresa, nesta ordem, uma por linha (`promptOf`):

```
Pesquise esta empresa.
Empresa: <nome da empresa>
Site: <endereço, sem caminho nem parâmetros>
Instagram: @<usuário>
CNPJ: <CNPJ válido>
```

- **Nunca** o nome da pessoa, o telefone, o e-mail nem o CPF: o pedido (`LeadResearchInput`) não
  tem lugar para eles. Antes de enviar (`researchInputOf`):
  - o nome da empresa e o Instagram são descartados se parecem contato de pessoa: um e-mail
    (também "(at)") ou 8 ou mais dígitos com só separadores entre eles ("(11) 9 1234-5678",
    "123.456.789-09", "11912345678"). O teste roda no texto inteiro, antes de cortar em 120
    caracteres;
  - um "nome da empresa" igual ao nome da pessoa é descartado (comparado, nunca enviado); um nome
    que só contém o da pessoa ("Ana Souza Alimentos") segue;
  - o CNPJ só vai se os dígitos verificadores conferem; o site só se é endereço público (nunca IP,
    nunca porta que o navegador recusa) e é cortado no endereço, sem caminho nem parâmetros.
- O OpenRouter é chamado com `data_collection: deny` (só provedores que não guardam nem treinam
  com o texto), `plugins: [{ id: "web", engine: "exa", max_results: 5 }]` e
  `usage: { include: true }`. A mesma conta e a mesma chave do agente de tráfego
  (`OPENROUTER_API_KEY`). O motor `exa` é fixado de propósito: no padrão (a busca do próprio
  provedor do modelo) o limite de 5 resultados e o preço por resultado não valeriam.
- O prompt diz ao modelo que o nome da empresa e o texto das páginas são dados não confiáveis,
  nunca instruções.
- O modelo é um dos do agente (`LEAD_RESEARCH_MODEL`, padrão `anthropic/claude-haiku-4.5`).

## O que volta e o que é gravado

O modelo preenche cinco campos: o que a empresa faz, cidade e estado, porte, tempo de mercado e
presença online. Em `leads.enrichment_facts.webResearch` (sem migração):

- **`fields`**: cada campo com `value` ou, se a busca não trouxe, `value: null` e o `reason`.
  A tela mostra "—" e o motivo. Nada é completado por suposição.
- **`sources`**: as páginas que **a própria busca** devolveu (anotações `url_citation` da
  resposta), no máximo 5, só http/https, sem usuário/senha, sem repetição. O modelo não escreve
  links. **Sem nenhuma página, todos os valores são descartados** ("A busca não trouxe páginas
  para confirmar").
- E-mail, telefone (com DDD, escrito com espaços ou traços, ou celular sem DDD) e CPF que o modelo
  copie de uma página são trocados por "[… removido]" antes de gravar. O CNPJ da empresa, anos
  ("2015-2020") e valores em reais ("R$ 12.000.000") ficam. Um telefone fixo sem DDD e sem
  código de área passa: o prompt já pede ao modelo que não os escreva.
- Se a busca trouxe páginas mas a resposta do modelo não é o JSON pedido, o passo vira `failed`
  (a chamada foi paga e a reserva fica), em vez de mostrar cinco linhas "não dizem isso".
- Com a busca sem nenhuma página, o resultado é `done` com todos os campos "—" e o motivo, e a
  tela diz "nada foi guardado".
- **`status`**: `done`; `skipped` (o formulário não trouxe dado da empresa); `refused` (teto do
  dia atingido, nenhuma chamada); `failed` (o provedor não respondeu). Nos três últimos a tela
  mostra o motivo, sem linhas.
- **`at`**: quando rodou. **`model`**: qual modelo.

Resumo automático por IA: a tela diz isso e pede para conferir nas fontes.

## Quando roda

No job `enrich_lead` (o mesmo que já roda na chegada do lead), depois do CNPJ e antes da nota.
Lead de importação (RD, CSV) não roda (`skipResearch`). O formulário do site só enfileira a
pesquisa com `SITE_FORM_RESEARCH_ENABLED=true` (API). Um lead já pesquisado não é pesquisado de
novo por chegar outra vez. Sem um worker que reivindique `enrich_lead`
(`WORKER_JOB_TYPES`), os trabalhos ficam na fila sem rodar.

**Rodar de novo não paga de novo.** Um resultado `done` com páginas fica: "Pesquisar de novo"
(que refaz os outros passos do `enrich_lead`) não chama o OpenRouter outra vez, não gasta e não
troca o resultado por uma recusa ou falha. O mesmo vale com o provedor desligado. Só um resultado
sem páginas, `refused`, `failed` ou `skipped` é tentado de novo.

## Variáveis (worker; só nomes, valores no Coolify)

| Variável                     | Padrão                       | Para quê                                                                     |
| ---------------------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY`         | vazio                        | a chave do OpenRouter (a mesma da API). Sem ela, o passo é pulado.           |
| `LEAD_RESEARCH_ENABLED`      | desligado                    | só `true` liga. Sem isso nenhum gasto, mesmo com a chave.                    |
| `LEAD_RESEARCH_DAILY_USD`    | 1                            | **teto do dia** só desta pesquisa (dia de São Paulo), maior que 0 e até 100. |
| `LEAD_RESEARCH_USD_PER_CALL` | 0,06                         | quanto uma pesquisa deve custar; reservado antes da chamada.                 |
| `LEAD_RESEARCH_MODEL`        | `anthropic/claude-haiku-4.5` | `anthropic/claude-haiku-4.5` ou `anthropic/claude-sonnet-5`.                 |

Uma variável em branco vale como não definida (vale o padrão). O worker precisa ter
`enrich_lead` em `WORKER_JOB_TYPES` (o padrão já tem).

## Dinheiro

- **Teto próprio**, separado do `ENRICH_DAILY_USD` (que segue valendo para a Brave e outros
  passos): cada um soma só as próprias linhas do `lead_enrichment_ledger`.
- Antes da chamada, sob trava (`pg_advisory_xact_lock`), o custo estimado entra no ledger (passo
  `ai_research`, estado `started`); se a soma do dia passar do teto, grava `refused` e **não
  chama**. A chamada é feita **uma vez, sem nova tentativa**: o OpenRouter cobra mesmo que a
  resposta não sirva.
- Depois, uma segunda linha `done` acerta a reserva para o custo real informado pelo OpenRouter
  (`usage.cost`): positiva se passou da reserva, **negativa** se ficou abaixo (o ledger só recebe
  linhas novas), então o teto acompanha o gasto real. Sem `usage.cost`, estima por tokens (preço do
  modelo) mais US$ 0,004 por página; sem nada, fica a reserva. Quando a chamada falha, a reserva
  fica inteira.
- Dois pedidos de pesquisa do mesmo lead ao mesmo tempo (clique duplo em "Pesquisar de novo")
  podem enfileirar dois trabalhos e pagar duas vezes: a checagem de estado da rota não é atômica
  (já era assim). O teto limita o total.
- Uma pesquisa custa na ordem de US$ 0,03 a 0,06 (5 páginas da busca mais o modelo): com o teto
  de US$ 1, cerca de 16 a 30 pesquisas por dia. **Estimativa, não medida.**

## Logs

Só o formato (`worker: enrich_lead`, `msg: lead research`: nomes de chaves e números; texto vira
`string(N)`). Nunca a pergunta, a resposta, o nome da empresa nem uma fonte. O ledger guarda
contagens e códigos.

## Não verificado ao vivo

Feito pela referência do OpenRouter: o formato das anotações `url_citation`, o campo
`usage.cost` (e se ele já inclui a taxa da busca) e o preço da busca por resultado. O log de
formato mostra o que vier na primeira pesquisa real; se a taxa da busca não estiver no
`usage.cost`, o ledger fica abaixo do real e o `LEAD_RESEARCH_USD_PER_CALL` deve subir.
