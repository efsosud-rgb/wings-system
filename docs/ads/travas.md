# Kill switch e dead-man switch — verificação antes da primeira escrita

Verificação feita em 18/09/2026, lendo o código e exercitando cada caminho em
testes contra um banco descartável. **Nada foi verificado contra staging nem
contra a Meta**, e `ADS_WRITES_ENABLED` não foi tocada. O que falta conferir em
staging está no fim.

## Resumo

| Mecanismo                         | Antes desta onda                                    | Agora                                             |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| Kill switch — bloqueia pedidos    | ✅ funcionava (`reserveChange`)                     | ✅ igual                                          |
| Kill switch — bloqueia execução   | ✅ funcionava (`executeApprovedChange`)             | ✅ igual                                          |
| Kill switch — como liberar        | ❌ **não havia caminho** fora de SQL manual         | ✅ `ops-cli release-kill-switch`, com auditoria   |
| Dead-man switch                   | ❌ **existia só em teste: nada o chamava**          | ✅ no executor e no fim de cada ciclo de ingestão |
| Resultado desconhecido — resolver | ❌ **não havia caminho**; a conta ficaria congelada | ✅ `ops-cli resolve-unknown`, lendo a plataforma  |
| Criar um pedido de alteração      | ❌ **não havia caminho** fora dos testes            | ✅ `ops-cli request`                              |
| Executor confere o próprio delta  | ❌ só olhava `comprometido ≤ permitido` (T-1)       | ✅ desde 01/11/2026 (parte 1, abaixo)             |
| Pedido velho expira               | ❌ `expired` existia, nada o gravava (T-8)          | ✅ desde 01/11/2026, no fim de cada ingestão      |

As quatro linhas com ❌ são o achado principal: o motor estava certo e testado,
mas as alavancas que uma pessoa puxa numa sessão real não existiam.

## O que o kill switch faz — e o que não faz

Quando `ad_accounts.kill_switch_engaged` é verdadeiro:

- nenhum pedido novo é aceito para a conta (`reserveChange` recusa e grava um
  evento de guardrail);
- nenhuma execução sai, **mesmo já aprovada** (`executeApprovedChange` recusa
  antes de qualquer chamada à plataforma);
- o cockpit mostra a trava.

**Ele não pausa nada na Meta.** É um congelamento do _nosso_ sistema, não da
conta de anúncios. Campanhas ativas continuam gastando. O muro externo é o
`spend_cap` da própria conta na Meta. Se algum dia a trava precisar também
pausar campanhas, isso é uma escrita automática — o oposto do que esta fase
quer — e merece decisão própria.

### Quem aciona

| Gatilho                                                         | Onde                     |
| --------------------------------------------------------------- | ------------------------ |
| Gasto reportado atingiu o teto, ou comeu o que estava reservado | `applyReportedSpend`     |
| Orçamentos na plataforma somam mais que o permitido no mês      | `reconcileAccount`       |
| Execução com resultado desconhecido                             | `executeApprovedChange`  |
| Reconciliação parada há mais de 120 min (dead-man)              | fim do ciclo de ingestão |

### Quem libera

Só uma pessoa, com `ops-cli release-kill-switch --account … --reason "…"`.
Grava `kill_switch_released` nos eventos de guardrail e
`ads.kill_switch_released` na auditoria. **Recusa** enquanto houver alteração
com resultado desconhecido na conta: a trava existe justamente porque ninguém
sabe o que a plataforma fez, e liberá-la antes deixaria uma segunda alteração
cair em cima da dúvida.

Liberar não conserta a causa. Se os orçamentos reais continuam acima do plano,
a ingestão seguinte aciona de novo — o conserto é ajustar o teto do período.

## O dead-man switch

Ideia: **não saber quanto está sendo gasto é emergência, não permissão para
continuar.** Se a reconciliação para, o teto passa a ser verificado contra um
número lembrado, não real.

`enforceReconciliationFreshness` estava escrito e testado, mas **nenhum código
de produção o chamava**. Em staging, portanto, ele nunca rodou. Agora age em
dois lugares, porque cada um cobre a falha do outro:

1. **No executor, antes de cada escrita** (`reconciliationFreshness`). Recusa
   com `reconciliation_stale` se a conta não reconciliou nos últimos 120 min —
   ou nunca neste mês. É uma recusa pura: não congela nada, não altera o
   pedido; roda-se a ingestão e clica-se de novo. Cobre o caso em que **o
   próprio job agendado morreu** — quem vigia não pode ser o único vigiado.
2. **No fim de cada ciclo de ingestão.** Contas servidas no ciclo estão frescas
   por construção; o que isso pega é a conta que vem **falhando ciclo após
   ciclo enquanto as outras seguem** — cenário que passou a existir quando um
   erro numa conta deixou de derrubar o ciclo inteiro. Essa conta é congelada
   até alguém olhar.

Duas correções de comportamento no caminho:

- **no executor**, um período aberto e **nunca reconciliado** conta como
  desconhecido: a data de criação do período diz quando começamos a olhar, não
  quanto foi gasto. (No fim do ciclo a data de criação continua valendo como
  ponto de partida, para uma conta recém-semeada não nascer congelada.)
- **contas arquivadas ficam de fora**: elas nunca reconciliam, por definição, e
  seriam congeladas à toa a cada ciclo.

### Interação com o isolamento por conta

Uma conta que falha **não** tem `lastReconciledAt` atualizado — há teste para
isso. O isolamento não pode virar um jeito de uma conta quebrada parecer
saudável.

## Outras três coisas encontradas no caminho de escrita

1. **O botão executava com o cliente da conta errada em potencial.** A rota
   montava o cliente a partir de `META_WRITE_ACCOUNT_ID`, não da conta dona da
   alteração. Com uma conta só, invisível — o mesmo formato do bug de ingestão
   registrado em [tetos-reais.md](tetos-reais.md). Agora o cliente é montado
   por alteração, e o executor recusa (`wrong_account`) um cliente de outra
   conta.
2. **Pedir uma pausa podia morrer numa constraint.** `reserveChange` devolvia a
   exposição inteira da campanha ao comprometido do mês; se o período nunca
   tinha contado aquela campanha (criada depois da última reconciliação, ou
   comprometido cortado pelo teto), o resultado ficava negativo e o banco
   recusava. Justo o pedido de _reduzir_ gasto. Agora tem piso em zero, como
   `releaseReservation` já fazia.
3. **O job de ingestão ganhava um cliente de escrita quando a flag estava
   ligada.** Ele só chama leituras, então nada aconteceria — mas agora é
   estrutural: a ingestão monta sempre um leitor, mesmo com a flag ligada.

### 🚫 Bloqueador de automação: reservas e reconciliação não se conhecem

> **Enquanto isto não for corrigido, nada de automação sobre gasto:** nenhum
> agente pedindo alteração, nenhuma aprovação automática, nenhum worker
> executando. Decisão de 18/09/2026. Com uma pessoa aprovando e executando uma
> alteração por vez, o risco é aceitável; no dia em que não for uma pessoa, é
> um bug de dinheiro. A regra também está no `AGENTS.md` (seção "What never to do").

> O chat do agente (Onda 7, `agente-conversa.md`) **não** mexe nesta regra: o
> agente só propõe. Quem pede é a pessoa que clica em "Criar pedido", uma
> alteração por vez, e o pedido fica marcado como "sugerido pelo agente".

O comprometido do mês (`committed_cents`) tem **dois donos que não conversam**:

- `reserveChange` soma o delta de cada pedido **na hora do pedido**;
- `reconcileAccount` **sobrescreve** o número a cada ciclo com a exposição que
  está de fato na plataforma, sem olhar as reservas ativas
  (`reservation_active`).

Disso saem dois efeitos, espelhados:

1. **Reduções liberam espaço antes de existir.** Uma pausa pedida e nunca
   executada baixa o comprometido na hora. Cinco pausas pedidas = o espaço de
   cinco campanhas "livre" no sistema, com as cinco ainda gastando. Um aumento
   pedido nessa janela passa no teto contra um espaço que não existe. Dura até
   a reconciliação seguinte, que recalcula pela plataforma e devolve o número
   real — mas o aumento já reservado e aprovado continua aprovado.
2. **Aumentos aprovados somem do comprometido.** Um aumento reservado e ainda
   não executado não está na plataforma, então a reconciliação seguinte o
   apaga do comprometido. Dois aumentos que sozinhos cabem, mas juntos não,
   podem ser ambos aprovados e ambos executados. O executor só confere
   `comprometido ≤ permitido`, não que o delta _desta_ alteração ainda esteja
   contado.

Nada fazia um pedido pendente expirar: o status `expired` existia, mas nenhum
código de produção o aplicava. Desde 01/11/2026 a expiração existe (parte 1,
abaixo). `escalateStaleApprovals` continua sem chamador.

**O que segura hoje:** toda alteração exige aprovação humana
(`mode: 'always'`); a reconciliação que roda _depois_ de um excesso o detecta
("orçamentos excedem o plano") e congela a conta; e o `spend_cap` da Meta é o
muro externo. Ou seja: **detecção depois do fato, não prevenção.** Aceitável
com uma pessoa aprovando uma alteração por vez; **não aceitável antes de
qualquer automação** (agente pedindo alterações, aprovação automática abaixo de
limiar, execução por worker).

**Conserto aprovado pelo Eric em 29/10/2026 ("aprovar o conserto inteiro"),
em duas partes.** A regra acima (nada de automação sobre gasto) vale até as
duas estarem prontas.

- **Parte 1 (01/11/2026, esta seção):** o executor revalida o delta da própria
  alteração contra o teto no instante da escrita, numa transação, e um job
  expira pedidos velhos.
- **Parte 2 (a fazer):** um cálculo único do comprometido —
  `exposição na plataforma + soma dos deltas positivos com reserva ativa`,
  reduções só contam quando executadas — usado pela reconciliação e pelo
  pedido. É ela que fecha T-1 e T-3 na conta; a parte 1 impede que o número
  errado vire dinheiro.

### Parte 1: o que mudou (01/11/2026)

**1. O executor julga o próprio delta na hora da escrita**
(`claimWithinCeiling` em `budget-guard.ts`). Na mesma transação que marca a
alteração como `executing`, com a linha do período travada (`FOR UPDATE`), o
executor confere de novo:

- que a alteração continua `approved` **e com a reserva ativa** — uma aprovada
  sem reserva (o que a corrida de T-4 deixava) é recusada com
  `reservation_missing`;
- que a trava de emergência continua livre;
- que o pedido é do mês que está correndo (o delta foi calculado com os dias
  daquele mês);
- e, se o delta é positivo, que **o que está rodando de verdade + o delta
  desta alteração** cabe nos três tetos (parcela utilizável, limite da
  plataforma, teto − gasto), pela mesma regra do pedido (`ceilingRefusal`).
  "O que está rodando" é a exposição do espelho das campanhas
  (`mirroredExposureCents`, a mesma conta que a reconciliação usa) mais o delta
  positivo de qualquer outra alteração da conta em `executing` ou `unknown`. O
  `committed_cents` gravado **não** entra: é justamente o número que a
  reconciliação reescreve sem as reservas.

Consequências: dois aumentos que cabem sozinhos mas não juntos não saem os
dois, nem em sequência (o segundo vê o primeiro no espelho) nem ao mesmo tempo
(o segundo espera a trava do período e vê o primeiro em `executing`). Uma
**redução** (delta ≤ 0) nunca é barrada pelo teto. A recusa não muda nada: a
alteração continua aprovada e pode sair quando houver espaço (ou expira).
Mensagem na tela: "No instante da execução, o orçamento do mês não comporta
esta alteração: …".

**2. Uma decisão só vale (T-4).** Aprovar, rejeitar e expirar movem o pedido
**só a partir de `pending_approval`**, com a trava do período tomada primeiro.
Duas decisões no mesmo instante: uma vale, a outra recebe `already_decided`
(409). A ordem das travas é sempre período → pedido → aprovação, nas quatro
transições (decisão, expiração, devolução, execução), então nenhuma trava a
outra num impasse.

**3. Devolver uma reserva não quebra mais no meio (T-5) nem devolve duas vezes
(T-2).**

- Uma reserva feita **antes** da última reconciliação já foi apagada por ela;
  rejeitar ou expirar esse pedido só desliga a reserva, sem mexer no
  comprometido. Antes, o delta era tirado de novo (aumento) ou somado de novo
  (pausa).
- Devolver uma redução cujo espaço já foi dado a outro pedido passaria do
  teto: o comprometido é gravado no teto e a **trava é acionada** (como
  `applyReportedSpend` faz com gasto que comeu a reserva), em vez de a rota
  responder 500 e o pedido ficar preso.

**4. Pedidos velhos expiram** (`expireStaleChanges` em `expiry.ts`), no fim de
cada ciclo de ingestão — o completo e o de 15 min (`--reconcile-only`), logo
depois do dead-man switch:

| Situação do pedido                   | Expira quando                       |
| ------------------------------------ | ----------------------------------- |
| `pending_approval` (ninguém decidiu) | 24 h depois do pedido               |
| `approved` (ninguém executou)        | 24 h depois da **aprovação**        |
| qualquer um dos dois                 | quando o mês do período dele acabou |

Ao expirar: o pedido vira `expired`, a reserva é devolvida (regra do item 3), a
aprovação pendente vira `expired` ("Expirada sem decisão"), e a auditoria grava
`ads.change_expired` com o motivo (`age` ou `month_turned`). Nada é aprovado,
executado ou enviado à plataforma. Um pedido que não consegue expirar é
registrado no log da ingestão (`NÃO expirou`) e não impede os outros. Para
fazer de novo, faz-se um pedido novo, com aprovação nova. O prazo de 24 h é a
opção mais segura enquanto o Eric não define outro (`CHANGE_REQUEST_MAX_AGE_HOURS`).

**O que a parte 1 não resolve:** o número `committed_cents` continua errado
entre uma reconciliação e outra (T-1, T-3) — um pedido pode ser **aceito**
contra um espaço que não existe. O que muda é que ele não pode mais ser
**executado** contra esse espaço. A reconciliação continua sem trava (variante
de T-1: reserva feita durante o reconcile se perde). As duas coisas são a
parte 2.

## Evidência

Testes novos (todos contra banco descartável, cliente falso):

- `ingest-cycle.test.ts` — 8 testes: conta que falha não derruba as outras;
  conta vazia é sucesso; conta sem período fica contida; conta que falhou não
  parece reconciliada.
- `executor.test.ts` — recusa sem reconciliação, recusa com reconciliação
  velha e **aceita depois de reconciliar**, recusa cliente de outra conta.
- `write-time-guard.test.ts` (parte 1, 01/11/2026) — teto exato passa e um
  centavo de exposição a mais é recusado sem nada enviado; duas execuções
  simultâneas que só cabem sozinhas: uma sai; aprovar e rejeitar (e aprovar e
  expirar) ao mesmo tempo: uma vale; aprovada sem reserva e pedido de outro
  mês recusados; pausa num mês cheio sai; rejeitar ou expirar uma pausa cujo
  espaço foi usado aciona a trava em vez de quebrar; devolução depois de um
  reconcile não conta duas vezes; expiração por idade, pela aprovação e pela
  virada do mês; um pedido que falha não impede os outros.
- `reconcile.test.ts` — arquivada fica de fora; nunca reconciliada é
  desconhecida.
- `ops.test.ts` — o roteiro da primeira escrita ponta a ponta: pedido →
  aprovação → execução → plataforma pausada → segundo clique recusado; com a
  flag desligada a plataforma fica intocada; timeout depois de aplicar congela
  a conta, a trava **não** pode ser liberada antes de resolver, resolver não
  libera sozinho; pedido perdido que não chegou devolve a reserva e nunca é
  re-executado.

## O que ainda precisa ser conferido em staging (por uma pessoa)

Não tive acesso ao banco de staging — a leitura foi negada pelo modo de
permissão desta sessão, e não contornei.

- [ ] `ops-cli status`: a trava da Fly High está livre **hoje**? Com 84
      campanhas reais e teto interno de R$ 4.000 × 70%, é plausível que a regra
      "orçamentos excedem o plano" já a tenha acionado. Se estiver, a primeira
      escrita está bloqueada até ajustarmos o teto.
- [ ] `ops-cli preflight`: o token tem `ads_management`?
- [x] De quanto em quanto tempo a ingestão agendada roda? Respondido em
      2026-09-25: a ingestão completa (campanhas, ads, métricas, quebras,
      alertas) segue com o cron que já existia — só ela não bastava para
      manter a janela de 120 min folgada se algum ciclo atrasasse. Agora existe
      uma segunda tarefa agendada no Coolify, `ingest-cli --reconcile-only`, a
      cada 15 min: só o que `reconcileAccount` lê (saldo, teto da plataforma,
      orçamento e status das campanhas), sem métricas nem quebras. Ver
      `docs/ads/reconciliacao-15min.md` para a conta de operações da API do
      Google e como configurar `ADS_RECONCILE_CRON`.
- [ ] Depois do deploy desta branch, o primeiro ciclo agendado termina sem
      congelar a Fly High.
