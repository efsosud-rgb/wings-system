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

### Uma questão de desenho, não corrigida: reservas e reconciliação não se conhecem

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

Nada faz um pedido pendente expirar: o status `expired` existe, mas nenhum
código de produção o aplica, e `escalateStaleApprovals` também não tem
chamador. Pedidos esquecidos ficam pendentes para sempre.

**O que segura hoje:** toda alteração exige aprovação humana
(`mode: 'always'`); a reconciliação que roda _depois_ de um excesso o detecta
("orçamentos excedem o plano") e congela a conta; e o `spend_cap` da Meta é o
muro externo. Ou seja: **detecção depois do fato, não prevenção.** Aceitável
com uma pessoa aprovando uma alteração por vez; **não aceitável antes de
qualquer automação** (agente pedindo alterações, aprovação automática abaixo de
limiar, execução por worker).

**Conserto provável:** a reconciliação passa a calcular
`comprometido = exposição na plataforma + soma dos deltas positivos com reserva
ativa`, reduções só contam quando executadas, e o executor revalida o delta da
própria alteração contra o teto no instante da escrita. Mais um job que expira
pedidos velhos. Fica para depois da primeira escrita: o teste é uma pausa
única, supervisionada, e não passa por nenhum dos dois efeitos.

## Evidência

Testes novos (todos contra banco descartável, cliente falso):

- `ingest-cycle.test.ts` — 8 testes: conta que falha não derruba as outras;
  conta vazia é sucesso; conta sem período fica contida; conta que falhou não
  parece reconciliada.
- `executor.test.ts` — recusa sem reconciliação, recusa com reconciliação
  velha e **aceita depois de reconciliar**, recusa cliente de outra conta.
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
- [ ] De quanto em quanto tempo a ingestão agendada roda? Se for mais que
      120 min, a janela do dead-man precisa de ajuste ou a ingestão manual
      vira passo fixo do roteiro.
- [ ] Depois do deploy desta branch, o primeiro ciclo agendado termina sem
      congelar a Fly High.
