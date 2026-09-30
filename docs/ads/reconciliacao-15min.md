# Reconciliação a cada 15 minutos, e "Atualizar agora"

Onda de 2026-09-25. Problema: o quadro de teto/verba (Construtor → "Teto real
da conta", painel de aprovação) só refletia crédito novo, orçamento alterado ou
campanhas pausadas/retomadas na Meta e no Google depois do próximo ciclo da
ingestão completa — e o executor recusa escrever com reconciliação acima de
120 min (`RECONCILIATION_MAX_AGE_MINUTES`, ver `docs/ads/travas.md`). Isso
tornava a janela do dead-man apertada demais para ser confortável, e ninguém
tinha como pedir um número mais fresco sem rodar `ingest-cli` num shell.

## O que mudou

A ingestão sempre fez tudo num só ciclo: `reconcileAccount` (saldo, teto da
plataforma, orçamento e status das campanhas) seguido de sincronizar anúncios,
três níveis de métricas, as quebras de audiência, o dia da conta e os alertas
— um ciclo pesado, propositalmente mais espaçado.

Agora existem **dois ciclos, duas tarefas agendadas no Coolify**:

| Tarefa                            | O que faz                                                                              | Cadência sugerida | Variável de cron       |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------ | ----------------------- |
| `ingest-cli`                       | Ciclo completo: o de sempre (campanhas, anúncios, métricas, quebras, dia, alertas)        | a que já existe    | `ADS_INGEST_CRON`       |
| `ingest-cli --reconcile-only`      | Só `reconcileAccount`: saldo, teto da plataforma, orçamento e status das campanhas         | a cada 15 min       | `ADS_RECONCILE_CRON`    |

`runReconciliationCycle` (`apps/api/src/modules/ads/ingest-cycle.ts`) é o novo
ciclo leve — mesma isolação por conta que o ciclo completo (uma conta que
falha não impede as outras), mas sem tocar `syncAds`, `ingestMetrics`,
`ingestBreakdown`, `recordAccountDay` nem `runAlerts`. As duas tarefas
continuam **só leitura**: nenhuma escreve na Meta nem no Google.

O dead-man switch (`enforceReconciliationFreshness`) roda no fim dos dois
ciclos. Na prática é o ciclo rápido que mantém as contas frescas; o ciclo
completo continua checando por trás, para o caso de a própria tarefa de 15 min
parar de rodar.

## Configurar a segunda tarefa no Coolify (staging)

1. Duplicar a tarefa agendada existente do `ingest-cli`, trocando o comando
   para `node dist/modules/ads/ingest-cli.js --reconcile-only` e o
   agendamento para `*/15 * * * *`.
2. Definir `ADS_RECONCILE_CRON=*/15 * * * *` nas variáveis de ambiente da
   aplicação (mesma ideia de `ADS_INGEST_CRON`: só informa a tela, não agenda
   nada por si — ver `.env.example`).
3. Nenhuma outra variável nova: a tarefa usa as mesmas credenciais
   (`META_WRITE_TOKEN`, Google) e sempre força leitura
   (`ADS_WRITES_ENABLED: false` no cliente, independente do valor real da
   flag — ver `ingest-cli.ts`).

## Quanto isso custa na cota da API do Google

Nível de acesso "Exploração" (o que a Wings tem hoje): **2.880 operações por
dia** contra contas de produção — confirmado na documentação do Google Ads
API (cada `Search`/`SearchStream` conta como 1 operação, não por linha
retornada; paginação não conta operação extra).

`reconcileAccount` faz, por conta, no cliente do Google
(`google-ads-client.ts`): `getAccount` → 1 busca; `listCampaigns` → 2 buscas
em paralelo (campanhas + gasto do mês); `listAdSets` → 0 (Google não tem
orçamento por ad set); `getSpend` → 1 busca. **4 operações por conta por
ciclo.**

A 15 min (96 ciclos/dia): **384 operações/dia por conta**. Com as poucas
contas Google que a Wings roda hoje (uma ou duas), isso fica muito abaixo do
teto de 2.880 — a folga é de mais de 7×, mesmo que uma terceira ou quarta
conta Google entre depois. O que pesava na cota era o ciclo completo
(métricas em três níveis, quebras de audiência), e esse continua na cadência
de sempre.

Meta não tem um teto diário fixo equivalente — a limitação é uma janela
rolante de "pontos" por hora por app, bem mais folgada para 4
chamadas/conta/15 min.

## "Atualizar agora"

`POST /ads/accounts/:accountId/reconcile-now` — mesma leitura do ciclo rápido,
uma vez, sob clique.

- **Quem pode**: permissão nova `ads.reconcile.manual`, concedida a Admin
  Master e Diretoria (o mesmo par de `ads.approve`) — ver
  `packages/shared/src/rbac/permissions.ts`.
- **Trava contra cliques repetidos**: 30 segundos de cooldown, contados a
  partir do último `lastReconciledAt` da conta (de qualquer origem — manual ou
  do ciclo agendado), mais uma trava em memória contra dois cliques quase
  simultâneos antes do primeiro terminar. Curto de propósito: isto é uma
  leitura, não uma escrita — o risco de um clique duplicado é gasto de cota
  da API, não dinheiro.
- **Nunca escreve**: o cliente da plataforma é sempre construído com
  `ADS_WRITES_ENABLED: false`, igual às duas tarefas agendadas.
- Botão em dois lugares: Construtor → "Teto real da conta"
  (`AccountCeiling` em `PaidMediaBuilder.tsx`) e no painel de aprovação
  (`PeriodContext` em `ApprovalDetailPage.tsx`), via o componente comum
  `ReconcileNowButton`.

## "atualizado há X min"

Todo número lido da plataforma agora tem um rótulo de idade ao lado
(`agoLabel`, `apps/web/src/components/campaign-builder/format.ts`):

- O teto real da conta usa `pacing.lastReconciledAt` — a idade da última
  reconciliação completa da conta, não só do teto.
- O saldo/crédito informado pela plataforma continua usando
  `pacing.platformLimitSyncedAtIso` (praticamente o mesmo instante, já que
  ambos são gravados na mesma chamada de `reconcileAccount`).
- O painel de aprovação mostra `approval.periodLastReconciledAt` junto do
  bloco "Orçamento do mês nesta conta".
- O cabeçalho do Dashboard de marketing ganhou uma segunda linha, "Última
  reconciliação", ao lado da existente "Última ingestão" — cada uma com seu
  próprio aviso de atraso, para não confundir um ciclo parado com o outro.

## Verificado

- Testes automatizados: `runReconciliationCycle` (isolamento por conta,
  contas sem credenciais, falha de uma não trava as outras — igual ao ciclo
  completo), a rota `reconcile-now` de ponta a ponta contra uma Meta
  encenada (`fakeMetaApi`, estendida com as leituras de conta/insights/ad
  sets que faltavam), permissão, cooldown e o caso sem credenciais.
- **Não verificado em staging**: a segunda tarefa agendada ainda não existe no
  Coolify (passo manual acima), `ADS_RECONCILE_CRON` ainda não está definida,
  e o botão "Atualizar agora" ainda não foi clicado contra a Meta real.

## Saldo, limite de gastos e próxima cobrança da Meta (2026-09-30)

Problema: o construtor (bloco 11) mostrava "Saldo/crédito informado pela
plataforma" R$ 991,79 e não mudava depois de o Eric pôr crédito na Meta. A
rotina estava rodando (a cada 15 min, sem erro); o número era outro:
`spend_cap − amount_spent`, o **limite de gastos da conta**, não saldo.

Leitura só-GET da conta `act_694058302567457` em 30/09 16:34 UTC:

| Campo da Graph API       | Valor                    | O que é                                                   |
| ------------------------ | ------------------------ | --------------------------------------------------------- |
| `spend_cap`              | 250000 (R$ 2.500,00)     | limite de gastos; a Meta para de entregar ao atingi-lo     |
| `amount_spent`           | 152084 (R$ 1.520,84)     | gasto contado contra o limite                             |
| `balance`                | 6008 (R$ 60,08)          | gasto ainda não cobrado: o que a próxima cobrança leva    |
| `is_prepay_account`      | false                    |                                                           |
| `funding_source_details` | type 1, "Mastercard …"   | cartão; nenhum campo traz saldo pré-pago                  |

O "Saldo total R$ 1.552,67" da tela de cobrança da Meta **não existe na API**
para esta conta. A diferença entre ele e "R$ 1.497,99 disponível após seu
próximo pagamento" (R$ 54,68) é o `balance` daquele momento.

O que mudou:

- O cliente Meta lê também `balance`. Cada leitura grava em
  `ad_budget_periods` o limite, o gasto, a próxima cobrança, o saldo
  pré-pago (quando a plataforma diz) e o tipo de pagamento
  (migração **0050**).
- Toda tentativa grava `platform_read_attempted_at`; uma falha grava
  `platform_read_error`. Falha, ou nenhuma leitura boa há mais de 45 min
  (três ciclos), e a tela mostra **"—" e o motivo** em cada linha e no "Teto
  real" — nunca o número antigo.
- O construtor pede uma leitura ao abrir e a cada 5 min enquanto aberto
  (`POST /ads/accounts/:id/platform-refresh`, `ads.read`): um GET na conta,
  sem campanhas, sem gasto, sem tocar `committed_cents` nem
  `last_reconciled_at`. O servidor pula a chamada se a conta foi lida (ou
  tentada) nos últimos 2 min. A tarefa de 15 min continua sendo a cadência de
  fundo.
- Bloco 11: "Limite de gastos da conta na Meta" (resta X de Y), "Próxima
  cobrança da Meta" e "Saldo pré-pago na Meta" ("—": a API não informa para
  conta paga por cartão), cada linha com "lido em DD/MM HH:MM".
- Alerta vermelho "A Meta vai pausar a conta por volta de DD/MM, aumente o
  limite de gastos" quando as campanhas ativas + a nova passam do limite
  antes do fim (`projectSpendCapPause`, `@wings/shared`). Cada dia custa a
  verba diária cheia, hoje incluído, por isso a data erra para cedo.
- **Redefinição do limite**: a Meta mostra "A redefinição ocorre no primeiro
  dia de cada mês" só na tela de cobrança; a API não diz. É uma regra da
  conta (`ad_accounts.spend_cap_reset`: `monthly` ou vazio), que quem tem
  `ads.budget_caps.manage` muda no próprio bloco
  (`PUT /ads/accounts/:id/spend-cap-reset`, auditado). A migração 0050 marca
  `monthly` só para `act_694058302567457`, pelo que o Eric viu em 30/09. Com
  `monthly`, a previsão vai até o fim do mês com o que resta e, no dia 1º,
  volta ao limite cheio; a tela diz "limite volta a R$ 2.500,00 em 01/MM".
  Sem regra, o que resta é tudo.
