# Etapa Google 0 — spike (somente leitura)

Executado contra a conta real **4268586278 ("Wings")** em 2026-09-18, após o
nível de acesso da API ser elevado de **Teste** para **Exploração** no projeto
GCP `openclaw-traffic-508320`. Nenhum objeto foi criado, alterado ou gasto.

**As sete perguntas foram respondidas com dado real.** Nada neste documento
continua marcado como "não verificado".

## ⚠️ Achado urgente, antes de tudo

> **Restam R$ 20,76 de saldo pré-pago.** A única campanha ativa gastou
> R$ 33,13 ontem e R$ 40,40 anteontem. **A conta fica sem fundo em menos de um
> dia** e as campanhas param sozinhas.

Isso não é uma questão de projeto — é operacional e é para hoje. A conta de
pagamentos é "Wings" (`9891-4652-2694-7009`).

## Papéis das contas e como conectar

| Conta          | Papel                                                    |
| -------------- | -------------------------------------------------------- |
| **4268586278** | conta de anúncios real — "Wings", BRL, America/Sao_Paulo |
| **6693183441** | MCC Wings Company — onde vive o developer token          |

**O cabeçalho `login-customer-id` NÃO deve ser enviado.** Testado nas duas
formas, hoje:

```
SEM login-customer-id  -> 200 OK
COM login-customer-id=6693183441 -> 403 USER_PERMISSION_DENIED
```

O usuário Google que autorizou o token tem acesso **direto** à conta de
anúncios (`listAccessibleCustomers` devolve só ela) e **não é usuário da MCC**.
O cabeçalho só faz falta quando o acesso é _através_ do gerenciador — aqui ele
quebra a chamada. `GOOGLE_ADS_LOGIN_CUSTOMER_ID` fica no `.env` como
documentação, mas o cliente não deve usá-lo enquanto o acesso for direto.

### Correção do que estava documentado

O nível de acesso nunca foi "Acesso às Análises": era **Teste**, e é por isso
que o `ACTION_NOT_PERMITTED` persistiu mesmo depois da vinculação da Thais. A
Central de API do Google Ads exibe essa informação de forma obsoleta — a própria
tela avisa que os níveis passaram a ser gerenciados no Google Cloud Console.
**Conclusão para o futuro: conferir o nível no GCP, não na Central de API.**

## Conciliação com o painel ✅

Mesma janela que você leu na tela (19/08 → 15/09/2026):

| Métrica              | Painel   | API       | Bate?                 |
| -------------------- | -------- | --------- | --------------------- |
| Custo                | R$ 928   | R$ 928,47 | ✅                    |
| Cliques              | 327      | 327       | ✅                    |
| Impressões           | 2,11 mil | 2.108     | ✅ (painel arredonda) |
| CPC médio            | R$ 2,84  | R$ 2,84   | ✅                    |
| Pontuação otimização | 83,7%    | 0,8373014 | ✅                    |
| Campanhas            | 8        | 8         | ✅                    |

A API é fiel ao painel. Mesma barra de verificação da Etapa 3 na Meta.

## Pergunta 1 — o cliente lê dados reais ✅

Conta: `Wings`, moeda **BRL**, fuso **America/Sao_Paulo**, `status=ENABLED`,
`manager=false`, `test_account=false`. API **v22**. 8 campanhas, 8 orçamentos,
27 grupos de anúncios, 29 anúncios, 8 ações de conversão — tudo legível.

## Pergunta 2 — modelo de orçamento ✅ confirmado

**Orçamento só no nível de campanha.** A prova por rejeição:

```
SELECT ad_group.budget_micros FROM ad_group
-> UNRECOGNIZED_FIELD: Unrecognized field in the query: 'ad_group.budget_micros'
```

O campo simplesmente não existe. Não há equivalente ao ABO da Meta: `ad_group`
carrega lance (`cpc_bid_micros`), não orçamento. **Isso simplifica o modelo em
relação à Meta**, onde a exposição tem de seguir o nível do orçamento.

### Orçamentos compartilhados: existem, mas não nesta conta

Todos os 8 orçamentos: `explicitly_shared = false`, `reference_count = 1`,
`period = DAILY`, `delivery_method = STANDARD`, `type = STANDARD`. Relação
**1:1 entre campanha e orçamento** hoje.

| Campanha                                     | Canal           | Orçamento/dia | Status  |
| -------------------------------------------- | --------------- | ------------- | ------- |
| Search - Wings - Geral                       | SEARCH          | R$ 30,00      | ENABLED |
| SEARCH \| Geral                              | SEARCH          | R$ 50,00      | PAUSED  |
| SEARCH \| Franquear Negócio \| Alta Intenção | SEARCH          | R$ 56,00      | PAUSED  |
| SEARCH \| Cauda Longa \| Processo/Dúvida     | SEARCH          | R$ 50,00      | PAUSED  |
| SEARCH \| Marca \| Wings Company             | SEARCH          | R$ 13,00      | PAUSED  |
| Search leads - Wings site                    | SEARCH          | R$ 50,00      | PAUSED  |
| Campanha de youtube                          | DEMAND_GEN      | R$ 50,00      | PAUSED  |
| P-max 01 - cadastro site                     | PERFORMANCE_MAX | R$ 10,00      | PAUSED  |

**Mesmo assim o adaptador precisa tratar compartilhamento**: o campo existe, e
um orçamento compartilhado criado amanhã faria a soma por campanha contar o
mesmo dinheiro duas vezes. A regra continua valendo: **para o Google, exposição
por orçamento, não por campanha.**

### Performance Max: orçamento igual, estrutura diferente

A P-max usa `campaign_budget` normal (R$ 10,00/dia, não compartilhado) — **o
modelo de orçamento não muda**. O que muda é abaixo da campanha:

```
ad_group_ad em campanha PERFORMANCE_MAX -> 0 linhas
asset_group                             -> 2 ("Restaurantes e Afins", "rmkt")
```

**P-max não tem anúncios em `ad_group_ad`.** Tem `asset_group`, com
`status=ENABLED` mas `primary_status=NOT_ELIGIBLE`. Consequência direta para o
alerta de anúncio reprovado (item 17 / Etapa 6.6): **uma varredura só por
`ad_group_ad` ignora silenciosamente toda campanha P-max.** Terá de ler também
`asset_group` e as políticas de `asset_group_asset`.

(Os dois grupos "type=undefined" vistos na varredura são da campanha
DEMAND_GEN de YouTube, não da P-max.)

## Pergunta 3 — sobreentrega ✅ medida na conta

Medida real, dia a dia, na campanha ativa. **Atenção ao método**: o GAQL junta o
orçamento **atual** às métricas históricas, então a primeira leitura acusou
4,87× em 20/08. Era artefato. O `change_event` mostrou 4 mudanças de orçamento
no período:

```
2026-09-04 11:56  R$ 20,00 -> R$ 30,00
2026-09-04 11:51  R$ 15,00 -> R$ 20,00
2026-08-31 18:33  R$ 10,00 -> R$ 15,00
2026-08-21 11:34  R$ 140,00 -> R$ 10,00
```

Recalculando com o orçamento **vigente em cada dia**:

| Janela   | Orçamento | Razão observada   |
| -------- | --------- | ----------------- |
| 20/08    | R$ 140,00 | 1,04×             |
| 22–25/08 | R$ 10,00  | 0,00× – 1,17×     |
| 01–03/09 | R$ 15,00  | 1,04× – 1,17×     |
| 05–17/09 | R$ 30,00  | 0,78× – **1,35×** |

**Máximo real observado: 1,35× (16/09). Nunca chegou perto de 2×.** Em 13 dos
22 dias limpos o gasto passou do orçamento diário — sobreentrega é rotina, não
exceção.

### O que isso muda no desenho

O **2,0× da documentação continua sendo o valor certo para o guardrail** — é o
teto contratual do Google, e um guardrail se dimensiona pelo pior caso, não pela
média observada. Mas agora está registrado que o comportamento real desta conta
fica em ~1,35×, próximo do 1,25× da Meta.

```ts
// apps/api/src/modules/ads/platform/budget-model.ts  (proposta, NÃO implementada)
export interface PlatformBudgetModel {
  dailyOverdeliveryFactor: number; // rajada de um dia
  periodOverdeliveryFactor: number; // multiplicador do período restante
  budgetLevels: readonly ('campaign' | 'ad_set')[];
  sharedBudgets: boolean;
  moneyUnit: 'cents' | 'micros';
}

export const PLATFORM_BUDGET_MODELS = {
  meta: {
    dailyOverdeliveryFactor: 1.25,
    periodOverdeliveryFactor: 1.25,
    budgetLevels: ['campaign', 'ad_set'],
    sharedBudgets: false,
    moneyUnit: 'cents',
  },
  google: {
    dailyOverdeliveryFactor: 2.0,
    periodOverdeliveryFactor: 1.0,
    budgetLevels: ['campaign'],
    sharedBudgets: true,
    moneyUnit: 'micros',
  },
};
```

Dois fatores porque o Google faz duas promessas: até **2× num dia**, mas no mês
não cobra mais que `diário × 30,4`. Usar o fator diário no mês inteiro exigiria
o dobro do teto sem necessidade.

### Achado de método que vale para a ingestão

> O GAQL devolve o **orçamento atual** junto de métricas antigas. Qualquer
> análise histórica de "gastou acima do orçamento?" fica errada depois de uma
> mudança de orçamento.

Consequência prática: **a ingestão diária precisa gravar o orçamento vigente no
dia**, junto das métricas. `change_event` não substitui isso — só cobre 30 dias
e exige limite inferior **e** superior na consulta (`CHANGE_DATE_RANGE_INFINITE`
caso contrário).

## Pergunta 4 — conversões ✅ esta conta TEM leads

Ao contrário da Meta (zero eventos de lead), aqui há conversão de verdade.

**8 ações configuradas**; as que contam (`primary_for_goal = true`,
`status = ENABLED`):

| Ação                                                | Tipo                      | Categoria        | Contagem       |
| --------------------------------------------------- | ------------------------- | ---------------- | -------------- |
| `Wings Site - Site institucional (web) form_submit` | GOOGLE_ANALYTICS_4_CUSTOM | SUBMIT_LEAD_FORM | ONE_PER_CLICK  |
| `WhatsApp_clique`                                   | WEBPAGE                   | REQUEST_QUOTE    | MANY_PER_CLICK |
| `Contato_WhatsApp`                                  | WEBPAGE                   | SIGNUP           | ONE_PER_CLICK  |

**O que realmente disparou nos últimos 30 dias: só `form_submit`, 18
conversões.** As duas de WhatsApp estão ativas e marcadas como primárias, mas
não registraram nada. Três ações estão `HIDDEN` (GA4 importadas) e uma
`REMOVED`.

Isso resolve a pergunta "o que conta como lead aqui": **`form_submit`**, com
`WhatsApp_clique` e `Contato_WhatsApp` a observar. Diferente da Meta, **CPL é
calculável**: R$ 1.002,00 ÷ 18 = **R$ 55,67** nos últimos 30 dias.

## Pergunta 5 — revisão/política ✅ campos funcionam

`ad_group_ad.policy_summary` responde com `approval_status`, `review_status` e
`policy_topic_entries[]`. Estado atual dos 29 anúncios:

```
APPROVED / REVIEWED            28
UNKNOWN  / REVIEW_IN_PROGRESS   1
```

Nenhuma reprovação hoje — o alerta `ad_rejected` teria zero disparos, ao
contrário da Meta (2 reprovados). **Ressalva já registrada na pergunta 2: P-max
não aparece aqui.** Cobertura completa exige `asset_group` também.

## Pergunta 6 — entrega hoje ✅

**Apenas 1 das 8 campanhas está ativa** — "Search - Wings - Geral". As outras 7
estão `PAUSED` (`primary_status_reasons: ["CAMPAIGN_PAUSED"]`).

| Janela          | Custo       | Impressões | Cliques | Conversões |
| --------------- | ----------- | ---------- | ------- | ---------- |
| Últimos 30 dias | R$ 1.002,00 | 2.188      | 347     | 18         |
| Este mês        | R$ 540,17   | 614        | 151     | 6          |
| Hoje (18/09)    | R$ 10,11    | 21         | 3       | 0          |

A campanha ativa está **`primary_status = LIMITED`, motivo
`BUDGET_CONSTRAINED`** — o orçamento diário está segurando a entrega. É um sinal
que o cockpit pode exibir diretamente, sem inferir nada.

A P-max gastou R$ 97,43 nos últimos 30 dias (2 conversões) antes de ser pausada.

## Pergunta 7 (nova) — conta pré-paga ✅ a API EXPÕE o saldo

**Correção do que eu havia suposto:** eu havia registrado que a API talvez não
expusesse saldo pré-pago. **Expõe**, via `account_budget`:

```json
{
  "id": "8108783231",
  "status": "APPROVED",
  "approvedSpendingLimitMicros": "12600000000", // R$ 12.600,00
  "totalAdjustmentsMicros": "139570000", // R$    139,57
  "adjustedSpendingLimitMicros": "12739570000", // R$ 12.739,57
  "amountServedMicros": "12718810000" // R$ 12.718,81
}
```

> **saldo restante = `adjusted_spending_limit` − `amount_served`
> = R$ 12.739,57 − R$ 12.718,81 = R$ 20,76**

Janela do orçamento: `2025-12-14` → `FOREVER`. `billing_setup` (status
`APPROVED`) traz a conta de pagamentos: `Wings`, id `9891-4652-2694-7009`,
perfil `0664-6327-2050`.

### O que isso significa para o guardrail

O teto interno de R$ 4.000/mês é **165× maior que o saldo real**. Comprometer
R$ 2.800 de "utilizável" numa conta com R$ 20,76 é uma reserva que a plataforma
não honra.

Desenho a decidir (nada implementado):

1. **Dois tetos, o menor vence**: limite interno do mês e saldo pré-pago.
2. **Alerta próprio `account_out_of_funds`**, crítico e com WhatsApp,
   disparando por limiar de saldo (ex.: menos de 2 dias de gasto médio).
3. **`budget_pacing` suprimido** quando a causa for falta de fundo — dois
   alertas para o mesmo fato treinam a equipe a ignorar os dois.
4. Ingerir `account_budget` junto das métricas; é uma consulta barata.

`campaign.primary_status_reasons` é o sinal complementar por campanha
(`CAMPAIGN_PAUSED`, `BUDGET_CONSTRAINED` observados hoje).

## Micros

Confirmado na prática: valores vêm em micros (1 real = 1.000.000). `centavos =
micros ÷ 10.000`. Os valores desta conta são todos múltiplos exatos de 10.000
micros, mas `total_adjustments_micros = 139570000` mostra que ajustes chegam em
centavos quebrados. **Guardar `micros` bruto ao lado dos centavos.**

## Resumo das sete perguntas

| #   | Pergunta                   | Resposta                                                                               |
| --- | -------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Lê dados reais?            | ✅ sim, v22, sem `login-customer-id`                                                   |
| 2   | Orçamento só por campanha? | ✅ sim (`ad_group.budget_micros` não existe); compartilhados possíveis mas nenhum hoje |
| 3   | Sobreentrega 2×?           | ✅ documentada 2×, **observada máx. 1,35×**; usar 2,0 no guardrail                     |
| 4   | Tipos de conversão?        | ✅ `form_submit` (18 em 30d); WhatsApp ativas mas sem eventos; **CPL = R$ 55,67**      |
| 5   | Campos de política?        | ✅ `policy_summary` funciona; 28 aprovados, 1 em revisão; **P-max fora**               |
| 6   | Entregando hoje?           | ✅ 1 de 8 campanhas; R$ 10,11 hoje; `LIMITED / BUDGET_CONSTRAINED`                     |
| 7   | Saldo pré-pago?            | ✅ `account_budget` → **R$ 20,76 restantes**                                           |

## Próximos passos (depois da sua revisão)

1. **Repor o saldo pré-pago** — operacional, hoje.
2. Decidir schema: `ad_budgets` (por orçamento, não por campanha), snapshot
   diário do orçamento vigente, ingestão de `account_budget`.
3. `budget-guard.ts`: dois fatores por plataforma + teto duplo (limite interno
   vs saldo).
4. Alerta `account_out_of_funds` e supressão de `budget_pacing`.
5. Cobertura de P-max no alerta de reprovação (`asset_group`).

Script do spike: `/tmp/.../scratchpad/google-ads-spike.mjs` (temporário, fora do
repositório).
