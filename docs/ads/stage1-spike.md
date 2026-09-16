# Agente de Tráfego Pago — Etapa 1 (spike, sem dinheiro real)

Esta etapa **não gasta nada e não fala com a Meta**. Ela verifica premissas e
constrói o ambiente onde toda a lógica de orçamento será exercitada, já que a
Wings **não possui contas de sandbox** — todas as credenciais apontam para
contas ativas com dinheiro real.

## 1. A Meta tem um teto nativo de gastos? **Sim**

| Campo                     | Significado                                                        | Unidade                 |
| ------------------------- | ------------------------------------------------------------------ | ----------------------- |
| `spend_cap` (conta)       | Limite total; ao ser atingido, **a Meta pausa todas as campanhas** | inteiro em **centavos** |
| `amount_spent` (conta)    | Quanto já foi gasto em relação ao `spend_cap`                      | inteiro em **centavos** |
| `spend_cap_action=reset`  | Zera `amount_spent` (usado na virada do mês)                       | —                       |
| `spend_cap_action=delete` | Remove o teto                                                      | —                       |

Consequências para o projeto:

- O teto nativo será a **Camada 0** da proteção: mesmo que todo o nosso software
  falhe, a Meta interrompe a entrega em R$10.000.
- Um novo `spend_cap` **só vale para gastos posteriores** à sua definição, então
  a virada de mês é feita com `spend_cap_action=reset`, não recalculando valores.
- A Meta recomenda margem de 15–25% acima do orçamento planejado justamente por
  causa da sobre-entrega (ver item 3).

## 2. Ciclo de vida do token: use **System User**

| Tipo de token                      | Expira?                  |
| ---------------------------------- | ------------------------ |
| Usuário (curto)                    | 1–2 horas                |
| Usuário (longo)                    | ~60 dias                 |
| **System User (Business Manager)** | **Não expira por tempo** |

Decisão: usar **System User token** com permissão `ads_management`. Ele não
expira por tempo, mas **pode ser invalidado** (troca de senha do administrador,
remoção de permissão, revisão do app). Portanto:

- verificação diária de saúde da credencial, com alerta **antes** da falha;
- credencial inválida = **falha fechada**: o agente é suspenso e o responsável
  avisado. Nunca "para de gerenciar em silêncio".

## 3. Duas armadilhas de dinheiro confirmadas

**a) Unidades inconsistentes.** A referência da conta de anúncios descreve
`spend_cap` em unidades inteiras da moeda ("23.50"), enquanto a referência de
campanha e os guias de campo descrevem inteiros em **subunidade** (centavos).
Documentação contraditória em campo monetário é um erro de 100× esperando
acontecer. Por isso:

- tudo interno é **centavos inteiros** (`Cents`), nunca float;
- conversão só na fronteira com a plataforma;
- **`assertPlausibleAmount()`** barra qualquer valor fora de uma janela sensata
  antes de sair do sistema (um erro de 100× não chega à Meta);
- a Etapa 3 **confere as unidades lendo a conta real** (somente leitura) e
  comparando com o Gerenciador de Anúncios, antes de qualquer escrita.

**b) Insights usa outra unidade.** `spend` nos Insights é **string decimal em
reais** ("48.71"), enquanto orçamentos são centavos inteiros ("5000"). Os
fixtures registram os dois formatos para que o parser seja testado contra a
realidade, não contra a suposição.

**c) Números chegam como string.** `daily_budget: "5000"`, não `5000`.

## 4. Sobre-entrega: orçamento não é gasto

A Meta permite entregar **até 25% acima** do orçamento diário (compensando
depois). Qualquer cálculo que trate "orçamento diário = gasto diário" subestima
a exposição. O simulador reproduz isso, então o código que assumir o contrário
falha nos testes antes de falhar no dinheiro.

## 5. Isolamento de rede nos testes (obrigatório)

`apps/api/src/test/no-network.ts` roda como `setupFile` em **todos** os pacotes:

1. substitui `fetch`, `http.request/get` e `https.request/get` por funções que
   lançam erro — nenhuma requisição sai;
2. **aborta a suíte inteira** se qualquer credencial de plataforma estiver
   presente no ambiente (`META_ACCESS_TOKEN`, `ADS_TOKEN_KEY`, etc.).

Há teste provando que o bloqueio funciona — a garantia não fica em suposição.

## 6. Simulador (`FakeMetaClient`)

Reproduz de propósito o que faz dinheiro escapar:

- sobre-entrega de até 25%;
- **atraso de relatório**: o gasto real existe antes de a plataforma informar;
- teto da conta pausando **todas** as campanhas ao ser atingido;
- `unknown` após timeout **com a alteração aplicada** (o caso mais perigoso:
  repetir a chamada às cegas é o bug clássico);
- rate limit (80004), token inválido (190), orçamento abaixo do mínimo;
- registro de todas as chamadas para auditoria.

A interface `AdsPlatformClient` **não expressa** criar campanha, editar criativo
ou mudar segmentação — o escopo da V1 é orçamento em campanhas existentes, e o
que a interface não permite, nenhum bug ou agente consegue fazer.

## Fontes

- Ad Account, Marketing API (`spend_cap`, `amount_spent`, `spend_cap_action`)
- Campaign / budgets, Marketing API (unidades de orçamento)
- Access tokens, Facebook Login (tempos de vida; System User não expira)
- Meta Business Help — redefinir limite de gastos da conta; margem de 15–25%
