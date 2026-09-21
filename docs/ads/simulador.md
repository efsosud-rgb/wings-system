# Simulador, diff e visão agrupada (Etapa 6.7)

Três auxílios de leitura na tela de aprovação. **Nenhum deles decide nada**: a
única forma de mexer em orçamento continua sendo o portão da Etapa 4, uma
decisão de cada vez, registrada individualmente.

## O ponto que estas telas existem para deixar claro

A exposição é reservada **quando a alteração é solicitada**, não quando é
aprovada. Uma solicitação pendente já está dentro de `committed_cents`.

- **Aprovar** não aumenta o comprometido — libera o gasto de verdade na
  plataforma.
- **Recusar** devolve a reserva ao disponível do mês.

Por isso o simulador mostra dois totais (`committedWithRequestCents` e
`committedWithoutRequestCents`). Uma tela com um número só faria parecer que
aprovar não custa nada.

## 1. Antes e depois

Diff campo a campo do que muda: orçamento diário, situação da campanha (pausar
/ retomar), exposição até o fim do mês e o comprometido da conta.

**Aviso de divergência:** se o orçamento espelhado da campanha não bater mais
com o valor de origem da solicitação, a tela avisa antes da decisão. O executor
recusaria a execução nesse caso (`payload_hash` e estado da plataforma são
reconferidos), então avisar antes evita uma aprovação que nunca poderia ser
executada.

## 2. Simulação contra o teto

Colunas lado a lado — _Hoje_ (se recusada), _Como solicitado_ e, opcionalmente,
_Simulação_. Cada uma traz:

| Campo                 | Significado                                           |
| --------------------- | ----------------------------------------------------- |
| Orçamento diário      | valor do cenário                                      |
| Exposição da campanha | diário × dias restantes × 1,25 de sobreentrega (Meta) |
| Comprometido no mês   | total da conta naquele cenário                        |
| Ainda disponível      | menor folga entre teto e utilizável                   |
| Do utilizável / teto  | percentuais inteiros                                  |
| Fôlego                | dias que aquele diário aguentaria com o disponível    |

Um cenário que estouraria o utilizável ou o teto aparece destacado e dizendo
qual dos dois.

A caixa "E se o orçamento diário fosse…" é **exploração**: consulta
`GET /ads/approvals/:id/simulation?dailyBudgetCents=…`, que é somente leitura.
Para aplicar outro valor é preciso recusar e pedir uma nova alteração — o
sistema nunca aprova um número diferente do solicitado.

> A sobreentrega usada é a da Meta (1,25), e o simulador só atende alterações de
> campanhas existentes, que no Google o sistema não faz. Os fatores do Google
> (2,0× num dia, 1,0× no período) estão em `tetos-reais.md`.

## 3. Visão por campanha (lote)

`GET /ads/approvals-groups` agrupa as solicitações pendentes/escaladas pela
campanha que tocam, com o total que já reservam e a fatia do utilizável que
isso representa. Serve para ninguém aprovar o quarto aumento sem notar os três
anteriores.

**Não existe endpoint de aprovação em lote, e isso é deliberado.** Um clique que
move vários orçamentos de uma vez é exatamente o que a política de aprovação
existe para impedir. O grupo apenas linka para cada tela individual; a tela de
detalhe oferece "ir para a próxima decisão" da mesma campanha — navegação, nada
mais.

## Rotas

| Rota                            | Método | Permissão  | Efeito          |
| ------------------------------- | ------ | ---------- | --------------- |
| `/ads/approvals/:id/simulation` | GET    | `ads.read` | somente leitura |
| `/ads/approvals-groups`         | GET    | `ads.read` | somente leitura |
