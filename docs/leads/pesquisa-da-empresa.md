# Pesquisa da empresa na chegada (OpenRouter)

Quando um lead chega com dados da **empresa** (nome da empresa, site, Instagram ou e-mail
corporativo), o worker pesquisa a empresa na web e grava o resultado na negociação. Aparece na
ficha, no painel **Pesquisa da empresa**, logo abaixo de "Dados do formulário": cada dado com a
página de onde veio, e a data.

Regras do Eric de 14/10/2026: só lead novo (a partir da data de corte), só dados da empresa
(nunca CNPJ), uma pesquisa por lead, teto diário, e a fonte de cada dado.

## O que sai do servidor

Só a empresa, nesta ordem, uma por linha (`promptOf`):

```
Pesquise esta empresa.
Empresa: <nome da empresa>
Site: <endereço, sem caminho nem parâmetros>
Instagram: @<usuário>
Domínio do e-mail: <só o que vem depois do @, e só se for corporativo>
```

- **Nunca** o nome da pessoa, o telefone, o e-mail inteiro, o CPF nem o **CNPJ**: o pedido
  (`LeadResearchInput`) não tem lugar para eles, e o worker nem lê o CNPJ do lead. O prompt
  pede ao modelo que pesquise só a empresa e não procure pessoas pelo nome. O sistema não abre o
  Instagram: o usuário vai como texto para a busca, que pode devolver a página pública do perfil
  como uma das páginas encontradas. Antes de enviar (`researchInputOf`):
  - do e-mail, só o domínio, e só quando é corporativo (`corporateEmailDomainOf`, que confia no
    `kind` de `emailDomainOf`): os webmails gratuitos ficam de fora, e a regra é uma só
    (`isFreeMailDomain`, `packages/shared/src/leads.ts`), que também alimenta a nota do lead e a
    busca paga do CNPJ pelo domínio. São **domínios exatos** (`PERSONAL_EMAIL_DOMAINS`: gmail.com,
    oi.com.br, pop.com.br, pm.me, hey.com, web.de...) e **marcas em qualquer final simples**
    (gmail, hotmail, outlook, live, yahoo, icloud, uol, bol, terra, ibest, superig, r7, sapo,
    fastmail, tutanota, qq... seguidos de `com`, `net`, `org`, `co` com ou sem país, ou só do país:
    "yahoo.com.ar", "outlook.pt", "ibest.com.ar"). Um domínio de empresa que só começa igual
    ("mail.empresa.com.br", "r7.ind.br") **não** é webmail. Um lead só com e-mail de webmail não
    tem o que pesquisar: nenhuma chamada, nenhum gasto;
  - o nome da empresa e o Instagram são descartados se parecem contato de pessoa: um e-mail
    (também "(at)") ou 8 ou mais dígitos com só separadores entre eles ("(11) 9 1234-5678",
    "123.456.789-09", "11912345678"). O teste roda no texto inteiro, antes de cortar em 120
    caracteres;
  - um "nome da empresa" igual ao nome da pessoa é descartado (comparado, nunca enviado); um nome
    que só contém o da pessoa ("Ana Souza Alimentos") segue;
  - o site só vai se é endereço público (nunca IP, nunca porta que o navegador recusa) e é
    cortado no endereço, sem caminho nem parâmetros.
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

- **`fields`**: cada campo com `value` e **`sourceUrl`**, a página que diz aquilo, ou, se a busca
  não trouxe, `value: null` e o `reason`. O modelo tem de indicar, para cada dado, uma das páginas
  que a busca devolveu (`source`); o worker só guarda o dado se esse endereço é mesmo uma delas
  (`sourceOfField`, aceitando outra grafia do mesmo endereço: maiúsculas, "www.", barra no fim) e
  grava o endereço da própria busca. Dado sem página vira `null` com o motivo "Nenhuma das páginas
  encontradas foi indicada como fonte deste dado". A tela mostra cada dado com "Fonte: <site>"
  (link para a página) e "—" com o motivo para o resto. Pesquisas gravadas antes de a fonte por dado
  chegar ao staging (14/10/2026 20:53Z; a pesquisa ficou desligada de 17:26 UTC até lá) não têm
  `sourceUrl`: os valores delas aparecem como "—" ("Sem a página que sustenta este dado"). Nada é
  completado por suposição. **Essas podem ser refeitas** (ver "Rodar de novo não paga de novo").
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

**Só lead novo.** O worker só pesquisa lead que chegou a partir da data de corte
(`LEAD_RESEARCH_SINCE`, padrão `2026-10-14`, 00:00 de São Paulo). Vale a mais antiga entre a
criação no Wings e a data de entrada (`entered_at`): um negócio antigo do RD importado hoje é
antigo. Um lead anterior ao corte que converte de novo (Meta, Google, TikTok, webhook do RD, link
rastreado) passa pelo `enrich_lead`, mas a pesquisa fica `skipped` com o motivo "Lead anterior a
14/10/2026…", sem chamada e sem gasto (ledger `skipped`, `before_cutoff`). O mesmo vale para
"Pesquisar de novo" num lead antigo.

**Clique duplo não paga duas vezes.** `enqueueResearch` marca o lead como `pending` com uma
atualização condicional (só se não está `pending` nem `running`) antes de criar o trabalho, na
mesma transação: dois pedidos ao mesmo tempo criam **um** trabalho; o outro recebe 409
`research_in_progress`.

**Rodar de novo não paga de novo.** Um resultado `done` com páginas fica: "Pesquisar de novo"
(que refaz os outros passos do `enrich_lead`) não chama o OpenRouter outra vez, não gasta e não
troca o resultado por uma recusa ou falha. O mesmo vale com o provedor desligado. Só um resultado
sem páginas, `refused`, `failed` ou `skipped` é tentado de novo.

**A exceção: o formato antigo.** Um `done` com páginas, com algum valor, mas **sem `sourceUrl` em
nenhum campo** (`isLegacyWebResearch`, em `packages/shared`; as feitas antes da fonte por dado) mostra
"—" em tudo, e nada diz qual página sustenta qual valor: só perguntar de novo resolve. Um resultado
antigo em que todos os valores já eram "sem dado" não tem o que recuperar e não conta.

- **Na ficha:** uma explicação e, para quem tem `leads.write` e um lead **de 14/10 em diante**
  (`arrivedFromResearchCutoff`, a mesma regra do worker, pela data mais antiga entre criação e entrada),
  o botão **"Pesquisar de novo (cerca de US$ 0,01)"**: é uma nova pesquisa paga, por isso é um clique,
  não automático. Para lead anterior ao corte a ficha diz que ele chegou antes de 14/10/2026 e **não
  oferece o botão** (a regra do corte vale e o worker recusaria). O botão fica desabilitado enquanto
  a pesquisa está na fila e volta quando o lead sai dela.
- **No worker:** refaz **só a pesquisa**, e só com o provedor ligado e o lead dentro do corte. As buscas
  pagas da Brave e a do CNPJ **não se repetem**, e os links e a empresa que a primeira rodada achou
  ficam como estavam (o que foi pago na primeira vez não é pago de novo). Reserva sob o teto do dia (o
  `detail` da reserva leva `redo: legacy_format`), chama uma vez e troca o resultado pelo novo, que já
  traz as páginas e portanto não é refeito.
- **O resultado antigo fica** (nada de recusa, falha ou "nada foi guardado" no lugar dele) se a nova
  pesquisa for recusada pelo teto, falhar, não achar dado da empresa ou não trouxer nenhuma página; o
  passo do trabalho diz o que houve. Lead anterior ao corte mantém o resultado antigo (ledger
  `skipped`, `legacy_before_cutoff`).
- **Custo:** uma pesquisa (cerca de US$ 0,012) por lead de formato antigo, porque o resultado antigo
  não guardou a ligação valor→página e ela não se deduz sem perguntar de novo. Uma refação que
  **falha depois de paga** deixa a reserva no ledger e o resultado continua no formato antigo: o
  próximo clique paga outra vez.

## Variáveis (worker; só nomes, valores no Coolify)

| Variável                     | Padrão                       | Para quê                                                                                                                                                           |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENROUTER_API_KEY`         | vazio                        | a chave do OpenRouter (a mesma da API). Sem ela, o passo é pulado.                                                                                                 |
| `LEAD_RESEARCH_ENABLED`      | desligado                    | só `true` liga. Sem isso nenhum gasto, mesmo com a chave.                                                                                                          |
| `LEAD_RESEARCH_DAILY_USD`    | 1                            | **teto do dia** só desta pesquisa (dia de São Paulo), maior que 0 e até 100.                                                                                       |
| `LEAD_RESEARCH_USD_PER_CALL` | 0,06                         | quanto uma pesquisa deve custar; reservado antes da chamada.                                                                                                       |
| `LEAD_RESEARCH_MODEL`        | `anthropic/claude-haiku-4.5` | `anthropic/claude-haiku-4.5` ou `anthropic/claude-sonnet-5`.                                                                                                       |
| `LEAD_RESEARCH_SINCE`        | `2026-10-14`                 | data de corte (AAAA-MM-DD, São Paulo): só lead que chegou a partir dela. Um dia que não existe ("2026-02-30") **impede o worker de subir**, em vez de virar 02/03. |

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
  enfileiram um trabalho só (ver "Quando roda").
- **Custo medido** no staging (8 pesquisas reais, 09 a 12/10/2026): US$ 0,0113 a 0,0134 cada,
  cerca de US$ 0,012. O teto é em dólar, não em número de pesquisas: para cerca de 50 por dia,
  `LEAD_RESEARCH_DAILY_USD=0.65` (a reserva de US$ 0,06 da última pesquisa do dia precisa caber
  no teto).

## Logs

Só o formato (`worker: enrich_lead`, `msg: lead research`: nomes de chaves e números; texto vira
`string(N)`). Nunca a pergunta, a resposta, o nome da empresa nem uma fonte. O ledger guarda
contagens e códigos.

## Não verificado ao vivo

Feito pela referência do OpenRouter: o formato das anotações `url_citation`, o campo
`usage.cost` (e se ele já inclui a taxa da busca) e o preço da busca por resultado. O log de
formato mostra o que vier na primeira pesquisa real; se a taxa da busca não estiver no
`usage.cost`, o ledger fica abaixo do real e o `LEAD_RESEARCH_USD_PER_CALL` deve subir.
