# Plano: levar a `develop` até a `main` (outubro de 2026)

Plano escrito em 26/10/2026, só de leitura: nenhum código, migração, banco, servidor ou anúncio foi tocado. Os números vêm do repositório no GitHub (`develop` em `3bcd39e`, `main` em `905c34b`) e das descrições dos PRs. O que **não** deu para conferir daqui está na seção 5.

Nenhum dado de lead ou de pessoa aparece neste documento; leads, quando citados, só por id.

> **Atualização de 26/10 (noite).**
>
> - O #23 entrou na `develop` (`3bcd39e`). O `format:check` barra o CI (220 arquivos fora do Prettier); o PR #32 resolve movendo-o para o fim, sem bloquear. A passada do Prettier fica para depois dos PRs aprovados (2.8).
> - **Em andamento, aprovado pelo Eric:** o Fable mescla, nesta ordem, **#32 → #24 → #28 → #19 → #20 → #26**, com o #26 já renumerado para **0096**.
> - **PRs novos:** #31 (avaliação da Sofia, migração `0096_sofia_ai_runs_tokens`), #32 (CI), #33 (página "fale" mais rápida no celular, **sem migração**) e #34 (Central WhatsApp fase 1, migração `0098_wa_central`, **empilhado**: contém #9 → #10 → #12 → #26 antigo).
> - **Vão chegar:** o hotfix do #28 **para a `main`** (`hotfix/convite-setor`) e a fase 2 da Central (`feat/central-whatsapp-fase2`, empilhada no #34, migração provisória 0101).
> - **Refeito:** numeração e ordem de **todos** os PRs (2.4 a 2.7), quem renumera o quê e quando (2.6) e o caminho do hotfix de ida e volta (2.9). A pilha do WhatsApp deixou de ser a última (2.7).

## 0. Em poucas palavras (para o Eric)

- **A `main` não está parada em 19/09.** O último commit dela é de **09/10/2026** e ela é um ponto antigo da própria `develop`: não há o que "juntar", só avançar. A `develop` está **162 commits** à frente (99 sem contar os commits de junção; eram 160 antes do #23), com 538 arquivos e **12 migrações novas** (0084 a 0095).
- **Os 706 commits e o 19/09 vêm de outra forma de contar**: são os commits da `develop` desde 19/09 (717 hoje). Destes, 557 já estão na `main`. Se a **produção de verdade** ainda roda a versão de 19/09, a distância dela é bem maior (cerca de 702 commits e 75 migrações) e o Git não mostra isso. Preciso que você ou quem opera o servidor confirme o que roda hoje (decisão 1 da seção 4).
- **19 PRs abertos** além deste plano (#30). Sete trazem migração e a numeração colide: **0096** aparece **quatro** vezes (#9, #22, #26 e #31) e **0098** duas (#27 e o novo #34); o #34 ainda carrega uma cópia velha da 0097 do #26. Proposta sem número repetido: 0096 #26, 0097 #9, 0098 #34, 0099 fase 2, 0100 #31, 0101 #22, 0102 #25, 0103 #27.
- **Risco silencioso nas migrações:** o banco só roda uma migração se a data dela for maior que a da última já aplicada. Se a ordem de entrada for diferente da ordem das datas, a migração fica sem rodar, sem erro, e o teste não acusa. Por isso cada PR renumera **gerando a migração de novo na hora de entrar**.
- **O robô de testes (CI) segue vermelho.** O #23 entrou e o `lint` passa, mas agora o CI para no `format:check` (220 arquivos fora do padrão do Prettier) e **continua pulando** migração, seed e testes. O PR **#32** move o `format:check` para o fim, sem bloquear, e o CI passa a rodar tudo. O Fable já está mesclando o #32 e depois o #24; o primeiro vermelho real deve ser o teste `landing-cors`, que o #24 corrige.
- **A pilha do WhatsApp (#9 → #10 → #12 → #34) entra logo depois do #26**, na ordem do autor, antes dos quatro PRs independentes. Muda o plano anterior, que a deixava por último (2.7). O #34 precisa ser refeito depois do #26, porque carrega o #26 antigo com a 0097.
- **Hotfix do #28 para a `main`** (2.9): é o mesmo commit do #28, sem reescrever, e volta para a `develop` sem conflito (testado em Git).
- **Passada do Prettier só depois dos PRs aprovados** (lote 4, seção 2.8), para não gerar conflito neles. Dos 220 arquivos, **82** são JSON gerado pelo Drizzle e **78** são ferramentas de IA copiadas de terceiros; só **60** são nossos. Proposta: o Prettier passa a ignorar os dois primeiros grupos e formata os 60.
- **Promoção em 9 etapas** (cortes da `develop`), cada uma com CI completo, ensaio das migrações numa cópia do banco, roteiro de teste e um jeito de voltar atrás. Nada vai para a produção sem o seu **PRODUCAO**.
- O que **só você** decide está na seção 4 (17 itens). Os que travam tudo: o que roda hoje na produção, backup da produção, e se as mudanças que o usuário nota (menus, trava do WhatsApp do vendedor, e-mails) podem ir.

## 1. Ponto de partida (conferido)

| Item                      | Valor                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`                    | `905c34b`, 09/10/2026, migrações até 0083                                                                                                                                                                              |
| `develop`                 | `3bcd39e`, 26/10/2026 (depois do #23), migrações até 0095. O Fable está mesclando #32 → #24 → #28 → #19 → #20 → #26                                                                                                    |
| Relação                   | `main` é ancestral da `develop`: ela está 0 atrás e 162 à frente (99 sem os commits de junção)                                                                                                                         |
| Tamanho da diferença      | 538 arquivos: web 204, api 183, landing 47, shared 33, docs 29, worker 14, resto (docker, instantâneos das migrações, config) 28                                                                                       |
| Migrações só na `develop` | 0084 a 0095 (12 arquivos, 12 instantâneos)                                                                                                                                                                             |
| Commits desde 19/09       | `develop` 717 (702 depois do último commit da `main` naquele dia), `main` 557                                                                                                                                          |
| Branches remotas          | 119: 95 já estão dentro da `develop`, 20 são cabeças de PR aberto (com este plano), 4 não estão em lugar nenhum (2.2)                                                                                                  |
| CI da `develop`           | em `4fd3d9f`, as 6 últimas execuções terminaram em falha, a última em `pnpm lint`; em `3bcd39e` o lint passa e o CI para no `pnpm format:check` (220 arquivos), pulando migração, seed e teste                         |
| CI da `main`              | as 2 últimas execuções terminaram em falha (não abri o log; `scripts/gtm` está na `main` desde 30/09)                                                                                                                  |
| Arquivos fora do Prettier | **220** (medido em `3bcd39e`): 82 JSON do Drizzle (`apps/api/migrations/meta`), 78 ferramentas de IA (`.agents/`, `.github/agents/`, `.github/skills/`), 60 nossos (21 worker, 30 docs, 5 `scripts/gtm`, 3 web, 1 api) |
| Teste que já falha        | `landing-cors.test.ts` falha na `develop` limpa (dito nos PRs #22 e #26); #24, #25 e #27 têm a mesma correção de 3 linhas                                                                                              |
| Estado real da produção   | **não conferido**: `docs/deploy.md` (container manual `wings-crm-web`) e `AGENTS.md` (Coolify na `main`) se contradizem                                                                                                |

Por que o CI nunca chegou aos testes: `scripts/gtm/*.mjs` (entrou em 30/09) quebrava o `pnpm lint`; o #23, já na `develop`, manda o ESLint ignorar essa pasta. Agora quem barra é o `pnpm format:check`, que vem **antes** de `db:migrate`, `db:seed` (duas vezes) e `pnpm test`. O PR #32 troca essa ordem (e deixa o `format:check` sem bloquear até a passada do Prettier).

## 2. Parte 1: PRs abertos, migrações e ordem de entrada

### 2.1 Os PRs abertos

São 19 além deste plano (#30). "Pronto" = não é rascunho. "Arquivos" = arquivos que o PR muda em relação à `develop` (os empilhados mostram o total acumulado). "Merge em curso" = aprovado pelo Eric; o Fable mescla na ordem **#32 → #24 → #28 → #19 → #20 → #26**.

| PR  | Branch → base                                    | Estado                                  | Arquivos | Migração hoje                                                          | O que faz                                                                                                                                            |
| --- | ------------------------------------------------ | --------------------------------------- | -------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| #9  | `feat/caixa-midia` → `develop`                   | rascunho; 1º da pilha                   | 18       | `0096_wa_message_files`                                                | arquivos do WhatsApp guardados no R2 e mostrados no balão                                                                                            |
| #10 | `feat/caixa-desktop` → `feat/caixa-midia`        | rascunho; sobre o #9                    | 39       | nenhuma (carrega a do #9)                                              | caixa do WhatsApp como o Desktop (busca, não lidas)                                                                                                  |
| #12 | `feat/caixa-anexos` → `feat/caixa-desktop`       | rascunho; sobre o #10                   | 45       | nenhuma (carrega a do #9)                                              | enviar arquivo da negociação e emojis                                                                                                                |
| #11 | `fix/painel-campanhas-soma-anuncios` → `develop` | rascunho                                | 2        | nenhuma                                                                | aba Campanhas soma os anúncios quando campanha ou conjunto vem com gasto 0                                                                           |
| #13 | `feat/lead-repetido-aviso` → `develop`           | rascunho                                | 14       | nenhuma                                                                | lead repetido avisa o dono, cria tarefa e guarda a resposta                                                                                          |
| #16 | `test/e2e-celular-sem-email` → `develop`         | rascunho                                | 3        | nenhuma                                                                | teste do formulário curto em celulares emulados                                                                                                      |
| #19 | `fix/site-event-utm-texto` → `develop`           | merge em curso (4º)                     | 9        | nenhuma                                                                | UTMs da página "fale" como texto no log de eventos                                                                                                   |
| #20 | `fix/whatsapp-texto-site` → `develop`            | merge em curso (5º)                     | 8        | nenhuma                                                                | WhatsApp da página "fale" com frase natural                                                                                                          |
| #22 | `feat/crm-prospeccao` → `develop`                | pronto                                  | 51       | `0096_prospecting`                                                     | CRM Vendas → Prospecção (Google Maps ao vivo)                                                                                                        |
| #24 | `fix/triagem-outro-dono` → `develop`             | merge em curso (2º)                     | 11       | nenhuma                                                                | "Ainda não sei" fica no funil; lead entregue pela triagem sempre sai com dono                                                                        |
| #25 | `feat/produtividade` → `develop`                 | pronto                                  | 21       | `0097_produtividade_dw`                                                | aba Produtividade no Painel de Vendas (modelo dimensional)                                                                                           |
| #26 | `fix/whatsapp-crm-staging` → `develop`           | merge em curso (6º)                     | 37       | `0096_wa_template_fields` (já renumerada)                              | modelos de WhatsApp, "Prefiro uma ligação", "Ligar pelo celular"                                                                                     |
| #27 | `feat/cameras` → `develop`                       | pronto                                  | 26       | `0098_cameras_dw`                                                      | base do módulo Câmeras (dispositivos, lotes de 15 min, painel)                                                                                       |
| #28 | `fix/auth-invite-sector-scope` → `develop`       | merge em curso (3º); também vira hotfix | 2        | nenhuma                                                                | **correção de segurança**: `POST /auth/invite` confere o setor do alvo                                                                               |
| #29 | `chore/economia-contexto` → `develop`            | pronto                                  | 12       | nenhuma                                                                | encurta `AGENTS.md`/`CLAUDE.md`, modelo por agente (muda as regras das IAs)                                                                          |
| #31 | `feat/avaliacao-sofia` → `develop`               | pronto                                  | 16       | `0096_sofia_ai_runs_tokens`                                            | avaliação da Sofia: 87 conversas de teste, relatório por categoria, registro de cada chamada da IA (muda `brain.ts` e `engine.ts`)                   |
| #32 | `ci/testes-mesmo-com-format` → `develop`         | merge em curso (1º)                     | 1        | nenhuma                                                                | CI roda migração, seed e testes mesmo com o `format:check` falhando                                                                                  |
| #33 | `perf/pagina-fale` → `develop`                   | pronto                                  | 11       | **nenhuma** (conferido: só `apps/landing`, doc e lockfile)             | página "Fale com a Wings" mostra o conteúdo mais cedo no celular                                                                                     |
| #34 | `feat/central-whatsapp` → `develop`              | pronto; **empilhado** (32 commits)      | 92       | `0098_wa_central` (carrega também a 0096 do #9 e a 0097 do #26 antigo) | Central WhatsApp, fase 1: vários números (a confirmar), tráfego dos números no CRM, central em três áreas, vínculo com o CRM, conexão oficial pronta |

**Vão chegar** (ainda não existem no repositório):

- `hotfix/convite-setor` → **`main`**: o conserto do #28 para a produção (2.9). Sem migração.
- `feat/central-whatsapp-fase2` → empilhada no #34: migração provisória **0101** (vai mudar, ver 2.5).

Notas:

- **#28:** a rota existe também na `main` (produção), então a falha de segurança existe lá. Um gerente de setor consegue disparar (e queimar o link pendente de) um convite para funcionário de outro setor, inclusive da Diretoria. O link vai por e-mail para o funcionário, não volta na resposta.
- **#34 empilhado:** a branch tem os commits do #9, #10, #12 e do #26 **antigo** (o das 0097), mais 4 commits próprios (`2928eec`, `8e02914`, `177d247`, `48d6106`) e 2 de junção. O commit `e436519` está tanto no #34 quanto no #26 novo.
- **#33:** não tem migração e junta limpo com o #19, #20 e #24 (testado em Git).
- **#26:** os commits `5db94ea` e `54536d5` renumeraram a migração de 0097 para 0096 com o **mesmo SQL**, o mesmo instantâneo e a **mesma data** (`when` de 26/10 15:31 UTC).

### 2.2 Branches sem PR e ainda fora da `develop`

| Branch                      | Commits à frente | Último commit | Sugestão                     |
| --------------------------- | ---------------- | ------------- | ---------------------------- |
| `chore/limpeza-leads`       | 4                | 06/10         | Eric decide: descartar ou PR |
| `docs/catalogo-ferramentas` | 1                | 28/09         | Eric decide: descartar ou PR |
| `docs/crm-fase1`            | 10               | 01/10         | Eric decide: descartar ou PR |
| `feat/smart-captions`       | 6                | 24/09         | Eric decide: descartar ou PR |

Essas quatro **não entram** neste plano. As outras 95 branches remotas já estão dentro da `develop`.

### 2.3 Dependências entre os PRs

| Entre                           | Tipo                 | O que acontece                                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #25 → #27                       | **forte (SQL)**      | As duas criam `dw.data_sk`. O #25 usa `CREATE FUNCTION` simples, o #27 usa `CREATE OR REPLACE` (corpo idêntico). Se o #27 rodar primeiro, a migração do #25 falha com "função já existe". O texto do #27 diz que vale em qualquer ordem; pelo SQL só vale com o #25 antes.    |
| #9 → #10 → #12 → #34 → fase 2   | pilha de branches    | Cada um tem como base a branch do anterior. O #34 contém os commits de #9, #10, #12 e #26; a fase 2 vai conter os do #34. Entram nessa ordem, cada empilhado reapontado para a `develop` quando o anterior entra.                                                             |
| #26 → #34                       | **forte (migração)** | O #26 entra antes e renumerado para 0096. O #34 carrega o #26 **antigo** com a 0097. Se o #34 entrasse assim, as mesmas duas colunas de `wa_templates` seriam criadas duas vezes (0096 e 0097) e a migração falharia. O #34 precisa ser refeito sem os commits antigos (2.6). |
| #9 → #34                        | **forte (cadeia)**   | O instantâneo da `0098_wa_central` descende dos da 0096 do #9 e da 0097 do #26 antigo. Mudar o número ou a data do #9 muda o "pai" do #34.                                                                                                                                    |
| #26 → todos os PRs com migração | proteção             | O #26 traz o teste `apps/api/src/db/journal.test.ts` (falha se as datas `when` do journal não forem crescentes). Entrando cedo, protege os seguintes.                                                                                                                         |
| #25 × #27                       | textual              | Mexem em `docs/bi/README.md`, `docs/bi/ddl.sql` e `bi-dw.test.ts`. O teste conta tabelas: 19 no #25 e 23 no #27; com os dois juntos são **25** (quem entra por último ajusta).                                                                                                |
| #22, #25, #26, #27, #34         | textual              | Mexem nos mesmos arquivos de permissão e menu: `packages/shared/src/rbac/permissions.ts`, `packages/shared/src/index.ts`, `navigation.ts`, `docs/niveis-de-acesso.md`, `app.ts`, `router.tsx`.                                                                                |
| #34 × #22                       | textual              | Conflitam em `whatsapp/routes.ts`, `CallPanel.tsx` e `docs/niveis-de-acesso.md`. O #34 × #25 conflita só em `docs/niveis-de-acesso.md`; × #27, #31 e #33 só nos arquivos de migração.                                                                                         |
| #13, #16, #19, #20, #24, #33    | textual (docs)       | Mexem em `docs/landing/fale-com-a-wings.md` (e #20 e #24 em `site-forms.ts`). O #33 junta limpo com os demais.                                                                                                                                                                |
| #24, #25, #27                   | igual nos três       | Cada um traz a **mesma** correção de 3 linhas em `landing-cors.test.ts` (mesmo patch). O #24 entra primeiro e a leva; nos outros dois vira "nada a fazer".                                                                                                                    |
| #32 → todos                     | CI                   | Sem ele o CI para no `format:check` e nenhum outro PR prova migração e testes. Está em primeiro no merge em curso.                                                                                                                                                            |
| #28 → hotfix                    | mesmo commit         | O hotfix para a `main` copia o commit `31795028` do #28 (2.9).                                                                                                                                                                                                                |

**Testes de junção (só Git, nada enviado).** Contra a `develop` atual (`3bcd39e`), cada PR entra sozinho sem conflito, exceto #9, #10 e #12, que saíram da `develop` de 20/10 e conflitam só no `_journal.json`. O #34 entra sozinho sem conflito porque já está sobre a `develop` atual. Na simulação anterior em sequência (feita em `4fd3d9f`, ordem antiga) apareceram conflitos de texto entre #22, #25, #26 e #27 em `docs/niveis-de-acesso.md`, `CallPanel.tsx`, `bi-dw.test.ts`, `docs/bi/*`, `shared/src/index.ts` e `permissions.ts`; continuam valendo. Não compilei nem rodei teste.

### 2.4 Migrações com número repetido hoje

Todas nasceram da 0095 (o `prevId` do primeiro instantâneo novo de cada uma é o da 0095). Só uma pode ser "a próxima".

| Número | Arquivo                                          | PR                           | Data `when` (UTC) |
| ------ | ------------------------------------------------ | ---------------------------- | ----------------- |
| 0096   | `0096_wa_message_files.sql`                      | #9 (cópia em #10, #12 e #34) | 20/10 19:32       |
| 0096   | `0096_prospecting.sql`                           | #22                          | 26/10 13:41       |
| 0096   | `0096_wa_template_fields.sql` (renumerada)       | #26                          | 26/10 15:31       |
| 0096   | `0096_sofia_ai_runs_tokens.sql`                  | #31                          | 26/10 17:54       |
| 0097   | `0097_produtividade_dw.sql`                      | #25                          | 26/10 15:35       |
| 0097   | `0097_wa_template_fields.sql` (cópia **antiga**) | só dentro do #34             | 26/10 15:31       |
| 0098   | `0098_cameras_dw.sql`                            | #27                          | 26/10 16:45       |
| 0098   | `0098_wa_central.sql`                            | #34                          | 26/10 17:34       |

Para comparar: a 0095 na `develop` tem `when` de 20/10 18:43.

- **0096 aparece quatro vezes e 0098 duas.** A 0097 só uma vez de verdade (a outra é a cópia antiga dentro do #34, que deve desaparecer).
- **Em ordem de data**, os arquivos ficam: #9 (20/10) < #22 < #26 < #25 < #27 < #34 < #31. A ordem de entrada pedida (#26 primeiro, depois o bloco WhatsApp) **não** segue essa ordem, então quase todos precisam gerar a migração de novo (2.6).
- A pilha #9/#10/#12 saiu da `develop` de **20/10**: o `_journal.json` dela não tem as entradas 0094 e 0095.
- O #34 não "só acrescenta": a `0098_wa_central` derruba e recria dois índices únicos de `wa_conversations` (com o mesmo nome), afrouxa 4 colunas de `wa_numbers` e muda um valor padrão. Ensaiar numa cópia do banco antes de entrar.

**Por que a data importa.** O Drizzle compara só a data (`when`) da última migração aplicada com a de cada arquivo novo e **ignora em silêncio** as mais antigas (é o que o comentário do teste `journal.test.ts`, no #26, descreve). Exemplo: se o #26 (`when` de 26/10 15:31) entrar na frente do #9 (`when` de 20/10 19:32) sem o #9 gerar de novo, a migração do #9 nunca roda no staging nem na produção, e o CI, que usa banco novo, fica verde. Confirme num banco descartável antes de confiar.

### 2.5 Numeração e ordem de entrada (todos os PRs)

Regra: **o número segue a ordem de entrada** e a data (`when`) é a do momento em que a migração é gerada, logo cresce sozinha desde que cada PR gere **depois** de o anterior entrar. Nenhum número se repete.

| Ordem | PR                          | Hoje                                      | Número final                  | `when` do journal                                                   |
| ----- | --------------------------- | ----------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| 1     | #26                         | `0096_wa_template_fields`                 | **0096** (não muda)           | **mantém** 26/10 15:31 (maior que a 0095; é o único que mantém)     |
| 2     | #9 (#10 e #12 sem migração) | `0096_wa_message_files`                   | **0097**_wa_message_files     | gerar de novo (hoje 20/10 é menor que 15:31 do #26)                 |
| 3     | #34                         | `0098_wa_central` (+ 0096 e 0097 antigas) | **0098**_wa_central           | gerar de novo (o "pai" passa a ser a 0097 nova); a 0097 antiga some |
| 4     | fase 2 da Central           | provisória `0101`                         | **0099**                      | gerar ao entrar                                                     |
| 5     | #31                         | `0096_sofia_ai_runs_tokens`               | **0100**_sofia_ai_runs_tokens | gerar de novo                                                       |
| 6     | #22                         | `0096_prospecting`                        | **0101**_prospecting          | gerar de novo                                                       |
| 7     | #25                         | `0097_produtividade_dw`                   | **0102**_produtividade_dw     | gerar de novo; antes do #27                                         |
| 8     | #27                         | `0098_cameras_dw`                         | **0103**_cameras_dw           | gerar de novo; depois do #25                                        |

Sem migração (não entram na conta): #32, #24, #28, #19, #20, #33, #10, #12, #11, #13, #16, #29 e o hotfix para a `main`.

- **Se a fase 2 não estiver pronta** quando chegar a vez dela, o #31 pega o 0099 e todos os de baixo descem um; a fase 2 pega o próximo livre ao entrar. Os números da tabela são uma projeção, a regra é a de cima.
- **Se o Eric preferir os quatro independentes antes do bloco WhatsApp** (ver 2.7): #31 vira 0097, #22 0098, #25 0099, #27 0100, #9 0101, #34 0102, fase 2 0103. É válido, mas faz o #34 e a fase 2 refazerem a cadeia mais tarde e com mais arquivos.
- O **#26 não precisa gerar de novo** porque o Fable já o renumerou com a data original (15:31), maior que a da 0095. Todos os demais precisam gerar **depois** de o anterior entrar, senão a data nasce menor.

### 2.6 Quem renumera o quê, e quando

Segue a regra do `AGENTS.md`: migração aplicada nunca se edita; quem entra depois renumera.

| Gatilho                                  | Quem                                      | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Já feito                                 | Fable / autor do #26                      | Renumerou o #26 de 0097 para 0096: mesmo SQL, entrada 96 no journal, data mantida. Nada mais a fazer.                                                                                                                                                                                                                                                                                                                                                                              |
| Depois que o **#26 entrar**              | autor da pilha #9, #10, #12               | No #9: merge da `develop`; apagar o SQL, o instantâneo e a entrada do journal da 0096 antiga; gerar de novo como **0097** (`db:generate` mais a parte escrita à mão, visão e `GRANT`); conferir que o SQL ficou **idêntico**. Depois o #10 e o #12 fazem merge do #9 atualizado, porque os dois carregam uma cópia da 0096 antiga.                                                                                                                                                 |
| Entre os três da pilha                   | Fable                                     | Mescla o #9; reaponta o #10 para a `develop` e mescla; reaponta o #12 e mescla. Antes de cada um: `journal.test.ts` verde e `db:generate` sem mudança.                                                                                                                                                                                                                                                                                                                             |
| Depois que o **#12 entrar**              | autor do #34                              | Refaz o #34 sobre a `develop`: branch nova a partir da `develop` e **cherry-pick só dos 4 commits próprios** (`2928eec`, `8e02914`, `177d247`, `48d6106`); o `e436519` já veio com o #26. Não leva os commits de #9, #10, #12 nem do #26 antigo, e a 0097 antiga some. A `0098_wa_central` é gerada de novo (continua **0098**; novo "pai" e nova data) e o SQL deve ficar idêntico ao original. Não executei esse cherry-pick: o conflito esperado é só nos arquivos de migração. |
| Depois que o **#34 entrar**              | autor da fase 2                           | Refaz a fase 2 sobre a `develop` com os commits próprios dela e gera a migração como **0099** (a 0101 provisória cai).                                                                                                                                                                                                                                                                                                                                                             |
| Depois de cada anterior da lista (5 a 8) | autor de #31, #22, #25 e #27, nessa ordem | Só **depois** de o anterior entrar: merge da `develop`; apagar a própria migração, o instantâneo e a entrada do journal; gerar de novo com o número seguinte (0100, 0101, 0102, 0103); SQL idêntico. O #27 só depois do #25.                                                                                                                                                                                                                                                       |
| Antes de **cada merge**                  | Fable                                     | Confere: `journal.test.ts` verde; `db:generate` diz que não há mudança; nenhum número repetido (`ls apps/api/migrations/*.sql \| sed -E 's#.*/(....)_.*#\1#' \| sort \| uniq -d` não imprime nada); título do PR com o número certo.                                                                                                                                                                                                                                               |

Passos de cada renumeração (para o autor):

1. Atualizar a branch com a `develop` (merge, não rebase).
2. Apagar na branch o SQL da própria migração, o `meta/NNNN_snapshot.json` dela e a entrada dela no `meta/_journal.json` (voltar o journal ao da `develop`).
3. Gerar de novo com o número seguinte: `db:generate` quando o SQL vem do schema; `drizzle-kit generate --custom` para SQL escrito à mão (#25, #27 e a parte de visão e `GRANT` do #9), colando o mesmo SQL. Confirmar com `diff` que o SQL ficou **idêntico** ao original.
4. Conferir: o `db:generate` seguinte diz que não há mudança; `db:migrate` e `db:seed` (duas vezes) num banco novo; `journal.test.ts` verde.
5. Corrigir o título do PR e qualquer texto que cite o número antigo.

**Se alguma dessas migrações já tiver sido aplicada no staging** (hoje não sei; os PRs dizem "sem deploy"): não gerar de novo. Só renomear arquivo e etiqueta, **mantendo o SQL e a `when`**, e entrar na ordem das datas. Quem tem acesso ao staging confere a última data aplicada na tabela de migrações do Drizzle (decisão 6).

### 2.7 Ordem de entrada dos PRs na `develop`

Um PR por vez, esperando o CI e o deploy de staging do anterior ("um deploy por vez").

| Lote   | PRs                               | Observação                                                                                                                                                              |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0      | #32 → #24 → #28 → #19 → #20 → #26 | **em andamento, aprovado pelo Eric** (Fable). #26 já renumerado para 0096. O #23 já entrou. O teste `landing-cors` deve ser o primeiro vermelho; o #24 traz a correção. |
| 1      | #33                               | sem migração, só `apps/landing`; qualquer hora depois do lote 0. Rascunhos #11, #13, #16 só se o Eric aprovar.                                                          |
| 2      | #9 → #10 → #12 → #34 → fase 2     | **bloco WhatsApp, na ordem do autor**, logo depois do #26. Renumeração e refazer do #34 em 2.6. A fase 2 entra assim que existir e estiver pronta.                      |
| 3      | #31 → #22 → #25 → #27             | migrações independentes, um por vez, cada uma gerada de novo depois do anterior. #25 antes do #27 é obrigatório; #31 só com o OK do Eric.                               |
| 4      | passada do Prettier               | **depois do último PR aprovado entrar** (2.8). PR único, só formatação, e no mesmo PR o `format:check` volta a bloquear.                                                |
| fora   | #29                               | muda as regras que as IAs seguem (`AGENTS.md`, `CLAUDE.md`). Só entra se o Eric ler e aprovar. Não está no caminho da produção.                                         |
| `main` | hotfix do #28                     | vai direto para a `main` (2.9), fora desta fila.                                                                                                                        |

**Por que o bloco WhatsApp passou para logo depois do #26 (muda o plano anterior, que o deixava por último).**

- A ordem do autor é #9 → #10 → #12 → #26 → #34. A única diferença é que o #26 saiu na frente por decisão do Eric; o resto da ordem fica como o autor pediu.
- O #34 e a fase 2 são PRs **empilhados** (92 arquivos, cadeia de migração). Se uma migração entrar no meio, os dois têm de refazer a cadeia. Com o bloco logo depois do #26, só os quatro independentes (um arquivo de migração cada) renumeram.
- Entrando mais cedo, o bloco passa mais tempo no staging antes de virar etapa de produção.
- O custo: o #34 tem a migração mais delicada da fila (2.4) e precisa de ensaio numa cópia do banco. Decisão 17 do Eric.
- Atalho possível: entrar só o #34 refeito e fechar #9, #10 e #12 como substituídos. Perde a revisão em passos menores.

### 2.8 A passada geral do Prettier (lote 4)

**Quando.** Depois do último PR aprovado entrar na `develop`, isto é, depois do lote 3 da 2.7 (#31 → #22 → #25 → #27), e antes de qualquer trabalho novo. Se o #29 ou algum rascunho entrar, entra antes dela. Na promoção para a `main` é a **etapa 19** (3.5), só formatação.

**Por que depois, e não agora.**

- Dos 220 arquivos, **82** são `apps/api/migrations/meta/*.json` (instantâneos e journal que o `drizzle-kit` gera). **Todo PR com migração** mexe no `_journal.json`: formatá-lo hoje geraria conflito em todos eles.
- Hoje, entre os PRs que ainda não entraram, 4 mexem em arquivos da lista dos 60 nossos: o #13 (`docs/leads/intake.md`), o #20 (`docs/crm/fase1-operacao.md`) e o #25 e o #27 (`docs/bi/README.md`).
- Os PRs que ainda vão entrar trazem arquivos novos, então a lista muda. A conta final se faz no dia, com `prettier --list-different .`.

**O que o PR da passada contém (um só, só formatação).**

1. `.prettierignore` ganha `apps/api/migrations/meta/` (cada migração nova recria esses arquivos fora do padrão, então formatá-los não adianta) e as pastas de ferramentas de IA copiadas de terceiros: `.agents/`, `.codex/`, `.github/agents/`, `.github/hooks/`, `.github/skills/`. O `AGENTS.md` já diz que não são código do produto e o ESLint já as ignora; `.claude/` já está no `.prettierignore`. Decisão 15.
2. `pnpm format` nos arquivos que sobrarem (hoje 60: 21 do worker, 30 de docs, 5 de `scripts/gtm`, 3 do web, 1 da api).
3. O `continue-on-error: true` do `format:check` no `ci.yml` sai, e o passo volta a bloquear.

**Conferências.** CI inteiro verde (build, tipos, lint, format, migrate, seed duas vezes e testes); nenhum `.sql` e nenhum arquivo de `meta/` mudou; os testes do worker passam (os 21 arquivos do worker são código de renderização e ffmpeg); staging com o worker de pé antes de promover.

**Depois dela.** Os PRs que ficaram abertos (rascunhos, #29, as 4 branches soltas) fazem merge da `develop` e rodam `prettier --write` nos próprios arquivos. **Risco:** baixo, sem mudança de comportamento, mas toca cerca de 60 arquivos, entre eles código do worker; por isso vai como etapa própria.

### 2.9 Hotfix do #28 para a `main` e a volta para a `develop`

A falha de segurança do #28 existe na produção; o conserto vai para a `main` sozinho (branch `hotfix/convite-setor`), sem esperar as etapas. O mesmo conserto também entra na `develop` pelo #28 (Fable, 3º da fila).

**Como fazer**

1. **Antes:** o PR `release/ci` (0.3) precisa estar na `main`. Sem ele o CI do hotfix para no lint e no `format:check` e não prova nada.
2. Criar `hotfix/convite-setor` **a partir da `main`** e trazer o commit do #28 com `git cherry-pick -x 31795028`. Não escrever o conserto de novo. São 2 arquivos e 67 linhas: `auth/routes.ts` e `credentials.test.ts`.
3. Abrir o PR para a `main` com CI inteiro verde. O merge na `main` e o deploy são do Eric (PRODUCAO), **fora das etapas** e sem outro deploy ao mesmo tempo.
4. Depois do deploy, o rótulo `producao-antes-etapa-1` já nasce com o hotfix.

**Por que volta para a `develop` sem conflito** (testado só em Git, em cópias descartáveis):

- O commit copiado para a `main` tem o **mesmo patch** do #28 (identificador de patch igual, `cc983095976a`): para o Git é a mesma mudança dos dois lados. O cherry-pick aplicou limpo sobre a `main`.
- `develop` com o #28 já dentro + junção da `main` com o hotfix: **sem conflito** (o Git reconhece a mesma mudança nos dois lados).
- O sentido contrário também: a `main` com o hotfix recebendo os cortes das etapas 1 (`9dc8aa2`) e 9 (`4fd3d9f`): **sem conflito**, e o conserto continua lá.
- Depois do hotfix a `main` deixa de ser ancestral da `develop` (tem um commit com outro identificador). Isso não atrapalha: as etapas já são PRs de junção `release/etapa-N` → `main`, não avanço direto.

**Para manter assim**

- (a) Copiar sempre com `cherry-pick -x`; nunca refazer à mão.
- (b) Se o #28 ganhar mais um commit antes de entrar, copiar o mesmo commit novo para o hotfix.
- (c) Não mexer perto do trecho do conserto em `auth/routes.ts`, na `main` ou na `develop`, até os dois entrarem.
- (d) Não é preciso mesclar a `main` na `develop` por causa disso: a próxima etapa já faz a junção. Se alguém quiser sincronizar antes, `git merge origin/main` na `develop` é limpo.

**Limites:** não rodei os testes do conserto sobre o código da `main`; só o Git. O primeiro teste de verdade é o CI do hotfix, depois do `release/ci`.

## 3. Parte 2: da `develop` até a `main`

### 3.1 Regras do plano

- **A produção só com o seu PRODUCAO.** Nenhum merge na `main` nem deploy de produção sai daqui: quem faz é o Eric (PRODUCAO digitado no `wings-deploy production` ou o hook liberado por ele), uma etapa por vez.
- **Cortes, não pedaços soltos.** Cada etapa leva a `develop` até um commit da linha principal dela (a ordem em que as ramificações entraram). Entre dois cortes o sistema está num estado que já existiu e foi testado.
- **Cada etapa é um PR `release/etapa-N` → `main`.** O CI roda no resultado da junção. Os PRs da seção 2 ainda não estão em nenhum corte: entram depois, como etapas 10 em diante (3.5).
- **Migração só para frente.** O banco não volta; se algo der errado, corrige-se para frente (3.7).
- **Nada de anúncio, verba, WhatsApp ou ligação para lead** em nenhuma etapa, nem em teste. Anúncio criado ou ligado continua exigindo a ordem do Eric no momento (`AGENTS.md`, seção 3).

### 3.2 Etapa 0: preparar o terreno (sem mexer na produção)

| #   | O que                                                                                                                                                                                                                                                                 | Quem                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 0.1 | Descobrir o que a produção roda **hoje**: commit ou data do build, e a última migração aplicada no banco dela. Define o cenário A (produção na `main`) ou B (3.3).                                                                                                    | Eric / quem opera      |
| 0.2 | Confirmar que o banco de produção tem **backup diário e um teste de restauração**. `docs/deploy.md` só documenta o backup do **staging**.                                                                                                                             | Eric / quem opera      |
| 0.3 | Levar para a `main`, num PR único (`release/ci`), a linha do #23 (`eslint.config.js`) **e** a mudança do #32 (`ci.yml`), para o CI de cada etapa e do hotfix rodar até o fim. O `ci.yml` é igual na `main` e na `develop`, então entram sem conflito. Não faz deploy. | Eric (merge em `main`) |
| 0.4 | Hotfix do #28 para a `main` (2.9), **depois** do 0.3. O deploy é separado das etapas e exige PRODUCAO.                                                                                                                                                                | Eric (merge e deploy)  |
| 0.5 | Acompanhar o lote 0 do Fable (#32 → #24 → #28 → #19 → #20 → #26) e ler o CI completo na `develop`: migração, seed e testes **nunca rodaram** nos últimos commits, pode haver falhas escondidas.                                                                       | sessão de IA           |
| 0.6 | Ensaio: restaurar o backup mais recente da produção num banco descartável e rodar `db:migrate` e `db:seed` duas vezes até a 0095. Anotar tempo e erros. Repetir, numa cópia do banco do staging, a `0098_wa_central` do #34 antes de ele entrar.                      | quem tem acesso        |
| 0.7 | Fechar a lista de variáveis de ambiente por etapa (3.4, só nomes) e criá-las no Coolify **desligadas**.                                                                                                                                                               | Eric                   |

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

| Etapa | O que entra                                                                    | Migração | Pré-requisito do Eric                                                                                         |
| ----- | ------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| 10    | lotes 0 e 1: #32, #24, #28, #19, #20 (Fable) e #33; o #23 já está na `develop` | nenhuma  | decisão 9: o #28 já terá ido antes, como hotfix                                                               |
| 11    | #26 WhatsApp do CRM: modelos, ligação                                          | 0096     | o número oficial do WhatsApp ainda **não** está no ar: parte da tela não funciona com lead real               |
| 12    | #9 → #10 → #12 caixa do WhatsApp                                               | 0097     | sair do rascunho                                                                                              |
| 13    | #34 Central WhatsApp, fase 1                                                   | 0098     | decisão 17: a migração derruba e recria dois índices únicos; ensaio na cópia do banco; recursos "a confirmar" |
| 14    | fase 2 da Central (quando chegar)                                              | 0099     | decisão 17                                                                                                    |
| 15    | #31 avaliação da Sofia (se aprovado)                                           | 0100     | decisão 5: o que muda na Sofia, que fala com leads                                                            |
| 16    | #22 Prospecção                                                                 | 0101     | `GOOGLE_PLACES_API_KEY` criada no Google e no Coolify                                                         |
| 17    | #25 Produtividade                                                              | 0102     | nenhum; a carga do DW roda 20 s depois de a API subir e a cada 15 min                                         |
| 18    | #27 Câmeras (base)                                                             | 0103     | decisão 11 (privacidade); só o piloto no escritório                                                           |
| 19    | passada do Prettier (só formatação, 2.8)                                       | nenhuma  | decisão 15                                                                                                    |

Etapas vizinhas podem ser fundidas se o Eric preferir menos deploys. Os números de migração são a projeção da 2.5.

### 3.6 Conferências por etapa

**Antes de cada etapa (todas, marcar no PR):**

- [ ] CI do PR `release/etapa-N` verde de ponta a ponta: build, typecheck, lint, migrate, seed duas vezes e testes. O `format:check` fica só como aviso até a passada do Prettier (2.8); depois dela volta a valer.
- [ ] `db:generate` diz "nada a gerar" (schema e migrações concordam).
- [ ] As migrações da etapa rodaram na cópia do banco de produção (0.6), com o tempo anotado.
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
5. **Quais PRs entram** e quais não: rascunhos #9/#10/#12, #11, #13, #16; o #29 (muda as regras das IAs); o #31 (muda o cérebro e o motor da Sofia, que fala com leads); as 4 branches soltas (2.2).
6. **A renumeração da 2.5** e se alguma dessas migrações **já foi aplicada no staging** (se foi, não se regenera: só se renomeia).
7. **Mudanças que o usuário nota**: menus e permissões novos (etapas 3 e 4), a negociação nova aberta pelo rodízio quando um lead da Meta bate com um lead fechado (etapa 1), e a **trava do WhatsApp do vendedor** até o número oficial entrar no ar (etapa 7).
8. **Anúncios e dinheiro**: subir a produção com a Google Ads API v26 e a nova espera da Meta (etapa 8) sem ter testado nas contas reais. Criar, ligar ou mudar verba de anúncio continua só por ordem sua no momento.
9. **Correção de segurança do #28**: já decidido que vai também como hotfix para a `main` (2.9). Falta você liberar o merge na `main` e o deploy com PRODUCAO, depois do `release/ci`.
10. **Ligar custos e envios**: e-mail de aviso ao dono e à gerência (`CRM_ESCALATION_EMAIL_ENABLED` só com o OK do Eric, segundo o `.env.example`), triagem pelo Jev (serviço externo), checagem do Instagram (teto em dólar por dia).
11. **Câmeras (#27)**: o módulo guarda só contagens, sem imagem nem reconhecimento facial, mas decidir se vai à produção antes de o Jurídico ler (LGPD art. 11).
12. **Contas e chaves que só você cria**: chave da Places API (#22), `WHATSAPP_ES_CONFIG_ID`, `JEV_API_KEY`, domínio, DNS e Turnstile da landing, novo app da landing no Coolify, SMTP.
13. **Política de volta**: aceitar "corrigir para frente primeiro, restaurar backup só em último caso" (3.7).
14. **Janela e congelamento**: durante cada etapa, nenhum outro deploy e nenhum merge na `develop`.
15. **Passada do Prettier (2.8)**: aprovar que o Prettier passe a **ignorar** `apps/api/migrations/meta/` (JSON gerado pelo Drizzle) e as pastas de ferramentas de IA copiadas (`.agents/`, `.codex/`, `.github/agents/`, `.github/hooks/`, `.github/skills/`), e que a passada ocorra no lote 4, depois do último PR aprovado.
16. **CI sem bloquear por formatação** enquanto isso (#32): aceitar que, até a passada, um arquivo novo mal formatado não derruba o CI; o `format:check` só mostra aviso.
17. **Posição do bloco WhatsApp** (#9 → #10 → #12 → #34 → fase 2): logo depois do #26, como o autor pede (proposta), ou depois dos quatro independentes; e se entra em passos (#9, #10, #12, #34) ou só o #34 refeito, fechando os outros três. Pesa nisso a migração do #34, que derruba e recria dois índices únicos e afrouxa colunas de `wa_numbers`, e os recursos "a confirmar" do título dele.

## 5. O que não foi conferido

- Servidor, Coolify, banco do staging e da produção, Meta e Google: sem acesso. Não sei qual commit o staging e a produção rodam, nem quais migrações já foram aplicadas lá.
- Não rodei build, typecheck nem testes (sem dependências instaladas nem banco). A simulação de junção foi só Git (conflito de texto). Afirmações de teste dos PRs vêm das descrições deles.
- O comportamento do Drizzle com datas (`when`) vem do comentário do `journal.test.ts` do #26 e do que conheço da biblioteca; vale confirmar num banco descartável.
- Código antigo sobre o banco novo (3.7): não testado.
- Do CI da `main` e dos 6 últimos da `develop`, abri os passos só da última execução da `develop`.
- O refazer do #34 (cherry-pick dos 4 commits próprios) e a geração das migrações renumeradas **não foram executados**: são o plano. O hotfix foi simulado só em Git, em cópias descartáveis já apagadas. A fase 2 e o hotfix ainda não existem no repositório; o que se sabe deles vem do pedido do Eric.
- A contagem de 220 arquivos foi medida com `prettier --list-different .` (versão 3.9.6, a do projeto) no commit `3bcd39e`. Não rodei o CI do #32 no GitHub Actions: o CI do próprio PR é a prova. Não formatei nada.

## Apêndice: como refazer os números (somente leitura)

```bash
git fetch origin develop main
git rev-list --count origin/main..origin/develop                 # 162
git rev-list --count --no-merges origin/main..origin/develop     # 99
git rev-list --count --since=2026-09-19 origin/develop           # 717
git diff --name-status origin/main origin/develop -- apps/api/migrations | grep -v meta   # 0084..0095
git log --first-parent --format='%h %cs %s' origin/main..origin/develop                   # os cortes da 3.4
npx prettier@3.9.6 --list-different .                                                     # 220 em 3bcd39e
```
