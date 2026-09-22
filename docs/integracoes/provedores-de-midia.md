# Provedores de mídia

O sub-módulo Marketing → Edição de Fotos e Vídeos gera imagens e vídeos por
mais de um serviço. O Kairogen foi o primeiro ([kairogen.md](kairogen.md)) e
continua fazendo exatamente o que fazia; os outros entram atrás do mesmo
contrato, e a regra é uma só para todos:

> **Nada gera sem clique, e o custo aparece antes do clique — R$ 0 também.**
> Segredos só por variável de ambiente. Nenhum teste chama um serviço real.

| Provedor                                                 | Cobrança                        | Faz                                   | Verificado com geração real |
| -------------------------------------------------------- | ------------------------------- | ------------------------------------- | --------------------------- |
| Kairogen ([doc](kairogen.md))                            | créditos do mês (plano)         | imagem, vídeo, animar, ampliar        | sim (imagem)                |
| Cloudflare Workers AI ([doc](cloudflare-workers-ai.md))  | grátis, cota do dia local       | imagem (FLUX.1 schnell)               | **não**                     |
| Gemini ([doc](gemini.md))                                | grátis, cota por minuto e dia   | imagem, editar imagem                 | **não**                     |
| Higgsfield ([doc](higgsfield.md))                        | por uso, em dólar               | imagem (Soul), imagem→vídeo (DoP)     | **não**                     |
| MoneyPrinterTurbo ([doc](moneyprinterturbo.md))          | serviço nosso, R$ 0             | vídeo curto "sem câmera"              | **não**                     |

"Não verificado" quer dizer: o formato dos pedidos e das respostas veio da
documentação pública, que é incompleta, e o leitor é tolerante (procura os
campos por nome, em qualquer profundidade). A primeira geração real de cada
um grava a **forma** da resposta no log da API (`provider answer shape`, só
nomes de chaves, tipos e números; nenhuma string) e é daí que o adaptador
será acertado. A tela e o agente avisam "ainda não verificado" enquanto isso.

## A interface

`apps/api/src/modules/media/providers/types.ts`. Cada provedor implementa:

| Método                    | O que é                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `capabilities`            | `generate_image`, `generate_video`, `animate`, `upscale`                                 |
| `billing`                 | `free_quota`, `own_service`, `credits`, `per_use` — decide a ordem do failover           |
| `configured`              | as variáveis dele estão no ambiente (nunca o valor delas)                                |
| `availability(need)`      | pode atender agora, para N saídas: conectado, com cota, com saldo; senão, o motivo       |
| `balance()` / `quota()`   | o que a conta tem (créditos, dólares, reais) ou o que a cota local ainda permite         |
| `listModels()`            | os modelos, com `brlCentsPerOutput` (0 quando grátis) e `creditsPerOutput` no Kairogen   |
| `estimate(request)`       | o custo: `credits`, `brlCents` e os `priceArgs` guardados com a estimativa. É leitura    |
| `start(input)`            | **a única chamada que gasta.** Vai uma vez; timeout é `outcome_unknown`, nunca repetição |
| `poll(externalId)`        | como está um trabalho que ficou rodando lá. Leitura                                      |

Um provedor nunca decide gerar, nunca repete uma chamada que pode ter custado
algo, nunca vê o nome de um cliente (`client_id` não faz parte de pedido
nenhum), e o que ele responde é **dado**: lido por nome de campo, logado como
forma, nunca obedecido. O registro (`providers/index.ts`) monta a lista pelo
ambiente; provedor sem variável aparece como "sem chave" e não oferece modelo.

Chaves de modelo são únicas entre provedores: as do Kairogen continuam como
eram (`seedream-v4`); as dos outros começam pelo id do provedor
(`cloudflare/flux-1-schnell`, `gemini/gemini-2.5-flash-image`,
`higgsfield/soul`, `higgsfield/dop`, `mpt/short-video`).

## A ordem das coisas, para todos

1. **Estimar.** `POST /media/estimates` acha o modelo no catálogo unificado,
   valida contra ele (formato, quantidade até `maxOutputs`, duração, parâmetros,
   uso da imagem), pergunta ao provedor se pode atender e quanto custa, e grava
   a linha em `media_generations` com `provider`, `credits_estimated` e
   `brl_cents_estimated`. Válida por 10 minutos.
2. **Clicar.** `POST /media/generations` só aceita o id da estimativa. O botão
   diz o preço: "Gerar (R$ 0,00)", "Gerar (4 créditos)", "Gerar (R$ 0,28)".
3. **Conferir tetos**, sob trava: os de créditos do Kairogen (diário por pessoa,
   mensal), o teto único em reais de todos os provedores, e, nos grátis, a cota
   do dia relida no próprio ledger para dois cliques não levarem a última.
4. **Ledger antes da chamada** (`started`: +estimado em créditos e em reais).
5. **Uma chamada.** Provedor que responde na hora (Cloudflare, Gemini) já
   entrega os bytes; provedor assíncrono (Kairogen, Higgsfield, MPT) devolve um
   id e o servidor acompanha com `poll`, em intervalo crescente, por até 20 min.
6. **Guardar.** Cada saída vira um arquivo no Drive e uma linha em
   `media_assets` com `origin` = id do provedor e `generation_id` = a nossa
   geração (o provedor síncrono não tem id externo).

Estados e o que acontece de errado são os mesmos da tabela em
[kairogen.md](kairogen.md#o-que-acontece-quando-dá-errado): `refused` devolve o
estimado, `unknown` mantém, `failed`/`succeeded` corrigem pela cobrança real
quando o provedor informa (`brl_cents_charged`).

## Roteamento com failover

Ordem: **grátis com cota → Kairogen (créditos do mês) → Higgsfield (por uso)**.
O serviço próprio (MPT) conta como grátis.

A troca acontece **na estimativa**, antes do preço aparecer — nunca depois do
clique, para que o que é gerado seja sempre o que foi precificado:

- O provedor pedido **não pode atender** (sem chave, desconectado, cota do dia
  esgotada, créditos do mês acabaram, saldo zero, serviço fora)?
  - Existe outro modelo, em outro provedor, que faz a mesma coisa (mesmo tipo,
    mesmo formato, mesmo uso da imagem, mesma duração, quantidade que cabe) e
    custa **o mesmo ou menos** (por faixa de cobrança e depois por reais por
    saída)? Vai para ele **sozinho**. A estimativa volta com `routedFrom`
    (modelo, provedor e motivo) e um aviso: "Kairogen não pôde atender: …. Foi
    para FLUX.1 schnell (Cloudflare Workers AI), por R$ 0,00."
  - Só existe alternativa **mais cara**? A estimativa é recusada
    (`409 provider_unavailable`) e leva `alternative` (modelo, provedor, preço).
    A tela oferece "Usar Higgsfield Soul (Higgsfield, R$ 0,28)": o clique da
    pessoa troca o modelo e estima de novo. Subir de preço é sempre um clique.
  - Não existe alternativa? Recusa com o motivo.
- O provedor pedido pode atender? Fica nele. Escolher o Kairogen com a
  Cloudflare grátis ao lado é uma escolha da pessoa; o sistema não troca
  quem pode atender. Quem prefere o mais barato é o agente.

**Mesmo modelo dentro da mesma campanha.** A estimativa leva `campaign` (o nome
da campanha aberta no construtor, quando há) e o cliente. Se a última mídia do
mesmo tipo para a mesma campanha (ou, sem campanha, para o mesmo cliente) foi
feita com outro modelo, a estimativa avisa: "A campanha "X" já tem imagem feita
com seedream-v4 (Kairogen). Misturar modelos muda o estilo das peças". É aviso,
não bloqueio.

## Ledger em reais e o teto único

`media_credit_ledger` ganhou `provider`, `brl_cents_estimated`,
`brl_cents_delta` e `brl_cents_charged`, ao lado das colunas de créditos, que
continuam valendo só para o Kairogen. Continua **só de inserção**.

- Grátis e serviço próprio: R$ 0 em todas as linhas. A cota do dia é a soma de
  `quantity` das linhas `started` do provedor no dia (São Paulo); no Gemini,
  também no último minuto.
- Higgsfield: `HIGGSFIELD_USD_PER_IMAGE` × quantidade, ou
  `HIGGSFIELD_USD_PER_VIDEO_SECOND` × duração, vezes `BRL_PER_USD`,
  arredondado para cima. Quando a resposta informa um custo (`cost_usd`,
  `cost`, `price`…), a linha final corrige pela diferença.
- Kairogen: créditos × `KAIROGEN_BRL_PER_CREDIT`. O padrão é **0**: os
  créditos do mês já estão pagos no plano, e sobre eles valem os tetos em
  créditos. Informe o valor do crédito se quiser que o Kairogen conte no teto
  em reais.

`MEDIA_MONTHLY_BRL` (padrão 300) é a soma de `brl_cents_delta` do mês, de
todos os provedores. Estourar recusa com a conta na frase: "O teto mensal de
R$ 300,00 em mídia seria ultrapassado: R$ 299,80 já contados este mês e esta
geração custa R$ 0,28". Uma geração de R$ 0 passa com o teto batido: o teto é
sobre dinheiro.

## Tela

- **Seletor de modelo** agrupado por provedor, na ordem do failover. O grupo
  diz o que o provedor tem ("Cloudflare Workers AI · 12 de 50 hoje", "Kairogen
  · 94 créditos", "Higgsfield · US$ 12,50 (R$ 68,75)") ou por que não atende.
  Cada modelo diz o custo por saída: "R$ 0 (grátis)", "4 créditos por saída",
  "≈ R$ 0,28 por saída", "custo na estimativa".
- **Estimativa**: "Custo: R$ 0,00 · Cloudflare Workers AI" e o botão "Gerar
  (R$ 0,00)". Avisos (roteado, não verificado, mistura de modelos, teto) numa
  lista abaixo. Alternativa mais cara vira um botão.
- **Cabeçalho**: além do saldo e dos tetos do Kairogen, "Todos os provedores no
  mês: R$ x de R$ 300,00" e uma faixa com um chip por provedor.
- **Administração → Integrações**: o cartão do Kairogen como era, e abaixo um
  cartão por provedor de ambiente: chave presente ou ausente, disponível ou o
  motivo, cota do dia ou saldo, gasto do mês, e a nota de "não verificado".
- **Progresso e biblioteca**: "Gerando no Gemini", "Recusada pelo provedor",
  filtro "Geradas na Cloudflare", legenda com o provedor.

## Agente de Edição

Ferramenta nova `listar_provedores` (como cobra, o que faz, disponível e por
quê, saldo, cota, gasto do mês). `listar_modelos` traz `provedor`,
`reais_por_saida`, `gratis` e `maximo_por_geracao`, do mais barato ao mais
caro. `consultar_saldo` traz o gasto do mês em reais contra o teto.
`propor_geracao` exige `provider`, conferido contra o modelo (proposta com
provedor errado volta para o modelo com o valor certo). O cartão diz o
provedor e o preço no botão. O prompt do agente manda escolher o mais barato
que atende e explicar por quê, e usar o mesmo modelo dentro de uma campanha.

## Variáveis de ambiente (só nomes)

| Variável                          | Padrão | Para quê                                                        |
| --------------------------------- | ------ | --------------------------------------------------------------- |
| `CF_ACCOUNT_ID`                   | —      | Cloudflare: id da conta                                         |
| `CF_WORKERS_AI_TOKEN`             | —      | Cloudflare: token de API com Workers AI                         |
| `CF_WORKERS_AI_DAILY_IMAGES`      | 50     | Cloudflare: cota local de imagens por dia                       |
| `GEMINI_API_KEY`                  | —      | Gemini: chave da API                                            |
| `GEMINI_DAILY_IMAGES`             | 50     | Gemini: cota local por dia                                      |
| `GEMINI_IMAGES_PER_MINUTE`        | 5      | Gemini: cota local por minuto                                   |
| `HIGGSFIELD_API_KEY`              | —      | Higgsfield: chave                                               |
| `HIGGSFIELD_API_SECRET`           | —      | Higgsfield: segredo, se a conta tiver um                        |
| `HIGGSFIELD_USD_PER_IMAGE`        | 0.05   | Higgsfield: custo esperado de uma imagem, em dólar              |
| `HIGGSFIELD_USD_PER_VIDEO_SECOND` | 0.10   | Higgsfield: custo esperado por segundo de vídeo, em dólar       |
| `MPT_BASE_URL`                    | —      | MoneyPrinterTurbo: endereço do serviço nosso                    |
| `MPT_API_KEY`                     | —      | MoneyPrinterTurbo: bearer, se o serviço estiver atrás de um     |
| `BRL_PER_USD`                     | 5.5    | conversão de dólar para o ledger                                |
| `MEDIA_MONTHLY_BRL`               | 300    | teto mensal em reais, todos os provedores                       |
| `KAIROGEN_BRL_PER_CREDIT`         | 0      | reais por crédito do Kairogen, para o teto em reais             |

Os valores ficam no Coolify, em `wings-api-staging` e `wings-api`. Nenhum
entra em resposta, log ou resultado de ferramenta (há teste procurando por
eles).

## Migração

`0026_media_providers`: valores novos no enum `media_origin` (`cloudflare`,
`gemini`, `higgsfield`, `mpt`), `provider`/`brl_cents_*`/`campaign`/
`routed_from` em `media_generations`, `provider`/`brl_cents_*` em
`media_credit_ledger`, `generation_id` em `media_assets`. Linhas antigas ficam
com `provider = 'kairogen'` e R$ 0. Só colunas em tabelas que o `wings_ro`
já lê.

## Testes

`apps/api/src/modules/media/providers.test.ts`, com os quatro serviços
falsos em `providers/fake-providers.ts` (um `fetch` só, separado por host).
Cobre: registro e chaves nunca nas respostas; Cloudflare (R$ 0, geração na
mesma chamada, cota, queda de conexão → `unknown` sem reenvio, resposta em
bytes crus, formato recusado); Gemini (formato, imagem inline para editar,
cota por minuto, recusa em palavras); Higgsfield (dólar → real, acompanhamento,
correção pela cobrança real, primeiro quadro por link assinado, `unknown`);
MPT (R$ 0, tarefa acompanhada, arquivo baixado só do próprio serviço, fora do
ar); roteamento (desce sozinho, sobe só por clique, teto em reais com a conta
na frase, aviso de mistura por campanha); agente (`listar_provedores`,
provedor conferido contra o modelo, cartão com provedor e preço).
