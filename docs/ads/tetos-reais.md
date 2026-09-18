# Tetos reais e conta alvo (Onda 1)

Quatro correções que fazem o sistema apontar para a realidade, sem reescrever
nada. Cada uma existe porque uma constante ou um alvo estava errado.

## 1. Conta alvo da Meta

O sistema espelhava `act_339488762500182` ("BM - Wings Company 01 - Leads
Formatação 2k23"), que **nunca veiculou nada**: R$ 0,00 gastos, zero
impressões. Os "zero eventos de lead" registrados na Etapa 6.0 não eram
característica da conta — **era a conta errada**.

A operação real é `act_694058302567457` ("CA - Wings Company Fly High 2k23").

> ⚠️ **O ID que circulou por escrito estava truncado.** Três dos quatro IDs
> informados no comando desta onda não existem no BM. O que a API devolve em
> `/me/adaccounts` é a fonte da verdade:
>
> | Informado       | Real na API          | Conta             |
> | --------------- | -------------------- | ----------------- |
> | 69405830256745  | **694058302567457**  | Fly High (alvo)   |
> | 157021062040941 | **1570210620409413** | Rec Lab \| Boleto |
> | 63489513921664  | **634885135921664**  | Venda de Franquia |
> | 339488762500182 | 339488762500182 ✅   | Leads Formatação  |
>
> A identificação da Fly High é inequívoca por três vias independentes: nome
> exato, `spend_cap` de R$ 2.500,00 e `amount_spent` de R$ 636,90 — os mesmos
> números vistos no painel.

### O que foi feito com a conta antiga

**Arquivada. Nem migrada, nem descartada.**

- **Migrar seria fabricar história**: as 9 campanhas e 13 anúncios pertencem a
  outra conta, e `ad_metrics_daily` é indexada por conta + entidade. Repontar
  as linhas inventaria um passado que a Fly High nunca teve.
- **Descartar destruiria prova**: aprovações, solicitações de alteração,
  eventos de guardrail e a trilha de auditoria (append-only) referenciam a
  conta. Dois anúncios guardam o motivo real de reprovação
  ("Práticas de negócios inaceitáveis"), que é evidência de um problema de
  negócio ainda aberto.

`ad_accounts` ganhou `archived_at` e `archived_reason`. Uma conta arquivada sai
da ingestão, do cockpit e do motor de alertas; **nenhuma linha é apagada**. Os
alertas abertos são resolvidos com o motivo gravado no próprio alerta.

```
node dist/modules/ads/ingest-cli.js --archive act_… --reason "…"
```

### Consequência: CPL/CPA volta a ser calculável

`LEAD_ACTION_TYPES` e `conversionsFrom()` sempre estiveram certos — nunca viram
um lead porque a conta não tinha nenhum. Com a conta certa, duas coisas mudam
(**nada implementado nesta onda**):

- **Silêncio de conversão** (Etapa 6.6, construído e desligado) passa a fazer
  sentido: havia silêncio em tudo porque não havia entrega. Com CPL real entre
  R$ 23,52 e R$ 177,85, o alerta pode ser ligado com limiar defensável.
- **Subdesempenho de CPL/CPA**, descartado na Etapa 6.0 por falta de linha de
  base, volta a ser implementável.

## 2. Dois tetos: o menor vence

O teto interno de R$ 4.000/mês era ficção nas duas pontas.

| Plataforma | Teto real                                                    | Fonte                   |
| ---------- | ------------------------------------------------------------ | ----------------------- |
| Meta       | `spend_cap` − `amount_spent` = R$ 2.500 − R$ 636,90          | `meta.spend_cap`        |
| Google     | saldo pré-pago (`adjusted_spending_limit` − `amount_served`) | `google.account_budget` |

`ad_budget_periods` ganhou `platform_remaining_cents`, `platform_limit_source` e
`platform_limit_synced_at`, preenchidos pela reconciliação a partir da API —
**nunca hardcoded**.

### Como o cálculo mudou

O disponível passou a ser o **menor de três**: folga do teto interno, folga da
parcela utilizável e o que a plataforma ainda permite. Com uma sutileza que só
apareceu ao escrever o teste:

> O saldo da plataforma é um total para o que ainda será gasto, e a exposição
> **já comprometida** vai consumi-lo. Então a folga para novos planos é
> `saldo − comprometido`, não o saldo bruto. Sem isso, um saldo de R$ 20,76
> pareceria plannável enquanto R$ 325 de exposição já estavam na fila.

### Onde é verificado

- **Chokepoint** (`reserveChange`): recusa com motivo próprio,
  `platform_limit_would_be_exceeded`, cuja mensagem diz que foi a **plataforma**
  — o operador precisa saber que a solução é recarregar, não elevar o limite
  interno.
- **Reconciliação**: grava o limite e registra um evento de guardrail quando a
  plataforma é o teto vinculante.

Um limite já inferior ao comprometido é **registrado, não recusado**: a reserva
existente não é anulada em silêncio, novas ficam bloqueadas, e uma pessoa
decide. Por isso a checagem vive no chokepoint e não num CHECK do banco — um
CHECK se recusaria a gravar justamente o número que mais importa saber.

## 3. Google: `login-customer-id` fica de fora

Verificado na conta real:

```
sem o cabeçalho  -> 200 OK
com o cabeçalho  -> 403 USER_PERMISSION_DENIED
```

O usuário que autorizou o token tem acesso **direto** à conta de anúncios e
**não é membro da MCC**. O cabeçalho só serve para alcançar uma conta cliente
_através_ do gerenciador; aqui ele faz o Google checar a MCC e recusar.

`GOOGLE_ADS_LOGIN_CUSTOMER_ID` continua no `.env` **como documentação** de quem
é dono do developer token. O cliente não o envia.

**Há um teste que trava isso** (`google-client.test.ts`), porque adicionar o
cabeçalho é um "conserto" plausível e confiante que alguém tentará.

O cliente do Google é deliberadamente **mínimo**: só lê o teto de gastos. Não é
um `AdsPlatformClient` — espelhar campanhas e métricas do Google depende de
decisões que esta onda não toma (exposição por orçamento, P-max via
`asset_group`, o segundo fator de sobreentrega).

## 4. Snapshot diário do orçamento vigente

Achado do spike do Google: **o GAQL junta o orçamento ATUAL a métricas
históricas**. A primeira medição de sobreentrega acusou 4,87× quando o real era
1,35× — havia 4 mudanças de orçamento na janela. O mesmo vale para a Meta.

`ad_metrics_daily` ganhou `daily_budget_cents`, gravado na ingestão:

- **só para o dia corrente**, porque o orçamento de um dia passado não é
  conhecível — para dias anteriores fica `null`, que é honesto;
- **um dia fechado não é reescrito**: correções só entram enquanto o dia é hoje.

Sem isso, qualquer pergunta futura do tipo "essa campanha entregou acima do
orçamento?" fica sem resposta depois da primeira alteração.

## Dois achados de campo que custaram caro

### 1. Um cliente só pode escrever na própria conta

O laço de ingestão construía **um** cliente a partir de `META_WRITE_ACCOUNT_ID`
e o reusava para cada conta do banco. Com uma conta só, invisível. Com duas, na
primeira execução real, espelhou os dados da conta ativa **dentro da linha da
conta antiga**: 84 campanhas, 202 conjuntos, R$ 636,93 de gasto e o teto da
plataforma, tudo arquivado sob uma conta que nunca veiculou nada — e a conta
certa ficou vazia.

O bug é **anterior a esta onda**: teria aparecido no dia em que o multi-conta
entrasse, provavelmente em produção.

Correção: `AdsPlatformClient` declara `accountExternalId`, e `reconcileAccount`,
`syncAds` e `ingestMetrics` **recusam** quando ele não bate com a linha da conta
que estão escrevendo. A checagem vale para clientes **live**; um dublê de teste
tem o vínculo que o teste quiser, então a trava é coberta com um cliente real e
`fetch` injetado.

### 2. Paginação da Meta: `cursors.after` NÃO encerra o laço

A conta real (84 campanhas, 202 conjuntos, **660 anúncios**) faz a Meta
responder _"Please reduce the amount of data you're asking for"_ em vez de
truncar — paginar não é otimização, é a única forma de a chamada funcionar.

> ⚠️ **A Meta devolve `paging.cursors.after` mesmo na última página.** Só a
> presença de `paging.next` indica que existe outra página. Usar o cursor como
> sinal de parada pagina até o limite e devolve o mesmo conteúdo repetido — na
> primeira tentativa, 100 linhas onde havia 2. Um teste já existente pegou isso.

Há também uma proteção contra cursor repetido, e páginas pequenas (25 para
anúncios com criativos, 50 para campanhas e conjuntos, 100 para insights).

## Limpeza de dados: corrigir para frente, nunca reescrever

A limpeza do espelhamento errado esbarrou no gatilho append-only de
`ad_spend_snapshots` — **o guardrail funcionando como projetado**. Um livro-razão
de dinheiro não se apaga.

O que foi feito:

- as 82 campanhas erradas **sem** referência no livro-razão foram removidas,
  com seus conjuntos;
- **2 campanhas permanecem** sob a conta arquivada porque snapshots
  append-only as referenciam. Ficam inertes;
- os 25 snapshots errados **continuam lá**, e foram **compensados**: uma linha
  nova de gasto zero por (campanha, dia), com `source` explicando o motivo.
  Como a reconciliação usa a leitura mais recente por campanha/dia, o gasto
  efetivo passou a zero **sem apagar o erro**, que continua visível com data.

## O que falta para multi-conta (fora do escopo desta onda)

As 4 contas já estão atribuídas aos dois usuários de sistema, mas o sistema
segue com **alvo único** (Fly High). Para as outras três entrarem:

1. **Cliente por conta**: hoje `createMetaClient(env)` lê um único
   `META_WRITE_ACCOUNT_ID`. Precisa passar a receber o `externalId` da conta e
   construir um cliente por conta.
2. **Período por conta**: `openPeriod` já é por conta; falta decidir o teto
   interno de cada uma (hoje R$ 4.000 é um número só).
3. **Conta sem dados é estado normal**: três das quatro contas estão zeradas.
   A ingestão já trata `metrics_rows=0` como normal — isso precisa continuar
   valendo por conta, sem que uma conta vazia derrube o ciclo das outras. O
   laço já isola cada conta; falta garantir que um erro numa não aborte as
   demais (hoje aborta).
4. **Cockpit multi-conta**: a rota já aceita `?accountId=`, mas a tela não tem
   seletor.
5. **Alertas e aprovações** já são por conta — sem mudança prevista.

## Campo que NÃO existe: limite diário da Meta

O painel mostra um limite diário de R$ 354,52 definido pela Meta. **Nenhum
campo da API devolve esse número.** Sondados um a um na conta real:

| Campo                    | Resultado                        |
| ------------------------ | -------------------------------- |
| `spend_cap`              | 250000 (R$ 2.500,00) ✅          |
| `amount_spent`           | 63690 (R$ 636,90) ✅             |
| `min_daily_budget`       | 517 (R$ 5,17 — mínimo permitido) |
| `balance`                | 4                                |
| `adtrust_dsl`            | ❌ não existe (v19, v21 e v23)   |
| `daily_spend_limit`      | ❌ não existe                    |
| `spend_limit`            | ❌ não existe                    |
| `funding_source_details` | ❌ Permission Denied             |

Ou seja: o teto mensal da conta é legível e está implementado; **o limite
diário não é exposto pela API** e não foi inventado.

> 🔒 **Decidido: não configurar esse número à mão.** O teto mensal já vincula, e
> um valor fixo que a plataforma pode mudar sem avisar é exatamente o tipo de
> constante que esta onda existe para remover. O painel mostra R$ 354,52; a API
> não expõe esse campo em nenhuma versão testada. **Não procure de novo** — se
> um dia a Meta publicar o campo, ele entra por aqui, lido, nunca fixado.
