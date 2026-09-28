# Escrita no Google Ads — YouTube e Pesquisa (Onda 4, revista em 25/09/2026)

19/09/2026. **Nada aqui foi escrito no Google.** O adaptador foi exercitado só
contra uma API do Google roteirizada (`platform/fake-google-api.ts`).
`ADS_WRITES_ENABLED` não foi tocada. A primeira escrita real é em produção, com
o aprovador presente.

> **25/09/2026 — Pesquisa completa, preflight e alterações.** Ver a seção
> "Pesquisa de ponta a ponta (25/09/2026)" no fim: a campanha de Pesquisa nasce
> com grupo de anúncios, palavras-chave (exata e frase), negativas e anúncio
> responsivo, tudo pausado, numa escrita atômica; o executor valida com
> `validateOnly` antes de escrever; orçamento, pausa e retomada em campanhas do
> Google passaram a existir pelo mesmo fluxo de aprovação. O que este arquivo
> diz sobre "só a casca" e "o cliente não sabe criar grupo" vale até essa data.

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
`verba × dias neste mês × 1,0` — e nunca menos que um dia a 2,0× — precisa
caber na parcela utilizável, no teto e no **saldo pré-pago** (`platform_limit_would_be_exceeded`). Passando, a reserva
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
  estado/cidade, **um por raio do mapa** (`proximity`, ver abaixo) e um de
  idioma (português, `languageConstants/1014`).

Guardado no rascunho e **não enviado**: link do vídeo e título (YouTube);
palavras-chave, negativas, títulos e descrições (Pesquisa).

### Estados e cidades → geo target constants

Resolvidos na hora da execução, por leitura (`FROM geo_target_constant`, a
mesma `googleAds:search` já verificada ao vivo), com cache no cliente. Uma
cidade precisa casar com **exatamente uma** constante, pelo nome, dentro do
estado escolhido; nenhuma ou mais de uma é recusa (`geo_unresolved`) **sem
nada enviado** — mirar na Campinas errada não é algo para descobrir depois. O
que foi resolvido fica guardado na execução (`platform_response.locations`).

### Raio no mapa → critério de proximidade (21/09/2026)

O rascunho tem **uma** estrutura de alcance para todas as plataformas —
`reach: { states, cities, customLocations }` — e cada adaptador a traduz. No
Google o tradutor é `googleLocationCriteria` (`google-ads-client.ts`): cada raio
vira um `campaignCriterion` com

```
proximity: {
  geoPoint: { latitudeInMicroDegrees, longitudeInMicroDegrees },  // graus × 1.000.000, inteiros
  radius: <km>,
  radiusUnits: 'KILOMETERS'
}
```

no **mesmo `mutate` atômico**, ao lado dos critérios de estado e cidade — o
Google alcança a união deles, o mesmo sentido que o alcance misto tem na Meta.
Um alcance só de raios não consulta `geo_target_constant`. O nome do ponto
("Campinas, São Paulo") é para pessoas e **não é enviado**. Os raios enviados
ficam na execução (`platform_response.radii`). Os limites do construtor (1 a
80 km, até 5 pontos) são os da Meta e cabem com folga nos do Google (até 800 km).

**YouTube (Demand Gen):** o rascunho aceita o raio, mas — como estados e
cidades — ele **fica guardado e não é enviado**: Demand Gen recebe localização
no grupo de anúncios, que o sistema ainda não cria. Quando criar, o tradutor é
o mesmo.

TikTok e LinkedIn já estão no contrato (`PLATFORM_REACH` em
`packages/shared`): não aceitam raio, o construtor mostra o mapa desabilitado
com "Esta plataforma não aceita raio: use estados e cidades" e o esquema do
rascunho recusa (`reachRefusal`). Falta a cada uma só o próprio tradutor.

## A conta Google passou a ser reconciliada

Pré-requisito que não estava no pedido: o executor recusa
`reconciliation_stale` para conta nunca reconciliada, e nada reconciliava o
Google (a ingestão só lia o saldo). Agora `GoogleAdsPlatformClient` implementa
a mesma interface de leitura e a conta Google entra no mesmo ciclo da Meta:
campanhas e orçamentos espelhados em `ad_campaigns`, gasto por dia, métricas no
nível de campanha, saldo pré-pago como teto de plataforma. É por aí que uma
campanha criada "aparece no Relatório de campanhas na próxima ingestão".

Decisões tomadas aqui — revisar se discordar:

- **Dois fatores de sobreentrega** para o Google: 2,0× é o limite de **um dia**
  (teto contratual; o observado na conta foi 1,35×) e só decide a checagem de um
  único dia; o comprometido do mês e a exposição de um pedido usam **1,0×**
  (no mês o Google não cobra além de 30,4 × a verba diária). Corrigido em
  21/09/2026 — ver "Google: dois fatores de sobreentrega" em `tetos-reais.md`.
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
- [ ] Critério `proximity` (raio): nomes de campo conferidos na documentação,
      nunca enviados. Conferir também que `PRESENCE` vale para o raio como vale
      para estado/cidade, e como o Google Ads mostra o raio na campanha criada.
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

## Pesquisa de ponta a ponta (25/09/2026)

Construído para o lançamento de uma campanha de Pesquisa **pelo sistema**, com
a Diretoria, no staging (que neste mês é o ambiente de uso real do agente).
Exercitado só contra a API roteirizada; **nada foi escrito no Google** nesta
onda. O que foi feito contra a conta real foi um `validateOnly` (ver abaixo).

### O que muda no rascunho (`packages/shared`)

- **Palavras-chave com correspondência, na notação do próprio Google:**
  `[exata]` ou `"frase"`. Um termo sem marca seria correspondência **ampla** e
  o esquema **recusa** ("Ampla não é aceita"). No construtor, um seletor diz
  qual correspondência as linhas sem marca recebem (padrão: exata); uma
  proposta do agente com `broad` é apertada para exata antes de entrar no
  formulário. `parseSearchKeyword`/`formatSearchKeyword` são a única leitura.
- **Negativas** continuam termos simples e vão para a **campanha** em
  correspondência de **frase**, para valer em qualquer grupo criado à mão.
- **Anúncio responsivo:** 3 a 15 títulos (30 caracteres), 2 a 4 descrições
  (90), sem repetidos — os mínimos são os que o Google exige.
- **`adGroupName`** (opcional): o único grupo da campanha; em branco, usa o nome
  da campanha.

Não havia rascunho de Pesquisa gravado em staging, então a mudança de forma
não afeta nenhum hash de aprovação existente.

### A escrita: uma só, atômica, tudo pausado

`googleAds:mutate` com `partialFailure: false` e ids temporários, na ordem:

1. `campaignBudget` (-1) · 2. `campaign` (-2, `PAUSED`, só rede de pesquisa,
   presença) · 3. critérios de localização, raio e idioma · 4. **negativas**
   (`campaignCriterion` com `negative: true`, `keyword.matchType: PHRASE`) ·
5. **`adGroup`** (-3, `PAUSED`, `SEARCH_STANDARD`) · 6. **palavras-chave**
   (`adGroupCriterion`, `EXACT`/`PHRASE`, `ENABLED` dentro do grupo pausado) ·
7. **anúncio** (`adGroupAd`, `PAUSED`, `responsiveSearchAd` com `finalUrls` =
   destino com UTMs).

Ou entra tudo, ou nada: não existe "campanha sem anúncio" nem "orçamento órfão"
a procurar. A resposta é lida operação por operação e cada objeto vira um passo
em `ad_execution_steps` (`ad_group`, `keyword`, `negative_keyword`, `ad`), com
o id do Google — a tela de aprovação mostra "O que foi criado no Google".

**Campanha, grupo e anúncio nascem pausados**, como manda o não-negociável.
Por isso **retomar** (`resume_campaign`) no Google liga, no mesmo `mutate`, a
campanha **e** os grupos e anúncios que o sistema criou pausados sob ela
(lidos de `ad_execution_steps`, `companionsOf`) — nunca algo feito à mão no
Google Ads. Pausar toca só a campanha (uma campanha pausada não entrega).

### Preflight: `validateOnly` antes de qualquer escrita

O Google aceita a mesma solicitação com `validateOnly: true`: a conta real
confere cada campo, limite e política de escrita, **sem criar nem alterar**.

- **O executor faz isso sozinho**, antes de toda escrita no Google
  (`canPreflight`/`validateWrite`, garantia 8 do `executor.ts`): recusa do
  Google na validação vira **rejeição** (execução gravada com `preflight:
true`, reserva devolvida, `ads.change_rejected_by_platform`), com **nada
  enviado**; Google sem resposta vira recusa `platform_unavailable`, sem tocar
  no pedido e sem congelar a conta (nada pode ter acontecido).
- **A tela de aprovação tem o botão "Validar no Google (sem escrever)"**
  (`POST /ads/approvals/:id/preflight`, permissão `ads.request`), antes ou
  depois da decisão, **com a chave de escrita desligada** — o cliente usado é
  sempre um leitor, e o transporte do leitor recusa qualquer `mutate` que não
  seja `validateOnly`. Cada validação entra na trilha (`ads.preflight`).
- **`ops-cli preflight-google --approval <uuid>`** faz o mesmo no terminal, e
  **`--example`** valida uma campanha de exemplo embutida, para um ensaio
  antes de existir pedido.

A mensagem de recusa traz o campo apontado pelo Google
(`mutate_operations[7].ad_group_ad_operation.create.ad…headlines[1]: …`).

### Orçamento, pausa e retomada em campanhas do Google

`reserveChange` aceita contas Google (antes recusava
`not_supported_on_platform`). A regra é a da Meta: pedido de uma pessoa →
WhatsApp → aprovação (`ads.approve`) → clique → auditoria, com hash do payload,
trava de emergência, `wrong_account`, janela de reconciliação de 120 min e os
três tetos. Na tela da criação executada há "Próximos pedidos sobre esta
campanha" (ativar, novo orçamento, pausar), que chama
`POST /ads/change-requests`; o `ops-cli request` também serve. Os cartões do
agente para campanhas do Google passaram a ter botão (negativação continua
manual).

No adaptador: orçamento é `campaignBudgetOperation.update` com
`updateMask: amount_micros` no orçamento **próprio** da campanha — um
orçamento **compartilhado** é recusado (`google_shared_budget`) sem chamar o
Google, porque mudaria outras campanhas; status é `campaignOperation.update`
com `updateMask: status`.

### Não verificado — o ensaio de 25/09 e a primeira escrita respondem

- [ ] Todos os nomes de campo do grupo, das palavras-chave, das negativas e do
      anúncio responsivo (v22): conferidos na documentação, nunca enviados. O
      `validateOnly` contra a conta real é o que os confirma antes do clique.
- [ ] Se `validateOnly` cobre política de anúncio (texto reprovável) ou só
      forma — o Google documenta que valida "o que pode ser validado sem
      escrever"; reprovação por política pode aparecer só depois, na revisão.
- [ ] Orçamento diário mínimo da conta e `MONEY_AMOUNT_TOO_SMALL`.
- [ ] O status do anúncio depois da revisão do Google e o tempo até
      "Qualificado"; ligar a campanha antes disso não entrega até aprovar.
- [ ] `resume` com três atualizações num `mutate` (campanha, grupo, anúncio).

### Depois do ensaio (não construído)

Leitura de reprovações e P-max via `asset_group`; alerta
`account_out_of_funds`; pausa e negativas autônomas; guardrail explícito de
correspondência ampla (hoje o esquema simplesmente recusa).

### Rascunhos salvos e limites (25/09/2026, tarde)

- **Limites do construtor:** 20 palavras-chave e 50 negativas (eram 10 e 20).
  A campanha real de 25/09 leva 13 e 35; o `validateOnly` na conta real
  aceitou a solicitação inteira (54 operações) antes da mudança.
- **Rascunhos salvos** (`ad_campaign_saved_drafts`, migração 0038, com o
  GRANT para `wings_ro`): "Salvar rascunho" no construtor guarda o formulário
  validado, **sem pedido, sem aprovação, sem WhatsApp e sem reserva**; o bloco
  "Rascunhos salvos" no topo do construtor carrega um deles inteiro. Rotas
  `GET/POST/DELETE /ads/saved-drafts` (`ads.request`), auditadas
  (`ads.draft_saved`, `ads.draft_deleted`). No terminal,
  `ops-cli save-draft --file rascunho.json` faz o mesmo sem sessão.
- O rascunho da campanha de lançamento está em
  `docs/ads/rascunho-pesquisa-set26.json` (datas: hoje a +30 dias; ajustar na
  tela).

### Rede, local e lance no rascunho (25/09/2026, noite)

Até aqui o adaptador decidia sozinho: rede só Pesquisa, local `PRESENCE` e
lance `maximizeConversions` para lead/conversão (`targetSpend` só para
tráfego). Agora os três **estão no rascunho** (`search.network`,
`search.locationMode`, `search.bidding`, `search.maxCpcCents`), aparecem no
construtor, no cartão do agente, no resumo e na aprovação, entram no hash do
payload aprovado e no `validateOnly`. Padrões: só Pesquisa do Google (único
valor), presença, **maximizar cliques com CPC máximo R$ 6,00**
(`targetSpend.cpcBidCeilingMicros`). Maximizar conversões existe como opção,
mas não é o padrão enquanto a conversão da conta estiver contaminada.

O agente passou a preencher `search.adGroupName`, e para o Google **não
projeta leads pelo CPL histórico**: `desempenho_campanhas` marca as campanhas
do Google com `conversoes_verificadas: false` (as conversões vêm de um único
`form_submit` e incluem buscas de lixo, 17 de "google meu negócio" em 90 dias
lidos em 25/09), e a regra dos 10 leads/semana passou a valer só para a Meta.
A prévia do anúncio de Pesquisa mostra no máximo 3 títulos e 2 descrições,
como o Google.

### Correções à mão na campanha real (28/09/2026)

Pedidas por Eric e feitas por script no container da API, com `validateOnly`
antes e a campanha `24289782134` **pausada**: URL final do RSA
`200582882397~825987552936` → `/contato/?…utm_content=lead-v1`
(`adOperation.update final_urls`, o Google permite editar a URL sem recriar o
anúncio); negativa de campanha "meu negócio" removida
(`24289782134~488913784232`); fim da campanha 04/10 → 02/10
(`campaignOperation.update end_date`). Registradas na trilha da campanha como
`ads.manual_platform_change`. O sistema ainda não tem esses três tipos de
alteração no fluxo de aprovação.

### 28/09/2026: fim → 09/10, exposição da retomada e prova dos status

- Fim da campanha `24289782134` 02/10 → **09/10** pela API, `validateOnly`
  antes, registrado na trilha (`ads.manual_platform_change`); rascunho salvo
  idem.
- **Bug corrigido no guard e no simulador:** um pedido sobre campanha existente
  (retomar, orçamento) usava o fator da Meta (1,25×) em qualquer plataforma —
  a retomada de R$ 100/dia com 3 dias no mês reservou R$ 375; no Google o mês
  custa R$ 300 (1,0×), nunca menos que um dia a 2,0×. `reserveChange` e
  `simulateChange` passaram a usar `periodOverdeliveryFactor`/
  `dailyOverdeliveryFactor` da plataforma.
- **Retomada de 28/09 10:13:** o histórico de alterações do Google
  (`change_event`) mostra três atualizações às 10:13:13 pelo nosso usuário da
  API — campanha, grupo `200582882397` e anúncio `825987552936`, todos
  `status` — e nenhuma alteração pelo Google Ads web. O executor ligou os três;
  o que a tela do Google mostrou como pausado era estado antigo. Para isso não
  depender de confiança, a execução agora relê os status do grupo e do anúncio
  depois do `mutate` e os grava em `platform_response.statusesAfter`.

### 28/09/2026 (tarde): mais palavras, negativas, CPC R$ 10 e RSA novo

Na campanha ativa `24289782134`, pela API com `validateOnly` antes, num só
`mutate` atômico: 11 palavras-chave no grupo `200582882397`
(`[consultoria de franchising]` e dez em frase, incluindo as regionais
"consultoria de franquias rj" e "formatação de franquias rio de janeiro"); 5
negativas de campanha em frase (`franqueado`, `seja franqueado`, `franquia até
50 mil`, `quanto rende`, `como crescer minha empresa`; `sebrae` já existia);
CPC máximo do Maximizar cliques R$ 6 → **R$ 10**; e, como os títulos de um RSA
são imutáveis, um **RSA novo** `200582882397~826254020361` (ENABLED, em
revisão) igual ao antigo com "+1.400 Projetos de Franquia" no lugar de "+1.300
Marcas Formatadas" e "Ex-Diretor da ABF-RJ" no lugar de "Agende Sua Avaliação"
(o limite é 15 títulos; o dropado era redundante com "Avalie Seu Negócio"). O
RSA antigo `825987552936` fica ativo até o novo ser aprovado. Tudo na trilha
(`ads.manual_platform_change`) e no rascunho salvo (24 palavras, 40 negativas,
CPC R$ 10, títulos novos); o limite do construtor subiu para 30 palavras-chave.
