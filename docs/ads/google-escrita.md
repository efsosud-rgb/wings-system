# Escrita no Google Ads — YouTube e Pesquisa (Onda 4)

19/09/2026. **Nada aqui foi escrito no Google.** O adaptador foi exercitado só
contra uma API do Google roteirizada (`platform/fake-google-api.ts`).
`ADS_WRITES_ENABLED` não foi tocada. A primeira escrita real é em produção, com
o aprovador presente.

## O que mudou no plano: YouTube é Demand Gen

A API do Google Ads **não cria nem altera campanha do tipo `VIDEO`** — só
relatório ([documentação](https://developers.google.com/google-ads/api/docs/video/overview)).
O que ela oferece para vídeo no YouTube é **Demand Gen**, o mesmo tipo da
"Campanha de youtube" que já existe na conta. Decidido em 19/09/2026: a opção
"YouTube" do construtor cria uma Demand Gen **restrita ao YouTube**.

Consequência que o aprovador precisa saber: em Demand Gen, **localização,
idioma e o controle de canais (só YouTube) ficam no grupo de anúncios**, não na
campanha. Como o grupo é da onda seguinte, a casca do YouTube é **campanha +
orçamento**; região, idioma e "só YouTube" ficam gravados no rascunho aprovado
e a tela de aprovação diz isso.

## Regras — as mesmas da Meta

| Regra                                   | Onde                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Nasce sempre **PAUSADA**                | esquema do rascunho **e** o cliente (recusa sem chamar)                                            |
| Só a casca                              | o cliente não sabe criar grupo, anúncio nem palavra-chave                                          |
| Nunca toca em campanha existente        | `setDailyBudget`/`pause`/`resume` recusam sem chamar o Google; `reserveChange` recusa conta Google |
| Mesmo portão de aprovação               | `POST /ads/campaign-requests` → `gateChange`; só `ads.approve` decide                              |
| Budget-guard                            | `reserveCampaignCreation`: trava, período travado, três tetos                                      |
| `wrong_account`, `reconciliation_stale` | o executor, sem mudança                                                                            |
| `ADS_WRITES_ENABLED` governa            | `createGooglePlatformClient`: sem a flag, o cliente é leitor                                       |
| Sem automação de verba                  | pedido sempre de uma pessoa; um clique por escrita                                                 |

### Uma diferença deliberada no budget-guard

Campanha pausada reserva **zero**, como na Meta. Mas uma casca pausada no
Google pode ser ligada por qualquer pessoa com acesso ao Google Ads, fora do
sistema. Por isso o pedido é **julgado como se a campanha estivesse ativa**:
`verba × dias neste mês × 2,0` precisa caber na parcela utilizável, no teto e
no **saldo pré-pago** (`platform_limit_would_be_exceeded`). Passando, a reserva
gravada continua zero.

## O que é escrito

**Um POST**, `customers/4268586278/googleAds:mutate`, atômico
(`partialFailure: false`), com ids temporários: ou tudo entra, ou nada — um
resultado desconhecido deixa uma coisa só para procurar, e nunca um orçamento
órfão. Sem `login-customer-id` (há teste travando isso).

- `campaignBudget`: diário, em micros (`centavos × 10.000`), `STANDARD`,
  **não compartilhado** (1:1 com a campanha, para a exposição não contar duas
  vezes).
- `campaign`: `status: PAUSED`, `advertisingChannelType` `SEARCH` ou
  `DEMAND_GEN`, `startDate`/`endDate`, `containsEuPoliticalAdvertising:
DOES_NOT_CONTAIN_…` (obrigatório desde a v21), lance `maximizeConversions`
  (lead, conversão) ou `targetSpend` (tráfego). O nome é exatamente o digitado;
  o orçamento chama `<nome> · orçamento`.
- **Só Pesquisa:** `networkSettings` só com a Pesquisa do Google (sem parceiros
  nem Display), `positiveGeoTargetType: PRESENCE`, um `campaignCriterion` por
  estado/cidade e um de idioma (português, `languageConstants/1014`).

Guardado no rascunho e **não enviado**: link do vídeo e título (YouTube);
palavras-chave, negativas, títulos e descrições (Pesquisa).

### Estados e cidades → geo target constants

Resolvidos na hora da execução, por leitura (`FROM geo_target_constant`, a
mesma `googleAds:search` já verificada ao vivo), com cache no cliente. Uma
cidade precisa casar com **exatamente uma** constante, pelo nome, dentro do
estado escolhido; nenhuma ou mais de uma é recusa (`geo_unresolved`) **sem
nada enviado** — mirar na Campinas errada não é algo para descobrir depois. O
que foi resolvido fica guardado na execução (`platform_response.locations`).

## A conta Google passou a ser reconciliada

Pré-requisito que não estava no pedido: o executor recusa
`reconciliation_stale` para conta nunca reconciliada, e nada reconciliava o
Google (a ingestão só lia o saldo). Agora `GoogleAdsPlatformClient` implementa
a mesma interface de leitura e a conta Google entra no mesmo ciclo da Meta:
campanhas e orçamentos espelhados em `ad_campaigns`, gasto por dia, métricas no
nível de campanha, saldo pré-pago como teto de plataforma. É por aí que uma
campanha criada "aparece no Relatório de campanhas na próxima ingestão".

Decisões tomadas aqui — revisar se discordar:

- **Fator de sobreentrega 2,0×** para o Google (teto contratual; o observado na
  conta foi 1,35×). Proposto no spike, agora em uso.
- **Saldo pré-pago baixo não congela a conta.** Na Meta, orçamentos acima do
  permitido acionam a trava, e o permitido inclui o `spend_cap`. Num pré-pago o
  saldo viver abaixo da exposição do mês é o estado normal (recarga por Pix);
  ele continua barrando **cada pedido novo** e continua registrado, mas a trava
  "orçamentos excedem o plano" do Google compara só com o teto interno.
- **Orçamento compartilhado conta uma vez**, na campanha ativa que o usa.
- Conversões do Google entram como `lead` (só `form_submit` dispara na conta).
- Anúncios, grupos e P-max (`asset_group`) **não** são espelhados ainda.

> ⚠️ **Efeito no primeiro ciclo em produção:** a campanha ativa "Search - Wings
>
> - Geral" (R$ 30/dia) passa a contar `30 × dias restantes × 2`. Em 19/09 isso
> dá R$ 720, dentro dos R$ 1.050 utilizáveis. Se alguém ligar no Google Ads as
> campanhas pausadas de R$ 50–56/dia, a soma passa do plano e **a conta Google
>   congela** (só o nosso sistema; nada pausa no Google) — é o desenho, igual ao
>   da Meta, mas agora vale para o Google também.

## Não verificado — a primeira escrita responde

- [ ] O `googleAds:mutate` em si: nunca foi chamado. Campos conferidos na
      documentação da v22, não na conta.
- [ ] `geo_target_constant` via GAQL com `name LIKE` e os nomes dos 27 estados
      como o Google os escreve (a tabela `STATE_NAMES` é a aposta; um estado
      que não casar vira recusa, não palpite).
- [ ] Demand Gen aceita campanha sem grupo de anúncios e com `targetSpend`?
      Orçamento mínimo de Demand Gen na conta?
- [ ] O nível de acesso do developer token (Exploração) permite `mutate`?
- [ ] **A v22 está perto do fim de vida** (a documentação já está na v25). Na
      v23 `startDate`/`endDate` viram `startDateTime`/`endDateTime`; está
      isolado em `campaignDates()`. Subir de versão é uma tarefa própria, com
      releitura do spike.

Sugestão para antes do primeiro clique: o Google aceita `validateOnly: true`
no mesmo `mutate` — valida tudo na conta real **sem escrever**. Não foi
construído; seria um `ops-cli preflight-google`.

## Onda seguinte

1. Grupo de anúncios: Pesquisa (palavras-chave e negativas do rascunho, anúncio
   responsivo com os títulos e descrições) e Demand Gen (localização, idioma,
   `channel_controls` só YouTube, anúncio com o vídeo).
2. `validateOnly` como preflight.
3. `resolve-unknown` para o Google procura pelo nome, como na Meta — conferir
   num caso real.
4. Apagar/remover campanha de teste (não existe em nenhuma plataforma).
5. Migração da API para v23+.
6. Espelhar anúncios, reprovações e P-max; alerta de saldo pré-pago baixo.
