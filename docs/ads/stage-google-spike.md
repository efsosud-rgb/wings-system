# Etapa Google 0 — spike (somente leitura)

Executado contra a conta real `6693183441` com o refresh token gerado em
2026-09-17. Nenhum objeto foi criado, alterado ou gasto — todas as chamadas são
`googleAds:search` ou `listAccessibleCustomers`.

## Resumo executivo

**O spike não conseguiu ler dados da conta.** A camada de autenticação funciona
perfeitamente, mas existem **dois bloqueios de acesso independentes**, ambos
fora do código e resolvíveis só no console do Google:

1. o **token de desenvolvedor só está aprovado para contas de teste**;
2. o **usuário OAuth não tem acesso à conta `6693183441`**.

Nenhuma das seis perguntas que dependiam de dados reais pôde ser respondida.
A pergunta 3 (fator de sobreentrega) **foi resolvida no nível de projeto** e
está desenhada ao final deste documento — era a única que não dependia da conta.

> Isto é o mesmo padrão da Meta na Etapa 3: descobrir o bloqueio antes de
> escrever o adaptador custa uma tarde; descobrir depois custa um adaptador.

## O que foi verificado ✅

| Item                                          | Resultado                                                 |
| --------------------------------------------- | --------------------------------------------------------- |
| Refresh token → access token                  | ✅ escopo `adwords`, expira em 3599s                      |
| API alcançável                                | ✅ `googleads.googleapis.com`                             |
| Versão da API em uso                          | **v22** (respondeu; v16–v21 não foram sondadas até o fim) |
| `customers:listAccessibleCustomers`           | ✅ HTTP 200                                               |
| Contas visíveis para este usuário OAuth       | **apenas `4268586278`**                                   |
| Conta-alvo `6693183441` acessível diretamente | ❌ não                                                    |

## Os dois bloqueios ❌

### 1. Token de desenvolvedor: acesso só a contas de teste

```
GET customers/4268586278/googleAds:search
403 ACTION_NOT_PERMITTED
"The Google Cloud project is only approved for use with test accounts.
 To access non-test accounts, apply for Explorer, Basic or Standard access."
```

O token existe e é aceito (22 caracteres, formato válido) — o que falta é o
**nível de acesso**. Com acesso de teste, nenhuma conta de produção pode ser
lida, nem a do gerente.

**Como resolver:** no **Google Ads API Center** da conta de gerência
(Ferramentas → Configuração → API Center), solicitar **Basic access**. O
formulário pede descrição do uso; aprovação costuma levar de horas a alguns
dias. Basic access dá 15.000 operações/dia, mais que suficiente para o cockpit.

### 2. O usuário OAuth não alcança a conta-alvo

```
POST customers/6693183441/googleAds:search                      403 USER_PERMISSION_DENIED
POST customers/6693183441/... (login-customer-id: 4268586278)   403 USER_PERMISSION_DENIED
```

Os dois erros são **diferentes** e isso importa: o alvo devolve
`USER_PERMISSION_DENIED` (o usuário não tem permissão na conta) enquanto o
gerente devolve `ACTION_NOT_PERMITTED` (o token é que não serve). Ou seja, não
é um sintoma do bloqueio 1 — é um problema separado.

Traduzindo: a conta com a qual o refresh token foi gerado enxerga apenas
`4268586278`, e `6693183441` **não está sob esse gerente** (ou o vínculo não
está ativo).

**Como resolver — uma das opções:**

- vincular `6693183441` como conta cliente de `4268586278` (convite de
  gerência, aceito dentro da conta cliente); **ou**
- dar acesso direto ao usuário Google que autorizou o token, dentro de
  `6693183441` (Admin → Acesso e segurança); **ou**
- confirmar se `6693183441` é mesmo o ID certo — vale reconferir no Ads
  Manager, porque o ID que o cockpit deve espelhar é o da conta que gasta.

Quando resolvido, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (o ID do gerente) passa a ser
uma variável obrigatória ao lado das outras, porque toda chamada a uma conta
cliente exige o cabeçalho `login-customer-id`.

## Situação de cada pergunta

| #   | Pergunta                                | Situação                                                   |
| --- | --------------------------------------- | ---------------------------------------------------------- |
| 1   | Cliente lê dados reais (campanhas etc.) | ❌ bloqueado — nenhum dado obtido                          |
| 2   | Orçamento só no nível de campanha       | ⏸️ não verificado (só documentação)                        |
| 3   | Sobreentrega 2× vs 1,25× da Meta        | ✅ **desenhado abaixo** (valor ainda a confirmar na conta) |
| 4   | Tipos de conversão desta conta          | ❌ bloqueado — é exatamente o que não se pode supor        |
| 5   | Campos de revisão/política de anúncios  | ⏸️ não verificado (só documentação)                        |
| 6   | Campanhas entregando hoje e gasto atual | ❌ bloqueado                                               |

O que a documentação diz sobre 2 e 5 está registrado abaixo **marcado como não
verificado**. Depois da Meta — onde a conta real contradisse a documentação em
dois pontos (`ad_review_feedback` em vez de `issues_info`, e zero eventos de
lead apesar de campanhas chamadas "LEAD | FORMS") — nada aqui deve virar código
antes de passar pela conta real.

### Pergunta 2 — modelo de orçamento (não verificado)

Documentação: o orçamento vive em `campaign_budget`, referenciado pela
campanha. **Não existe orçamento no nível de grupo de anúncios** — `ad_group`
tem lances (`cpc_bid_micros`), não orçamento. Isso é mais simples que a Meta,
que mistura CBO e ABO.

**Mas há uma diferença que a Meta não tem: orçamentos compartilhados.** Um
`campaign_budget` com `explicitly_shared = true` é usado por várias campanhas
ao mesmo tempo, e `reference_count` diz por quantas. Consequência direta para o
nosso modelo:

> Somar exposição **por campanha** contaria o mesmo dinheiro duas vezes quando
> duas campanhas dividem um orçamento. Para o Google, a exposição tem de ser
> calculada **por orçamento**, não por campanha.

Isso provavelmente exige uma tabela `ad_budgets` (id da plataforma, valor,
compartilhado, contagem de referências) com as campanhas apontando para ela —
decisão de schema a tomar depois da verificação real.

### Pergunta 5 — campos de política (não verificado)

Documentação: `ad_group_ad.policy_summary` traz `approval_status`
(`APPROVED`, `APPROVED_LIMITED`, `DISAPPROVED`, `AREA_OF_INTEREST_ONLY`),
`review_status` e `policy_topic_entries[]` com `topic`, `type` e evidências.
É o equivalente funcional do `ad_review_feedback` da Meta e serviria ao mesmo
alerta `ad_rejected` da Etapa 6.6.

## Pergunta 3 — sobreentrega por plataforma (resolvida)

Hoje `budget-guard.ts` tem uma constante única:

```ts
export const OVERDELIVERY_FACTOR = META_DAILY_OVERDELIVERY_FACTOR; // 1,25
export function exposureOf(dailyBudgetCents, daysLeft) {
  return Math.round(dailyBudgetCents * daysLeft * OVERDELIVERY_FACTOR);
}
```

Aplicar 1,25 a uma campanha do Google **subestimaria o risco em 60%**. Mas
trocar por 2,0 em tudo também estaria errado, e por um motivo que só aparece
quando se lê como o Google cobra:

- **por dia**, o Google pode entregar até **2× o orçamento diário**;
- **no mês**, o Google garante não cobrar mais que `diário × 30,4` — o que
  passar disso é creditado de volta.

Ou seja, **são dois fatores diferentes**, e usar o fator diário para o mês
inteiro bloquearia orçamentos legítimos (exigiria o dobro de teto). A Meta não
faz essa promessa mensal, então lá os dois fatores coincidem.

### Desenho proposto

```ts
// apps/api/src/modules/ads/platform/budget-model.ts
export interface PlatformBudgetModel {
  /** Máximo que um único dia pode entregar acima do orçamento diário. */
  dailyOverdeliveryFactor: number;
  /** Multiplicador aplicado ao restante do período. */
  periodOverdeliveryFactor: number;
  /** Onde o orçamento pode viver nesta plataforma. */
  budgetLevels: readonly ('campaign' | 'ad_set')[];
  /** Se um orçamento pode ser dividido por várias campanhas. */
  sharedBudgets: boolean;
  /** Unidade monetária da API. */
  moneyUnit: 'cents' | 'micros';
}

export const PLATFORM_BUDGET_MODELS: Record<AdPlatform, PlatformBudgetModel> = {
  meta: {
    dailyOverdeliveryFactor: 1.25,
    periodOverdeliveryFactor: 1.25, // sem garantia mensal: o diário vale para o mês
    budgetLevels: ['campaign', 'ad_set'],
    sharedBudgets: false,
    moneyUnit: 'cents',
  },
  google: {
    dailyOverdeliveryFactor: 2.0,
    periodOverdeliveryFactor: 1.0, // garantia de diário × 30,4 no mês
    budgetLevels: ['campaign'],
    sharedBudgets: true,
    moneyUnit: 'micros',
  },
  tiktok: {/* a confirmar em spike próprio — não copiar da Meta por conveniência */},
};
```

`exposureOf` e `campaignExposure` passam a receber o modelo; o guard resolve
`PLATFORM_BUDGET_MODELS[account.platform]` a partir da linha da conta, que já
carrega `platform`. Nenhuma migração é necessária no constraint do banco: ele
limita `committed_cents`, seja qual for o fator que o produziu.

### Duas verificações, não uma

Com dois fatores, o guard passa a fazer duas perguntas em vez de uma:

1. **compromisso do período** — `diário × dias restantes × periodOverdeliveryFactor`
   continua sendo o que entra em `committed_cents`;
2. **rajada de um dia** — `diário × dailyOverdeliveryFactor` precisa caber no
   disponível, senão um único dia de pico consome o mês.

A segunda é nova e protege justamente o caso do Google, onde o diário pode
dobrar sem aviso.

### Auditabilidade

A reserva precisa registrar **com que fator foi calculada**, senão uma mudança
futura de constante torna as reservas antigas inexplicáveis. Proposta: coluna
`overdelivery_factor_milli` (inteiro, ×1000) em `ad_change_requests`, gravada
no momento da reserva — mesma disciplina de inteiros usada no resto do módulo.

### Ainda a confirmar na conta real

O valor 2,0 vem da documentação do Google, **não desta conta**. Quando o acesso
for liberado, vale comparar `metrics.cost_micros` diário contra
`campaign_budget.amount_micros` em dias de entrega cheia e ver qual é a razão
real observada.

## Outra diferença que o adaptador terá de tratar: micros

O Google reporta dinheiro em **micros** (1 real = 1.000.000 micros), a Meta em
centavos (ou reais decimais, conforme o campo). Conversão: `centavos =
micros ÷ 10.000`.

Nem todo valor em micros cai num número inteiro de centavos (ex.: 1.333.333
micros = 133,3333 centavos). Recomendação: **guardar `amount_micros` bruto**
junto do valor em centavos para contas Google, e arredondar só na exibição —
pela mesma razão que o módulo inteiro nunca usa float para dinheiro.

## Próximos passos

1. **Solicitar Basic access** no API Center da conta de gerência.
2. **Resolver o acesso do usuário** a `6693183441` (vincular ao gerente, dar
   acesso direto, ou confirmar o ID correto).
3. Acrescentar `GOOGLE_ADS_LOGIN_CUSTOMER_ID` ao `/etc/wings-crm/google-ads.env`.
4. **Reexecutar este spike** — o script está pronto e cobre as seis perguntas;
   só lhe falta permissão.
5. Só então decidir schema, `ad_budgets` e mudanças no guard.

O script do spike está em
`/tmp/.../scratchpad/google-ads-spike.mjs` (temporário, fora do repositório) e
foi mantido justamente para essa reexecução.
