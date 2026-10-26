# Plano: levar a `develop` até a `main` (outubro de 2026)

Plano escrito em 26/10/2026, só de leitura: nenhum código, migração, banco, servidor ou anúncio foi tocado. Os números vêm do repositório no GitHub (`develop` em `4fd3d9f`, `main` em `905c34b`) e das descrições dos PRs. O que **não** deu para conferir daqui está na seção 5.

Nenhum dado de lead ou de pessoa aparece neste documento; leads, quando citados, só por id.

## 0. Em poucas palavras (para o Eric)

- **A `main` não está parada em 19/09.** O último commit dela é de **09/10/2026** e ela é um ponto antigo da própria `develop`: não há o que "juntar", só avançar. A `develop` está **160 commits** à frente (98 sem contar os commits de junção), com 538 arquivos e **12 migrações novas** (0084 a 0095).
- **Os 706 commits e o 19/09 vêm de outra forma de contar**: são os commits da `develop` desde 19/09 (717 hoje). Destes, 557 já estão na `main`. Se a **produção de verdade** ainda roda a versão de 19/09, a distância dela é bem maior (cerca de 702 commits e 75 migrações) e o Git não mostra isso. Preciso que você ou quem opera o servidor confirme o que roda hoje (decisão 1 da seção 4).
- **16 PRs abertos.** Cinco trazem migração e a numeração colide: **0096** aparece duas vezes (#9 e #22) e **0097** duas vezes (#25 e #26). A **0098** (#27) aparece uma vez só hoje; não achei segunda 0098 em nenhuma branch.
- **Risco silencioso nas migrações:** o banco só roda uma migração se a data dela for maior que a da última já aplicada. Se a ordem de entrada for diferente da ordem das datas, a migração fica sem rodar, sem erro, e o teste não acusa. Por isso cada PR renumera **gerando a migração de novo na hora de entrar**.
- **O robô de testes (CI) está vermelho** na `develop` e na `main`. Na `develop` ele para no `lint` e **pula** migração, seed e testes. O primeiro passo é o PR #23 (uma linha).
- **Promoção em 9 etapas** (cortes da `develop`), cada uma com CI completo, ensaio das migrações numa cópia do banco, roteiro de teste e um jeito de voltar atrás. Nada vai para a produção sem o seu **PRODUCAO**.
- O que **só você** decide está na seção 4 (14 itens). Os que travam tudo: o que roda hoje na produção, backup da produção, e se as mudanças que o usuário nota (menus, trava do WhatsApp do vendedor, e-mails) podem ir.

## 1. Ponto de partida (conferido)

| Item                      | Valor                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `main`                    | `905c34b`, 09/10/2026, migrações até 0083                                                                                        |
| `develop`                 | `4fd3d9f`, 26/10/2026, migrações até 0095                                                                                        |
| Relação                   | `main` é ancestral da `develop`: ela está 0 atrás e 160 à frente (98 sem os commits de junção)                                   |
| Tamanho da diferença      | 538 arquivos: web 204, api 183, landing 47, shared 33, docs 29, worker 14, resto (docker, instantâneos das migrações, config) 28 |
| Migrações só na `develop` | 0084 a 0095 (12 arquivos, 12 instantâneos)                                                                                       |
| Commits desde 19/09       | `develop` 717 (702 depois do último commit da `main` naquele dia), `main` 557                                                    |
| Branches remotas          | 114: 94 já estão dentro da `develop`, 16 são cabeças de PR aberto, 4 não estão em lugar nenhum (2.2)                             |
| CI da `develop`           | as 6 últimas execuções terminaram em falha; a última falha em `pnpm lint` e pula todo o resto                                    |
| CI da `main`              | as 2 últimas execuções terminaram em falha (não abri o log; `scripts/gtm` está na `main` desde 30/09)                            |
| Teste que já falha        | `landing-cors.test.ts` falha na `develop` limpa (dito nos PRs #22 e #26); #24, #25 e #27 têm a mesma correção de 3 linhas        |
| Estado real da produção   | **não conferido**: `docs/deploy.md` (container manual `wings-crm-web`) e `AGENTS.md` (Coolify na `main`) se contradizem          |

Por que o CI nunca chegou aos testes: `scripts/gtm/*.mjs` (entrou em 30/09) quebra o `pnpm lint`; o PR #23 manda o ESLint ignorar essa pasta. Enquanto ele não entrar, `format:check`, `db:migrate`, `db:seed` (duas vezes) e `pnpm test` não rodam em lugar nenhum.

## 2. Parte 1: PRs abertos, migrações e ordem de entrada

### 2.1 Os 16 PRs abertos

"Pronto" = não é rascunho. "Arquivos" = arquivos que o PR muda em relação à base dele.

| PR  | Branch → base                                    | Estado                  | Arquivos | Migração                  | O que faz                                                                     |
| --- | ------------------------------------------------ | ----------------------- | -------- | ------------------------- | ----------------------------------------------------------------------------- |
| #9  | `feat/caixa-midia` → `develop`                   | rascunho                | 18       | `0096_wa_message_files`   | arquivos do WhatsApp guardados no R2 e mostrados no balão                     |
| #10 | `feat/caixa-desktop` → `feat/caixa-midia`        | rascunho, empilhado #9  | 28       | nenhuma                   | caixa do WhatsApp como o Desktop (busca, não lidas)                           |
| #12 | `feat/caixa-anexos` → `feat/caixa-desktop`       | rascunho, empilhado #10 | 17       | nenhuma                   | enviar arquivo da negociação e emojis                                         |
| #11 | `fix/painel-campanhas-soma-anuncios` → `develop` | rascunho                | 2        | nenhuma                   | aba Campanhas soma os anúncios quando campanha ou conjunto vem com gasto 0    |
| #13 | `feat/lead-repetido-aviso` → `develop`           | rascunho                | 14       | nenhuma                   | lead repetido avisa o dono, cria tarefa e guarda a resposta                   |
| #16 | `test/e2e-celular-sem-email` → `develop`         | rascunho                | 3        | nenhuma                   | teste do formulário curto em celulares emulados                               |
| #19 | `fix/site-event-utm-texto` → `develop`           | pronto                  | 9        | nenhuma                   | UTMs da página "fale" como texto no log de eventos                            |
| #20 | `fix/whatsapp-texto-site` → `develop`            | pronto                  | 8        | nenhuma                   | WhatsApp da página "fale" com frase natural                                   |
| #22 | `feat/crm-prospeccao` → `develop`                | pronto                  | 51       | `0096_prospecting`        | CRM Vendas → Prospecção (Google Maps ao vivo)                                 |
| #23 | `fix/lint-scripts-gtm` → `develop`               | pronto                  | 1        | nenhuma                   | ESLint ignora `scripts/gtm` (o `pnpm lint` volta a passar)                    |
| #24 | `fix/triagem-outro-dono` → `develop`             | pronto                  | 11       | nenhuma                   | "Ainda não sei" fica no funil; lead entregue pela triagem sempre sai com dono |
| #25 | `feat/produtividade` → `develop`                 | pronto                  | 21       | `0097_produtividade_dw`   | aba Produtividade no Painel de Vendas (modelo dimensional)                    |
| #26 | `fix/whatsapp-crm-staging` → `develop`           | pronto                  | 37       | `0097_wa_template_fields` | modelos de WhatsApp, "Prefiro uma ligação", "Ligar pelo celular"              |
| #27 | `feat/cameras` → `develop`                       | pronto                  | 26       | `0098_cameras_dw`         | base do módulo Câmeras (dispositivos, lotes de 15 min, painel)                |
| #28 | `fix/auth-invite-sector-scope` → `develop`       | pronto                  | 2        | nenhuma                   | **correção de segurança**: `POST /auth/invite` confere o setor do alvo        |
| #29 | `chore/economia-contexto` → `develop`            | pronto                  | 12       | nenhuma                   | encurta `AGENTS.md`/`CLAUDE.md`, modelo por agente (muda as regras das IAs)   |

Nota sobre o #28: a rota existe também na `main` (produção), então a falha de segurança existe lá. Um gerente de setor consegue disparar (e queimar o link pendente de) um convite para funcionário de outro setor, inclusive da Diretoria. O link vai por e-mail para o funcionário, não volta na resposta. Decisão 9.

Nota sobre o CI dos PRs: o único check do #26 terminou em falha; pelas descrições dos PRs #22 e #26 a causa é o `lint` de `scripts/gtm` e o teste `landing-cors`, os mesmos da `develop` (não abri cada log).

### 2.2 Branches sem PR e ainda fora da `develop`

| Branch                      | Commits à frente | Último commit | Sugestão                     |
| --------------------------- | ---------------- | ------------- | ---------------------------- |
| `chore/limpeza-leads`       | 4                | 06/10         | Eric decide: descartar ou PR |
| `docs/catalogo-ferramentas` | 1                | 28/09         | Eric decide: descartar ou PR |
| `docs/crm-fase1`            | 10               | 01/10         | Eric decide: descartar ou PR |
| `feat/smart-captions`       | 6                | 24/09         | Eric decide: descartar ou PR |

Essas quatro **não entram** neste plano. As outras 94 branches remotas já estão dentro da `develop`.

### 2.3 Dependências entre os PRs

| Entre                   | Tipo              | O que acontece                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #25 → #27               | **forte (SQL)**   | As duas criam `dw.data_sk`. O #25 usa `CREATE FUNCTION` simples, o #27 usa `CREATE OR REPLACE` (corpo idêntico). Se o #27 rodar primeiro, a migração do #25 falha com "função já existe". O texto do #27 diz que vale em qualquer ordem; pelo SQL só vale com o #25 antes. |
| #9 → #10 → #12          | pilha de branches | #10 tem como base a branch do #9, e o #12 a do #10. Entram nessa ordem, cada um reapontado para a `develop` depois que o anterior entra.                                                                                                                                   |
| #25 × #27               | textual           | Mexem em `docs/bi/README.md`, `docs/bi/ddl.sql` e `bi-dw.test.ts`. O teste conta tabelas: 19 no #25 e 23 no #27; com os dois juntos são **25** (quem entra por último ajusta).                                                                                             |
| #22, #25, #26, #27      | textual           | Mexem nos mesmos arquivos de permissão e menu: `packages/shared/src/rbac/permissions.ts`, `packages/shared/src/index.ts`, `navigation.ts`, `docs/niveis-de-acesso.md`, `app.ts`, `router.tsx`.                                                                             |
| #9/#10/#12 × #22, #26   | textual           | Os três lados mexem em `modules/whatsapp/routes.ts` e `thread.ts`; #22 e #26 também em `CallPanel.tsx` e `DealWhatsAppPage.test.tsx`.                                                                                                                                      |
| #13, #16, #19, #20, #24 | textual (docs)    | Todos mexem em `docs/landing/fale-com-a-wings.md`; #20 e #24 também em `site-forms.ts`.                                                                                                                                                                                    |
| #24, #25, #27           | igual nos três    | Cada um traz a **mesma** correção de 3 linhas em `landing-cors.test.ts` (mesmo patch). O primeiro que entrar a leva; os outros ficam sem conflito.                                                                                                                         |
| #23 → todos             | CI                | Sem ele o CI para no `lint` e nenhum outro PR consegue provar migração e testes.                                                                                                                                                                                           |
| #26 → todos             | proteção          | Traz o teste `apps/api/src/db/journal.test.ts`, que falha se as datas (`when`) do journal não forem crescentes. Entrando cedo, protege as migrações seguintes.                                                                                                             |

**Simulação feita (descartável, nada enviado):** juntei os PRs em sequência numa cópia local da `develop`, na ordem da seção 2.7.

- Os 9 PRs sem migração entraram **sem conflito**.
- Depois do #26, o #22 conflita em `_journal.json`, `CallPanel.tsx` e `docs/niveis-de-acesso.md`.
- O #25 conflita em `_journal.json`, `0097_snapshot.json` e `docs/niveis-de-acesso.md`.
- O #27 conflita em `_journal.json`, `bi-dw.test.ts`, `docs/bi/README.md`, `docs/bi/ddl.sql`, `docs/niveis-de-acesso.md`, `shared/src/index.ts` e `permissions.ts`.
- A pilha #9/#10/#12 conflita em `_journal.json`, `0096_snapshot.json`, `whatsapp/routes.ts`, `whatsapp/thread.ts`, `web/src/api/whatsapp.ts` e `docs/whatsapp/cloud-api.md`.

Depois de cada conflito eu forcei o lado do PR para seguir adiante, então as listas dos últimos PRs são o **mínimo** esperado. Foi só Git (conflito de texto); não compilei nem rodei teste.

### 2.4 Migrações com número repetido

Todas as cinco nasceram da 0095 (o `prevId` do instantâneo de cada uma é o da 0095). Só uma pode ser "a próxima".

| Número | Arquivo                       | PR                       | Data `when` (UTC) |
| ------ | ----------------------------- | ------------------------ | ----------------- |
| 0096   | `0096_wa_message_files.sql`   | #9 (e #10, #12 por cima) | 20/10 19:32       |
| 0096   | `0096_prospecting.sql`        | #22                      | 26/10 13:41       |
| 0097   | `0097_wa_template_fields.sql` | #26                      | 26/10 15:31       |
| 0097   | `0097_produtividade_dw.sql`   | #25                      | 26/10 15:35       |
| 0098   | `0098_cameras_dw.sql`         | #27                      | 26/10 16:45       |

Para comparar: a 0095 na `develop` tem `when` de 20/10 18:43. Mais três pontos:

- A pilha #9/#10/#12 saiu da `develop` de **20/10**: o `_journal.json` dela não tem as entradas 0094 e 0095 (o PR #9 já avisava que só o journal conflitaria).
- O `_journal.json` e o instantâneo conflitam em **todos** os cinco, por construção.
- O pedido citava a 0098 como repetida. Hoje não é. Ela só vira problema se alguém criar outra migração antes do #27 entrar; a renumeração abaixo evita isso.

**Por que a data importa.** O Drizzle compara só a data (`when`) da última migração aplicada com a de cada arquivo novo e **ignora em silêncio** as mais antigas (é o que o comentário do teste `journal.test.ts`, no #26, descreve). Exemplo: se o #26 (`when` de 26/10 15:31) chegar ao banco antes do #9 (`when` de 20/10 19:32), a migração do #9 nunca roda no staging nem na produção, e o CI, que usa banco novo, fica verde. Confirme num banco descartável antes de confiar.

### 2.5 Renumeração proposta e ordem

| Ordem | PR             | Hoje                      | Passa a ser               | Por que nessa posição                                                                                                                                      |
| ----- | -------------- | ------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | #26            | `0097_wa_template_fields` | `0096_wa_template_fields` | menor e mais segura (2 colunas opcionais); destrava o WhatsApp do CRM no staging (pedido do dia 26/10); traz o teste do journal                            |
| 2     | #22            | `0096_prospecting`        | `0097_prospecting`        | tabelas novas e 1 coluna opcional em `leads`; não mexe no DW; precisa de uma chave do Google (Eric)                                                        |
| 3     | #25            | `0097_produtividade_dw`   | `0098_produtividade_dw`   | mexe no DW (coluna `nome` de `dim_usuario` passa a aceitar vazio, `fato_negociacao` ganha colunas, 2 fatos e 2 funções novos); tem de vir **antes** do #27 |
| 4     | #27            | `0098_cameras_dw`         | `0099_cameras_dw`         | depende da função do #25 (2.3); o menos urgente dos quatro                                                                                                 |
| 5     | #9 + #10 + #12 | `0096_wa_message_files`   | `0100_wa_message_files`   | rascunhos, base de 20/10, journal desatualizado e os maiores conflitos de WhatsApp; entram por último, depois de resolvidos contra #26 e #22               |

Os nomes finais são provisórios: o número vale o da vez em que o PR realmente entrar. Se a ordem real mudar, a regra é a mesma, **o número segue a ordem de entrada**.

### 2.6 Como renumerar (quem entra depois renumera, antes do merge)

Segue a regra do `AGENTS.md` (migração aplicada nunca se edita; quem entra em segundo renumera).

1. Atualizar a branch com a `develop` (merge, não rebase).
2. Apagar na branch o SQL da própria migração, o `meta/NNNN_snapshot.json` dela e a entrada dela no `meta/_journal.json` (voltar o journal ao da `develop`).
3. Gerar de novo com o número seguinte: `db:generate` quando o SQL vem do schema; `drizzle-kit generate --custom` para SQL escrito à mão (#25, #27 e a parte de visão e `GRANT` do #9), colando o mesmo SQL. Confirmar com `diff` que o SQL ficou **idêntico** ao original.
4. Conferir: o `db:generate` seguinte diz que não há mudança; `db:migrate` e `db:seed` (duas vezes) num banco novo; `journal.test.ts` verde.
5. Corrigir o título do PR e qualquer texto que cite o número antigo.

**Se alguma dessas migrações já tiver sido aplicada no staging** (hoje não sei; os PRs dizem "sem deploy"): não regenerar. Só renomear arquivo e etiqueta, **mantendo o SQL e o `when`**, e entrar na ordem das datas. Quem tem acesso ao staging confere a última data aplicada na tabela de migrações do Drizzle (decisão 6).

### 2.7 Ordem de entrada dos PRs na `develop`

Um PR por vez, esperando o CI e o deploy de staging do anterior ("um deploy por vez").

| Lote | PRs                       | Observação                                                                                                                      |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 0    | #23                       | libera o CI até o fim. Primeiro de todos.                                                                                       |
| 1    | #28, #19, #20, #24        | sem migração. #28 é segurança. #24 leva a correção do `landing-cors.test.ts`. Conflitos de texto só em `docs/landing`.          |
| 1b   | #11, #13, #16 (rascunhos) | só se o Eric aprovar. O #13 muda o comportamento do CRM (avisa o dono, cria tarefa); o #16 só teste.                            |
| 2    | #26 → #22 → #25 → #27     | com migração, um por vez, renumerando como na 2.6. #25 antes de #27 é obrigatório.                                              |
| 3    | #9 → #10 → #12            | pilha de rascunhos; atualizar contra a `develop` e resolver o WhatsApp antes de tirar o rascunho.                               |
| fora | #29                       | muda as regras que as IAs seguem (`AGENTS.md`, `CLAUDE.md`). Só entra se o Eric ler e aprovar. Não está no caminho da produção. |

## 3. Parte 2: da `develop` até a `main`

### 3.1 Regras do plano

- **A produção só com o seu PRODUCAO.** Nenhum merge na `main` nem deploy de produção sai daqui: quem faz é o Eric (PRODUCAO digitado no `wings-deploy production` ou o hook liberado por ele), uma etapa por vez.
- **Cortes, não pedaços soltos.** Cada etapa leva a `develop` até um commit da linha principal dela (a ordem em que as ramificações entraram). Entre dois cortes o sistema está num estado que já existiu e foi testado.
- **Cada etapa é um PR `release/etapa-N` → `main`.** O CI roda no resultado da junção. Os PRs da seção 2 ainda não estão em nenhum corte: entram depois, como etapas 10 em diante (3.5).
- **Migração só para frente.** O banco não volta; se algo der errado, corrige-se para frente (3.7).
- **Nada de anúncio, verba, WhatsApp ou ligação para lead** em nenhuma etapa, nem em teste. Anúncio criado ou ligado continua exigindo a ordem do Eric no momento (`AGENTS.md`, seção 3).

### 3.2 Etapa 0: preparar o terreno (sem mexer na produção)

| #   | O que                                                                                                                                                                       | Quem                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 0.1 | Descobrir o que a produção roda **hoje**: commit ou data do build, e a última migração aplicada no banco dela. Define o cenário A (produção na `main`) ou B (3.3).          | Eric / quem opera      |
| 0.2 | Confirmar que o banco de produção tem **backup diário e um teste de restauração**. `docs/deploy.md` só documenta o backup do **staging**.                                   | Eric / quem opera      |
| 0.3 | Levar a linha do #23 (`eslint.config.js`) para a `main` por um PR próprio (`release/ci-lint`), para o CI de cada etapa rodar até o fim. Não faz deploy.                     | Eric (merge em `main`) |
| 0.4 | Entrar #23 na `develop` (lote 0). Depois rodar o CI completo na `develop` e ler o resultado: os testes **nunca rodaram** nos últimos commits, pode haver falhas escondidas. | sessão de IA           |
| 0.5 | Ensaio: restaurar o backup mais recente da produção num banco descartável e rodar `db:migrate` e `db:seed` duas vezes até a 0095. Anotar tempo e erros.                     | quem tem acesso        |
| 0.6 | Fechar a lista de variáveis de ambiente por etapa (3.4, só nomes) e criá-las no Coolify **desligadas**.                                                                     | Eric                   |

### 3.3 Cenário B: se a produção ainda roda a versão de 19/09

Nesse caso a distância de verdade não é de 160 commits. A `main` tem 542 commits e **63 migrações** (0019 a 0083) que a produção nunca viu, além das 12 da `develop`. Seria preciso alinhar a produção à `main` **antes** da etapa 1, também em cortes, com ensaio num banco copiado. Não detalhei esses cortes porque o pedido era `develop` → `main`; peça se for o caso. A etapa 0.1 decide.

### 3.4 Etapas 1 a 9 (cenário A)

| Etapa | Corte (data)      | Commits | Migrações        | Risco      |
| ----- | ----------------- | ------- | ---------------- | ---------- |
| 1     | `9dc8aa2` (09/10) | 16      | 0084, 0085       | médio      |
| 2     | `08a7a90` (13/10) | 27      | 0086, 0087, 0088 | médio-alto |
| 3     | `1f7c2d1` (13/10) | 11      | 0089             | **alto**   |
| 4     | `226d309` (14/10) | 27      | 0090, 0091       | médio-alto |
| 5     | `75ba07e` (15/10) | 9       | 0092             | médio      |
| 6     | `1c55467` (19/10) | 8       | nenhuma          | baixo      |
| 7     | `cccf5f4` (20/10) | 26      | 0093             | médio-alto |
| 8     | `d271e08` (21/10) | 18      | 0094             | **alto**   |
| 9     | `4fd3d9f` (26/10) | 18      | 0095             | médio      |

Soma: 160 commits e 12 migrações. As etapas vizinhas podem ser fundidas se o Eric preferir menos deploys; cada corte continua sendo um lugar seguro para parar.

O que as pessoas vão notar, variáveis novas (só nomes; todas desligadas ou vazias até o Eric ligar) e o que olhar em cada etapa:

**Etapa 1** (0084 aceita negociação do RD vazia e liga o lead do Wings; 0085 e-mail de aviso)

- Notam: "Leads das Campanhas" lê também os leads do Wings; lead novo da Meta que bate com lead fechado abre negociação nova pelo rodízio; contadores "novas sem contato" e "atrasadas" valem só para negociação entrada desde 09/10; menu do celular vira gaveta; nome com artigo nos modelos de WhatsApp.
- Variáveis: `CRM_TRACKING_START`, `CRM_NOTICE_EMAIL_ENABLED` (aviso por e-mail ao dono, desligado se vazio).
- Olhar: a 0084 é a única que afrouxa uma regra do banco (`rd_deal_id` passa a aceitar vazio, com uma checagem de que há pelo menos um dos dois vínculos).

**Etapa 2** (0086 visões de leitura para `wings_ro`; 0087 lead suspeito; 0088 marcação dos leads que já existem)

- Notam: sessão vencida leva ao login e volta à tela; só quem pode mudar o nível de uma pessoa troca o e-mail de login dela; inativar e reativar exigem permissão própria; aviso de ligação chega em tempo real; primeiro contato atrasado em dois passos; lead suspeito de robô aparece marcado com os motivos; os cabeçalhos de segurança do nginx do web mudam (as telas só abrem dentro do próprio sistema, não num quadro de outro site), o que vale para todo mundo.
- Olhar: a **0088 grava dados**: marca os leads que já existem e cria um evento para cada marca, e ajusta uma regra de origem. O cabeçalho dela diz que nada é fechado, perdido ou apagado. O tempo numa base real é desconhecido: ensaiar na cópia (0.5).

**Etapa 3** (0089 origem do tráfego do lead): **a mais sensível para os usuários**

- Notam: níveis de acesso por uma única matriz (menu, telas e API); contenção do cadastro de vendedores; vendedor perde acesso ao cadastro de funcionários; pop-up de lead novo para o dono em qualquer página; card "Origem" na ficha.
- Olhar: o `db:seed` desta etapa **retira permissões** que saíram da matriz. Comparar a matriz de cada nível antes e depois (só nomes de permissão) e mostrar a um gerente de cada setor.

**Etapa 4** (0090 número oficial do WhatsApp; 0091 fila de triagem)

- Notam: menu do vendedor só com Início e CRM Vendas; Negociações abre no funil do próprio vendedor; módulo Agenda (Google Agenda de cada pessoa); pesquisa automática da empresa do lead.
- Variáveis: `LEAD_TRIAGE_ENABLED` e `JEV_API_KEY` (triagem pelo Jev, desligada por padrão; ele só vê o texto mascarado), `LEAD_RESEARCH_SINCE`.

**Etapa 5** (0092 checagem do Instagram)

- Notam: "Fale com a Wings" vira um app estático próprio (**novo container nginx**, `docker/landing.Dockerfile`); checagem do Instagram dos leads do formulário (gasta dinheiro, tem teto diário em dólar).
- Variáveis: `LANDING_ORIGINS`, `LANDING_PAGE_BASE_URL`, `INSTAGRAM_CHECK_ENABLED`, `INSTAGRAM_CHECK_DAILY_USD`, `INSTAGRAM_CHECK_AI_USD_PER_CALL`; `check_instagram` na lista `WORKER_JOB_TYPES`.
- Olhar: criar o app da landing no Coolify, o domínio e o Turnstile **antes** (Eric).

**Etapa 6** (sem migração)

- Notam: webhook do RD ignora o eco do RD Station CRM; logo e formulário embutido da landing.

**Etapa 7** (0093 importação de conversa)

- Notam: importar a conversa exportada do celular para a negociação; reuniões (Iniciar, Encerrar, histórico, lembrete) e Agenda do vendedor em Produtividade; **o vendedor não envia mensagem nem liga pelo WhatsApp do sistema até o número oficial entrar no ar** (`seller lock`). Decisão 7.

**Etapa 8** (0094 importação em lote)

- Notam: importação de conversas em lote; botões do card (WhatsApp do vendedor, link do Meet); asa da landing ajustada para o celular.
- Olhar: **Google Ads API sobe de v22 para v26**, sai o critério de idioma das campanhas de Pesquisa, e a leitura de conciliação da Meta espera 45 s. Isso mexe no adaptador de anúncios. Nada aqui cria ou liga anúncio, mas não foi verificado contra as contas reais. Decisão 8.

**Etapa 9** (0095 números dos vendedores)

- Notam: formulário curto da página "fale"; eventos do visitante contados no servidor sem dado pessoal; conectar o número do vendedor por coexistência; "Reunião agora" (Meet na agenda de quem clica); aba Campanhas mostra "Encerrada".
- Variável: `WHATSAPP_ES_CONFIG_ID`.
- Esta etapa precisa também da correção de 3 linhas de `landing-cors.test.ts` (a mesma dos PRs #24, #25, #27), senão o CI fica vermelho.

### 3.5 Etapas 10 em diante: os PRs abertos (depois de entrarem na `develop`)

| Etapa | O que entra                           | Migração | Pré-requisito do Eric                                                                           |
| ----- | ------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| 10    | lote 1 (#28, #19, #20, #24) e #23     | nenhuma  | decisão 9 (#28 pode sair antes, como correção avulsa)                                           |
| 11    | #26 WhatsApp do CRM: modelos, ligação | 0096     | o número oficial do WhatsApp ainda **não** está no ar: parte da tela não funciona com lead real |
| 12    | #22 Prospecção                        | 0097     | `GOOGLE_PLACES_API_KEY` criada no Google e no Coolify                                           |
| 13    | #25 Produtividade                     | 0098     | nenhum; a carga do DW roda 20 s depois de a API subir e a cada 15 min                           |
| 14    | #27 Câmeras (base)                    | 0099     | decisão 11 (privacidade); só o piloto no escritório                                             |
| 15    | #9, #10, #12 caixa do WhatsApp        | 0100     | sair do rascunho; conflitos resolvidos                                                          |

### 3.6 Conferências por etapa

**Antes de cada etapa (todas, marcar no PR):**

- [ ] CI do PR `release/etapa-N` verde de ponta a ponta: build, typecheck, lint, format, migrate, seed duas vezes e testes.
- [ ] `db:generate` diz "nada a gerar" (schema e migrações concordam).
- [ ] As migrações da etapa rodaram na cópia do banco de produção (0.5), com o tempo anotado.
- [ ] Backup novo da produção feito, e o rótulo `producao-antes-etapa-N` colocado no commit atual da `main`.
- [ ] As variáveis da etapa existem no Coolify, desligadas onde a tabela 3.4 diz que são desligadas.
- [ ] O Eric leu "o que as pessoas vão notar" e aprovou.
- [ ] Nenhum outro deploy (staging ou produção) em andamento.

**Depois de cada etapa:**

- [ ] A API responde em `/health`; o worker está de pé; o log da API, sem erro novo nas primeiras horas (e sem dado pessoal nele).
- [ ] Entrar com uma pessoa de cada nível que a etapa afeta; abrir Negociações e uma ficha.
- [ ] Roteiro da etapa (3.4, "Olhar"): etapa 3, a matriz de cada nível; etapa 2, as telas com os novos cabeçalhos; etapa 5, o site da landing; etapa 7, a trava do WhatsApp do vendedor; etapa 8, só **leituras** nas contas de anúncio.
- [ ] A produção já na versão da etapa anterior: nunca pular etapa.

Limite desta conferência: o staging já roda um commit **mais novo** que cada corte, então o roteiro de fumaça cobre só o que o corte contém, e o ensaio das migrações usa a cópia do banco, não o staging.

### 3.7 Como voltar atrás

| O que deu errado                         | Como voltar                                                                                                                                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uma função nova com variável de ligar    | Apagar ou esvaziar a variável (`CRM_NOTICE_EMAIL_ENABLED`, `CRM_ESCALATION_EMAIL_ENABLED`, `LEAD_TRIAGE_ENABLED`, `INSTAGRAM_CHECK_ENABLED`). Não precisa de deploy de código.                                                                |
| Erro no código da etapa                  | Publicar de novo o rótulo `producao-antes-etapa-N` com `wings-deploy production` (PRODUCAO do Eric). Na `main`, desfazer com `git revert` da junção da etapa, **nunca** reescrever o histórico.                                               |
| Erro depois de a migração ter rodado     | Corrigir para frente com uma migração nova. As 0084 a 0095 só acrescentam, com duas exceções (a 0084 afrouxa uma regra; a 0088 grava marcas e eventos), então o código antigo deve continuar rodando sobre o banco novo. **Não testei isso.** |
| Linha gravada que o código antigo não lê | Atenção à etapa 1: depois dela podem existir linhas em `campaign_leads` sem `rd_deal_id`. Voltar o código só é seguro enquanto não houver uma. Verificar antes de voltar.                                                                     |
| Dado estragado                           | Restaurar o backup é **último recurso** e perde o que foi gravado depois dele. Só com decisão do Eric.                                                                                                                                        |

## 4. O que só o Eric decide

1. **O que roda hoje na produção** (commit ou data do build; última migração aplicada) e se ela está no Coolify ou ainda no container manual `wings-crm-web`. Decide cenário A ou B e se `docs/deploy.md` ou `AGENTS.md` é o que vale.
2. **Liberar cada etapa com PRODUCAO**, e quem faz o merge na `main`. Nada disto foi ou será feito por uma IA.
3. **Backup da produção**: existe, é diário, já foi restaurado de teste? Sem isso, não começar a etapa 1.
4. **Quantas etapas e quando**: as 9 como estão, ou fundidas. Sugestão: não colocar as etapas 8 e 9 (anúncios, conciliação) na virada do mês (30/10 a 02/11).
5. **Quais PRs entram** e quais não: rascunhos #9/#10/#12, #11, #13, #16; o #29 (muda as regras das IAs); as 4 branches soltas (2.2).
6. **A renumeração da 2.5** e se alguma dessas migrações **já foi aplicada no staging** (se foi, não se regenera: só se renomeia).
7. **Mudanças que o usuário nota**: menus e permissões novos (etapas 3 e 4), a negociação nova aberta pelo rodízio quando um lead da Meta bate com um lead fechado (etapa 1), e a **trava do WhatsApp do vendedor** até o número oficial entrar no ar (etapa 7).
8. **Anúncios e dinheiro**: subir a produção com a Google Ads API v26 e a nova espera da Meta (etapa 8) sem ter testado nas contas reais. Criar, ligar ou mudar verba de anúncio continua só por ordem sua no momento.
9. **Correção de segurança do #28**: ir junto do lote 1 ou sair antes, como correção avulsa só para a `main`, já que a falha existe na produção.
10. **Ligar custos e envios**: e-mail de aviso ao dono e à gerência (`CRM_ESCALATION_EMAIL_ENABLED` só com o OK do Eric, segundo o `.env.example`), triagem pelo Jev (serviço externo), checagem do Instagram (teto em dólar por dia).
11. **Câmeras (#27)**: o módulo guarda só contagens, sem imagem nem reconhecimento facial, mas decidir se vai à produção antes de o Jurídico ler (LGPD art. 11).
12. **Contas e chaves que só você cria**: chave da Places API (#22), `WHATSAPP_ES_CONFIG_ID`, `JEV_API_KEY`, domínio, DNS e Turnstile da landing, novo app da landing no Coolify, SMTP.
13. **Política de volta**: aceitar "corrigir para frente primeiro, restaurar backup só em último caso" (3.7).
14. **Janela e congelamento**: durante cada etapa, nenhum outro deploy e nenhum merge na `develop`.

## 5. O que não foi conferido

- Servidor, Coolify, banco do staging e da produção, Meta e Google: sem acesso. Não sei qual commit o staging e a produção rodam, nem quais migrações já foram aplicadas lá.
- Não rodei build, typecheck nem testes (sem dependências instaladas nem banco). A simulação de junção foi só Git (conflito de texto). Afirmações de teste dos PRs vêm das descrições deles.
- O comportamento do Drizzle com datas (`when`) vem do comentário do `journal.test.ts` do #26 e do que conheço da biblioteca; vale confirmar num banco descartável.
- Código antigo sobre o banco novo (3.7): não testado.
- Do CI da `main` e dos 6 últimos da `develop`, abri os passos só da última execução da `develop`.

## Apêndice: como refazer os números (somente leitura)

```bash
git fetch origin develop main
git rev-list --count origin/main..origin/develop                 # 160
git rev-list --count --no-merges origin/main..origin/develop     # 98
git rev-list --count --since=2026-09-19 origin/develop           # 717
git diff --name-status origin/main origin/develop -- apps/api/migrations | grep -v meta   # 0084..0095
git log --first-parent --format='%h %cs %s' origin/main..origin/develop                   # os cortes da 3.4
```
