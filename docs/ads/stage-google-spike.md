# Etapa Google 0 — spike (somente leitura)

Executado contra a conta real com o refresh token gerado em 2026-09-17.
Reexecutado em 2026-09-17 após a correção dos papéis das contas e a vinculação
aceita pela Thais. Nenhum objeto foi criado, alterado ou gasto.

## Papéis das contas (corrigido)

| Conta          | Papel                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| **4268586278** | conta de anúncios real — é ela que gasta e que o cockpit deve espelhar |
| **6693183441** | MCC Wings Company — onde vive o developer token                        |

Vinculação confirmada hoje: a MCC consta como **Administrador** de 4268586278
(Proprietário = Não). No `.env`: `GOOGLE_ADS_CUSTOMER_ID=4268586278`,
`GOOGLE_ADS_LOGIN_CUSTOMER_ID=6693183441`.

## Resumo executivo

**O spike continua sem conseguir ler dados da conta.** A vinculação não
destravou o acesso, e a suspeita de que o `ACTION_NOT_PERMITTED` era
consequência da conta não vinculada **não se confirmou**: o erro persiste,
idêntico, depois da vinculação aceita.

O bloqueio real é um só, e é o nível do developer token.

## A matriz que resolve a questão

Seis combinações de conta-alvo × cabeçalho `login-customer-id`, todas com o
mesmo token:

```
target=4268586278  login=(nenhum)     -> 403 ACTION_NOT_PERMITTED
target=4268586278  login=4268586278   -> 403 ACTION_NOT_PERMITTED
target=4268586278  login=6693183441   -> 403 USER_PERMISSION_DENIED
target=6693183441  login=(nenhum)     -> 403 USER_PERMISSION_DENIED
target=6693183441  login=4268586278   -> 403 USER_PERMISSION_DENIED
target=6693183441  login=6693183441   -> 403 USER_PERMISSION_DENIED

customers:listAccessibleCustomers -> customers/4268586278   (apenas)
```

Lendo a matriz:

1. **Todo caminho que chega à conta de anúncios pelo contexto do próprio token
   devolve `ACTION_NOT_PERMITTED`** — _"The Google Cloud project is only
   approved for use with test accounts. To access non-test accounts, apply for
   Explorer, Basic or Standard access."_ A vinculação de hoje não mudou isso.
   O nível do developer token é um bloqueio real e independente.

2. **Todo caminho que passa pela MCC devolve `USER_PERMISSION_DENIED`** — o
   usuário Google que autorizou o token **não é usuário da MCC 6693183441**.
   Por isso `login-customer-id=6693183441` falha antes mesmo de o token ser
   avaliado.

3. **`listAccessibleCustomers` devolve só `4268586278`** — ou seja, o usuário
   que autorizou tem acesso **direto** à conta de anúncios, e nenhum acesso à
   MCC.

### O que isso significa na prática

O ponto 3 é boa notícia: como o usuário tem acesso direto à conta de anúncios,
**o cabeçalho `login-customer-id` nem é necessário** — ele só faz falta quando
o acesso é _através_ do gerenciador. Assim que o token tiver Basic access, o
caminho `target=4268586278` sem cabeçalho deve funcionar.

Ou seja, resta **uma única pendência**:

> **Solicitar Basic access para o developer token**, no API Center da MCC
> 6693183441 (Ferramentas → Configuração → API Center). É obrigatório para
> qualquer conta de produção, com ou sem vinculação.

Opcionalmente, dar acesso do usuário Google autorizador à MCC destravaria
também o caminho via `login-customer-id` — útil no dia em que houver mais de
uma conta cliente, mas **não é o que bloqueia hoje**.

## Situação de cada pergunta

| #   | Pergunta                            | Situação                                   |
| --- | ----------------------------------- | ------------------------------------------ |
| 1   | Cliente lê dados reais              | ❌ bloqueado (Basic access)                |
| 2   | Orçamento só no nível de campanha   | ⏸️ não verificado                          |
| 3   | Sobreentrega 2× vs 1,25× da Meta    | ✅ desenhado (valor a confirmar)           |
| 4   | Tipos de conversão desta conta      | ❌ bloqueado                               |
| 5   | Campos de revisão/política          | ⏸️ não verificado                          |
| 6   | Campanhas entregando hoje e gasto   | ❌ bloqueado pela API — **mas ver abaixo** |
| 7   | Saldo pré-pago / faturamento (novo) | ❌ bloqueado — desenho abaixo              |

Nada foi promovido de "não verificado" para "verificado": **nenhuma linha de
dado da conta chegou pela API nesta execução.**

## Pergunta 6 — o que já se sabe pelo Ads Manager

Estes números vieram da tela, não da API. Ficam registrados como **alvo de
conciliação** para quando o acesso for liberado — a mesma disciplina da Meta na
Etapa 3, onde o `spend_cap` e o gasto foram conferidos contra o painel.

| Métrica              | Ads Manager (19/08 → 15/09/2026) |
| -------------------- | -------------------------------- |
| Campanhas            | 8                                |
| Cliques              | 327                              |
| Impressões           | 2,11 mil                         |
| CPC médio            | R$ 2,84                          |
| Custo                | R$ 928                           |
| Pontuação otimização | 83,7%                            |
| Campanha exemplo     | "Search - Wings - Geral"         |

Os números são internamente consistentes: 327 × R$ 2,84 = R$ 928,68 ≈ R$ 928. A
conciliação da API terá de bater com isso dentro do arredondamento de micros.

**Diferença central em relação à Meta: esta conta ESTÁ entregando.** O cockpit
terá dados reais desde o primeiro dia — CTR, CPC e custo diário —, ao contrário
da conta Meta, que não entrega nada. Isso também significa que os alertas de
ritmo e de desgaste passam a ter matéria-prima de verdade.

## Pergunta 7 (nova) — conta pré-paga: o saldo é o teto real

O painel alerta **"Há pouco fundo pré-pago na conta"**. Isso muda a natureza do
guardrail, e a observação está certa:

> Hoje o teto que o sistema conhece é o nosso limite interno (R$ 4.000/mês).
> Numa conta pré-paga, o teto real é **o saldo**. Se o saldo zerar, as
> campanhas param sozinhas — e o sistema atual leria isso como
> `budget_pacing` (gasto abaixo do previsto), que é o diagnóstico errado.

É o mesmo erro de leitura da conta Meta parada, com um agravante: lá "parado" é
o estado normal; aqui seria **uma conta que estava entregando e parou por falta
de dinheiro**, sem ninguém ser avisado do motivo certo.

### O que precisa ser descoberto (quando houver acesso)

Recursos a sondar, em ordem de preferência:

| Recurso          | O que se espera                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `billing_setup`  | vínculo com o perfil de pagamentos (`payments_account_info`)                                                                              |
| `account_budget` | limites de gasto (`approved_spending_limit_micros`, `amount_served_micros`) — existe sobretudo em contas faturadas, pode não existir aqui |
| `customer`       | `status` (ENABLED/SUSPENDED/CLOSED)                                                                                                       |
| `campaign`       | `primary_status` e `primary_status_reasons` — é onde um motivo do tipo "sem fundos" apareceria por campanha                               |

**Ressalva honesta:** é bem possível que a Google Ads API **não exponha o saldo
pré-pago**, que vive no perfil de Pagamentos e não no Ads. Se for esse o caso, o
sinal detectável não será o saldo em si, mas as campanhas **pararem com um
motivo específico** em `primary_status_reasons`. O spike precisa descobrir qual
dos dois caminhos existe antes de qualquer decisão de schema — supor que há um
campo de saldo seria repetir o erro de assumir que `issues_info` traria o motivo
da reprovação na Meta.

### Implicação de projeto (a decidir depois, nada implementado)

- Um alerta próprio, **`account_out_of_funds`**, crítico e com aviso no
  WhatsApp — separado de `budget_pacing`.
- `budget_pacing` deve ser **suprimido** quando a causa for falta de fundo:
  dois alertas para o mesmo fato treinam a equipe a ignorar os dois.
- O guardrail passa a ter **dois tetos**: o nosso limite mensal e o saldo. O
  menor vence. Comprometer R$ 2.800 num saldo de R$ 300 é uma reserva que a
  plataforma não honra.

## Perguntas 2 e 5 — ainda só documentação

Sem mudanças desde a primeira execução; **nada verificado na conta**.

- **Orçamento (2):** vive em `campaign_budget`; não existe orçamento por grupo
  de anúncios. Orçamentos **compartilhados** (`explicitly_shared`,
  `reference_count`) fazem com que somar exposição por campanha conte o mesmo
  dinheiro duas vezes — para o Google, a exposição tem de ser por orçamento.
- **Política (5):** `ad_group_ad.policy_summary` com `approval_status`,
  `review_status` e `policy_topic_entries[]`, equivalente funcional do
  `ad_review_feedback` da Meta.

## Pergunta 3 — sobreentrega por plataforma (desenho mantido)

Hoje `budget-guard.ts` tem uma constante única de 1,25 (Meta). Aplicá-la ao
Google subestimaria o risco; aplicar 2,0 a tudo bloquearia orçamentos legítimos.
São **dois fatores**, porque o Google faz duas promessas diferentes:

- **por dia**, pode entregar até **2× o orçamento diário**;
- **no mês**, garante não cobrar mais que `diário × 30,4`.

```ts
// apps/api/src/modules/ads/platform/budget-model.ts
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

Duas verificações no guard, não uma: o **compromisso do período**
(`diário × dias restantes × periodOverdeliveryFactor`) e a **rajada de um dia**
(`diário × dailyOverdeliveryFactor` tem de caber no disponível). A reserva
precisa gravar com que fator foi calculada — proposta: coluna
`overdelivery_factor_milli` em `ad_change_requests`.

O valor 2,0 vem da documentação, **não desta conta**. Como a conta entrega de
verdade, dá para medir: comparar `metrics.cost_micros` diário contra
`campaign_budget.amount_micros` em dias de entrega cheia.

## Micros

O Google reporta dinheiro em micros (1 real = 1.000.000). `centavos = micros ÷
10.000`, nem sempre inteiro. Recomendação: guardar `amount_micros` bruto ao lado
do valor em centavos e arredondar só na exibição.

## Próximos passos

1. **Solicitar Basic access** no API Center da MCC 6693183441. É o único
   bloqueio.
2. (Opcional) dar ao usuário autorizador acesso à MCC, para liberar também o
   caminho via `login-customer-id`.
3. Reexecutar o spike — o script cobre as sete perguntas e já lê
   `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.
4. Conciliar a saída da API com os números do Ads Manager acima.
5. Só então decidir schema, `ad_budgets`, alertas de saldo e mudanças no guard.

Script do spike: `/tmp/.../scratchpad/google-ads-spike.mjs` (temporário, fora do
repositório), mantido para a reexecução.
