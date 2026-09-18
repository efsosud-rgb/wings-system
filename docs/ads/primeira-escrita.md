# Primeira escrita real na Meta — roteiro

Roteiro para seguir **na hora**, sem improvisar. Alvo: conta Fly High
(`act_694058302567457`), em **staging**, com o gestor de tráfego e o aprovador
(Admin Master) presentes. Prazo de trabalho: quarta, 23/09/2026.

> **Regra da sessão:** `ADS_WRITES_ENABLED` só sobe com o aprovador presente, e
> desce logo depois do clique. Ninguém liga essa flag sozinho — nem pessoa, nem
> agente.

## O que será escrito

**Pausar uma campanha** (`pause_campaign`), escolhida pelo gestor.

- Só reduz gasto. Desfaz-se com um clique no Gerenciador de Anúncios.
- Exercita o caminho inteiro: pedido → aprovação → execução → releitura na
  plataforma → reconciliação na ingestão seguinte.

> ⚠️ **O sistema hoje só sabe mexer em campanha**, não em anúncio. Os alertas
> de desgaste apontam para _anúncios_, mas a interface da plataforma
> (`AdsPlatformClient`) só expressa `set_daily_budget`, `pause_campaign` e
> `resume_campaign` — de propósito: "o que a interface não expressa, nenhum bug
> faz". Pausar um _anúncio_ exige código novo (`pause_ad`) e é decisão separada.
> Para a primeira escrita, peça ao gestor uma **campanha** que ele pausaria de
> qualquer forma — idealmente a do criativo mais desgastado, se ele concordar
> que a campanha inteira saturou — ou uma campanha pequena, de gasto baixo.

## Onde os comandos rodam

No terminal do container da **API de staging** (Coolify → aplicação da API →
Terminal). Todos são `node dist/modules/ads/ops-cli.js <comando>`. **Nenhum
comando do `ops-cli` escreve na Meta** — o único caminho de escrita é o botão
**Executar no Meta**.

| Comando                                                  | O que faz                                                |
| -------------------------------------------------------- | -------------------------------------------------------- |
| `status`                                                 | trava, idade da reconciliação e alterações em aberto     |
| `preflight`                                              | confere se o token tem `ads_management` (só leitura)     |
| `alerts`                                                 | folha dos alertas abertos, para levar ao gestor          |
| `request --account … --campaign … --kind … --reason "…"` | cria o pedido de alteração, que cai na fila de aprovação |
| `resolve-unknown --change <uuid>`                        | resolve um resultado desconhecido lendo a plataforma     |
| `release-kill-switch --account … --reason "…"`           | libera a trava, com registro em auditoria                |

## Antes do dia (até terça, 22/09)

1. **Esta branch revisada e em staging.** Sem ela não existe como criar o
   pedido nem como sair de uma trava. Depois do deploy, confirme que a ingestão
   agendada rodou ao menos uma vez com o código novo.
2. `ops-cli status` — a Fly High precisa mostrar **`trava: livre`** e
   reconciliação recente.
   - Se a trava estiver **ACIONADA**, leia o motivo. O mais provável é
     "Orçamentos na plataforma excedem o limite planejado do mês": os
     orçamentos reais somam mais que a parcela utilizável do teto interno. Isso
     **não se resolve liberando a trava** — a ingestão seguinte aciona de novo.
     Resolve-se ajustando o teto do período à realidade. Traga o número para
     decidirmos antes da sessão.
   - As três contas vazias podem aparecer com `reconciliação: NUNCA`. É normal
     e não afeta a Fly High.
3. `ops-cli preflight --expect-user 122100843567479497` — precisa terminar com
   **"token apto a escrever"** e **"pertence ao usuário esperado"**. O id é o do
   usuário de sistema `wingstrafficwrite`, criado no BM (é o que `/me` devolve
   para o token dele; confira em Usuários do sistema no BM): um token emitido
   por ele não morre quando o acesso do gestor for removido. Se `ads_management`
   estiver AUSENTE, a Meta recusaria a escrita na hora; se o dono for outro, o
   token pode depender de uma pessoa. Nos dois casos, gere um token novo antes
   da sessão.
4. Saiba **de quanto em quanto tempo a ingestão agendada roda** (Coolify →
   Scheduled Tasks). O executor recusa escrever se a última reconciliação tiver
   mais de **120 minutos**. Se o agendamento for mais espaçado que isso, rode a
   ingestão à mão na janela (passo 6).

## Na janela

Tenha abertos: o Wings System em staging, o Gerenciador de Anúncios (na tela do
gestor), o Coolify e o terminal da API.

### 1. Estado inicial

```
node dist/modules/ads/ops-cli.js status
```

**Espere:** Fly High com `trava: livre`, `0 com resultado DESCONHECIDO`.
**Se não:** pare. Nada de ligar a flag com a trava acionada.

### 2. Escolher a campanha, com o gestor

No Gerenciador, o gestor escolhe a campanha. Anote:

- o **ID da campanha** (coluna "Identificação da campanha", ~18 dígitos);
- que ela está **Ativa**, e o orçamento diário atual.

Esse registro é a prova do "antes".

### 3. Criar o pedido

```
node dist/modules/ads/ops-cli.js request \
  --account act_694058302567457 \
  --campaign <ID da campanha> \
  --kind pause_campaign \
  --reason "Primeira escrita supervisionada — pausa combinada com o gestor"
```

**Espere:** `solicitação criada: alteração <uuid>` (**anote esse uuid**), uma exposição **negativa ou zero** (pausar só
devolve orçamento), o caminho `/marketing/trafego-pago-wings/aprovacoes/<id>` e
a frase **"Nada foi enviado à plataforma."**

**Se `recusado`:** `campaign_not_found` → o ID está errado ou a ingestão ainda
não espelhou a campanha. `kill_switch_engaged` → volte ao passo 1.

### 4. Aprovar

Abra o caminho impresso. Confira na tela: **a campanha é a certa**, o tipo é
pausa (antes "Ativa", depois "Pausada"). Escreva o motivo e clique **Aprovar**.

**Espere:** "Aprovada por … em …". Abaixo aparece o bloco **Execução na
plataforma**, com o aviso _"A execução em contas reais está desligada nesta
configuração"_ e o botão **Executar no Meta desabilitado**.

Esse é o estado seguro: aprovado, e nada saiu. **Confira no Gerenciador que a
campanha continua Ativa.**

### 5. Ligar a escrita

No Coolify, na API de staging: `ADS_WRITES_ENABLED=true` → **Redeploy**. A API
lê o ambiente ao subir, então sem redeploy nada muda. O container roda
migração e seed ao subir; ambos são seguros de repetir. Sessões ficam no banco:
ninguém é deslogado.

**Espere:** depois do deploy, recarregue a tela da aprovação — o aviso some e o
botão **Executar no Meta** fica habilitado.

### 6. Garantir reconciliação fresca

```
node dist/modules/ads/ops-cli.js status
```

Se a reconciliação da Fly High tiver mais de ~90 min, rode a ingestão agora
(leva alguns minutos; é somente leitura):

```
node dist/modules/ads/ingest-cli.js
```

**Espere:** a linha da Fly High com `reconcile: … campanhas`, **sem**
`[TRAVA ACIONADA]`. Uma conta vazia que falhe aparece como `FALHOU em …` e
**não** impede as outras — o comando termina com erro no fim, e tudo bem para
o teste, desde que a Fly High tenha passado.

### 7. O clique

Com o gestor olhando o Gerenciador: clique **Executar no Meta**, **uma vez**.

| O que aparece                                                      | Significa                                               | O que fazer                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| "Alteração aplicada na plataforma." · situação **executada**       | A Meta aceitou e a releitura confirmou                  | Passo 8                                                                                 |
| "Trava de emergência acionada."                                    | Trava ligou entre o passo 1 e agora                     | `status`, leia o motivo; pare                                                           |
| "A última reconciliação tem N min…" / "ainda não foi reconciliada" | Dead-man switch: gasto real desconhecido                | Passo 6, depois clique de novo                                                          |
| "O cliente da plataforma não pertence à conta…"                    | Defeito de configuração                                 | Pare; desligue a flag                                                                   |
| "A execução em contas reais está desligada…"                       | O redeploy não pegou a flag                             | Confira a variável e o deploy                                                           |
| Erro com mensagem da Meta (422)                                    | A Meta **recusou**; nada mudou; a reserva foi devolvida | Anote o código. 190 = token; 200/10 = permissão. Faça um pedido novo depois de corrigir |
| "A plataforma não confirmou o resultado. A conta foi congelada…"   | **Resultado desconhecido**                              | Seção "Se o resultado for desconhecido"                                                 |

Um segundo clique nunca repete a escrita: o executor recusa com "Esta
alteração já foi executada".

### 8. Conferir na plataforma

O gestor confirma no Gerenciador: **campanha Pausada**. Essa é a prova do
"depois". Na tela da aprovação, a trilha de auditoria mostra
`ads.change_executed`.

### 9. Desligar a escrita — imediatamente

Coolify: `ADS_WRITES_ENABLED=false` → **Redeploy**.

**Espere:** recarregando qualquer aprovação aprovada, o botão volta a ficar
desabilitado com o aviso de execução desligada. `ops-cli status` mostra
`ADS_WRITES_ENABLED neste processo: desligado`.

### 10. Fechar o ciclo: reconciliação

```
node dist/modules/ads/ingest-cli.js
node dist/modules/ads/ops-cli.js status
```

**Espere:** Fly High reconciliada, **sem** `[TRAVA ACIONADA]`, comprometido do
mês igual ou menor que antes. No cockpit, a campanha aparece pausada. Isso
prova que a escrita feita pelo sistema e a leitura feita pela ingestão contam a
mesma história.

## Como desfazer

**Caminho principal — Gerenciador de Anúncios.** O gestor reativa a campanha
com um clique. Não depende do Wings System, da flag nem da trava; é o desfazer
que funciona mesmo se tudo do nosso lado estiver quebrado. A ingestão seguinte
espelha a campanha de volta como ativa.

**Caminho pelo sistema — é a segunda escrita.** Com a flag ainda ligada:

```
node dist/modules/ads/ops-cli.js request --account act_694058302567457 \
  --campaign <ID> --kind resume_campaign --reason "Desfazendo a pausa de teste"
```

Aprove e execute como antes. Atenção: **reativar aumenta a exposição do mês** e
pode ser recusado pelo teto (`usable_would_be_exceeded`,
`platform_limit_would_be_exceeded`). Se for recusado, o desfazer é pelo
Gerenciador — e a recusa em si é um resultado de teste válido.

Pausar e reativar uma campanha em minutos não reinicia a fase de aprendizado;
confirme com o gestor se a campanha escolhida tiver alguma particularidade.

## Se o resultado for desconhecido

Acontece quando a Meta não responde a tempo (timeout de 20 s) ou devolve erro
5xx: a pausa **pode ter sido aplicada ou não**. O sistema congela a conta
(trava acionada) e não oferece nova tentativa.

1. **Desligue a flag** (passo 9). Nada mais deve sair.
2. O gestor olha o Gerenciador: a campanha está pausada ou ativa?
3. Deixe o sistema ler a mesma coisa. O uuid da alteração é o que o `request`
   imprimiu no passo 3 (se perdeu, `release-kill-switch` recusa e lista os
   uuids pendentes):
   ```
   node dist/modules/ads/ops-cli.js resolve-unknown --change <uuid da alteração>
   ```
   **Espere:** `plataforma mostra: status PAUSED…` e `resolvido como: APLICADA`
   — ou `NÃO APLICADA (reserva devolvida)`. Tem de bater com o que o gestor vê.
   É somente leitura na Meta.
4. Só então libere a trava:
   ```
   node dist/modules/ads/ops-cli.js release-kill-switch \
     --account act_694058302567457 --reason "Pausa confirmada no Gerenciador"
   ```
   O comando **recusa** liberar enquanto existir alteração com resultado
   desconhecido — a ordem 3 → 4 é obrigatória.

Uma alteração resolvida como não aplicada **nunca é re-executada**: faz-se um
pedido novo, com aprovação nova.

## O que a trava faz — e o que não faz

A trava (kill switch) **congela o Wings System**: nenhum pedido novo é aceito e
nenhuma execução sai para aquela conta. **Ela não pausa nada na Meta.**
Campanhas que já estão rodando continuam rodando e gastando. O muro externo de
gasto é o `spend_cap` da própria conta na Meta (hoje R$ 2.500). Detalhes em
[travas.md](travas.md).

## Depois da sessão

Registre aqui, no fim deste arquivo: data, campanha, o que apareceu em cada
passo, e qualquer desvio do roteiro. Se houve segunda escrita (reativação ou
orçamento), idem.
