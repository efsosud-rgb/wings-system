# Auditoria integral — CRM, WhatsApp, Sofia, Marketing, Dashboard e permissões (Wings System)

**Resumo para o Eric (10 linhas)**

1. **Produção está exposta:** a `main` (que roda em produção) não recebeu as correções de segurança de 13–14/10. No ambiente isolado, com o código de produção e contas fictícias, o RH/DP **tomou a conta de alguém da Diretoria** (troca do e-mail de login + "esqueci a senha"). O mesmo teste foi bloqueado na develop.
2. Na develop/staging achei e **corrigi** duas escaladas de privilégio (P0): um gestor criava contas com poderes que ele não tem (por exemplo, o Jurídico, que vê CPF de sócios) e inativava ou reativava quem está acima dele.
3. Também corrigi: rajada de senhas que burlava o bloqueio de conta, Diretoria gravando histórico de WhatsApp, vendedor criando etapa do funil pelo CSV, vendedor "roubando" a conversa da Sofia e o "esqueci a senha" que revelava contas quando o e-mail falha.
4. As correções estão em **PRs de rascunho #43 (P0), #44, #45**, e a prospecção Google Places atualizada no **#46**. Nada foi mesclado nem publicado.
5. **Validado** num ambiente isolado sem internet (banco criado do zero, dados fictícios): 41 fluxos ponta a ponta passam, e os 4 ataques de escalada são bloqueados com as correções.
6. Confirmado: o painel de vendas bate com uma conta independente no banco, um vendedor não vê dado de outro e nenhum segredo vai para log ou auditoria.
7. **Não corrigido, mas documentado (P1 de dinheiro):** a trava de teto de verba dos anúncios pode ser ultrapassada mesmo com aprovação manual, porque o reconcile de 15 em 15 minutos apaga as reservas. Também: campanha que gastou aparece como "Sem veiculação".
8. A Central WhatsApp (PRs #9→#39) não está integrada nem conectada à Meta (sem Tech Provider). As 87 conversas da Sofia (#31) são avaliação de qualidade, não teste de integração.
9. **Depende de você:** abrir o PR do hotfix de produção (a branch já está pronta e testada) e autorizar o deploy; revisar e mesclar os PRs #43–#46; decidir sobre as travas de verba e sobre o RH/DP poder inativar a Diretoria.
10. Os checkouts compartilhados ficaram intactos (o estado antes/depois bate). Nenhuma mensagem foi enviada, nenhuma API real foi chamada e nenhum banco existente foi alterado.

---

## 1. Data, autor e escopo

- 27/10/2026, 19:18–20:30 UTC. Claude (Opus 5.5), sessão `session_01Eyg9QveGLZf6bFDaQtrk8t`, como root no VPS srv1969146.
- Três auditores em paralelo (subagentes) cobriram auth/CRM, WhatsApp/Sofia e Marketing/Dashboard. Os relatórios completos, com arquivo:linha e testes de reprodução, estão em `/opt/auditoria-integral/achados/`. As correções, a validação ponta a ponta e este relatório são da sessão principal.

## 2. Repositório, branches e commits analisados

| Item                  | Valor                                                                             |
| --------------------- | --------------------------------------------------------------------------------- |
| Repositório           | `efsosud-rgb/wings-system`                                                        |
| develop (= staging)   | `3ab831d` (staging roda `7b98474`, ancestral; a diferença é só a landing do #33)  |
| main (= produção)     | `d019fdb` (#35); produção roda esse commit; banco na migration **0083**           |
| Clone desta auditoria | `/opt/auditoria-integral/wings-system` + worktrees `/opt/auditoria-integral/wt-*` |

## 3. Estado inicial dos checkouts e alterações preexistentes

| Checkout                                              | Branch                 | HEAD      | Alterações                                                                             | Tratamento                         |
| ----------------------------------------------------- | ---------------------- | --------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| `/opt/wings-system`                                   | develop                | `4fd3d9f` | 0                                                                                      | Só leitura, `GIT_OPTIONAL_LOCKS=0` |
| `/opt/homologacao/wings-system`                       | homologacao (só local) | `4fd3d9f` | 247 (177 não rastreados, 66 apagados, 4 modificados, quase todos em `.claude/skills/`) | Preservadas, intocadas             |
| 158 worktrees `/opt/wings-system-*` de outros agentes | várias                 | —         | 3 com 2 alterações cada                                                                | Intocadas                          |

Estado antes (`estado-antes.txt`, 19:18) e depois (`estado-depois.txt`): ver seção 18.

## 4. Matriz de status por módulo (final)

Legenda: Confirmado / Parcial / Pendente / Bloqueado / Não verificado. "Homologação" aqui é a **homologação efêmera isolada** desta auditoria (seção 11), porque não existe homologação isolada da API no Coolify (o ambiente "homolog" só tem a landing do PR #42).

| Módulo                    | Código existe                               | Integrado à branch                                                                            | Configurado                                                                                | Testado                                                                                         | Validado em homologação                                                                                                |
| ------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| CRM                       | **Confirmado**                              | **Confirmado** na develop/staging · **Parcial** na produção (76 merges e 13 migrations atrás) | Não verificado (variáveis do Coolify não são lidas por regra)                              | **Confirmado** (API 2077/2080 na develop; 3 falhas intermitentes conhecidas) + regressões novas | **Confirmado** no ambiente efêmero: criar, mover e anotar lead; escopo entre vendedores; Diretoria só lê; CSRF (41/41) |
| Prospecção Google Places  | **Parcial** (só nos PRs #22/#36)            | **Pendente** (proposta no PR #46)                                                             | **Pendente** (nada implantado; chave não usada)                                            | **Confirmado** com API falsa (89/89, inclui varredura do banco inteiro)                         | **Parcial**: só testes de integração com API falsa                                                                     |
| WhatsApp Central          | **Parcial** (pilha #9→#39)                  | **Pendente**                                                                                  | Não verificado (docs: número de teste da Meta; Tech Provider e Análise do app não pedidos) | **Confirmado** (pilha 426/426 nos módulos) com defeitos abertos                                 | **Pendente** (nada contra a Meta)                                                                                      |
| Sofia SRD                 | **Confirmado**                              | **Confirmado** na develop                                                                     | Não verificado (docs: ligada no staging desde 14/10, número de teste)                      | **Parcial** (integração com IA simulada; o #31 é avaliação de qualidade)                        | **Parcial**: silêncio após handoff confirmado; corridas WA-01/02 abertas na develop                                    |
| Marketing                 | **Confirmado** (Ads Intelligence só no #37) | **Confirmado** na develop · #37 e #11 pendentes                                               | Não verificado (ingestão por tarefa agendada no Coolify)                                   | **Confirmado** com falhas (M-1, T-1 a T-3)                                                      | **Parcial**: indicadores batem com SQL; travas de verba e M-1 falham                                                   |
| Dashboard                 | **Confirmado**                              | **Confirmado** na develop                                                                     | Não verificado                                                                             | **Confirmado**                                                                                  | **Parcial**: vendas bate com SQL e não vaza entre vendedores; M-3 e M-5 abertos                                        |
| Autenticação e permissões | **Confirmado**                              | **Confirmado** na develop · **Parcial** na produção                                           | Não verificado                                                                             | **Confirmado** + regressões novas                                                               | **Confirmado**: convite por setor; A1, M1, A2 e A3 bloqueados com as correções; produção vulnerável                    |

## 5. Problemas encontrados (severidade, evidência, estado)

Classificação em três dimensões, como pedido: **vulnerabilidade no código**, **explorabilidade** e **exposição efetiva**. Em nenhum caso há evidência de exploração real; não li logs nem auditoria de produção.

### P0

| ID                    | Achado                                                                                                                                                                                        | Onde                                                                        | Explorabilidade                                  | Exposição                                                                                                                                          | Estado                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0-PROD-1 (A1/M1)** | Produção sem o PR #1: quem tem `employees.update` troca o e-mail de login de colega de nível igual ou maior e toma a conta pelo "esqueci a senha"; Gerente inativa sem `employees.deactivate` | `main` `employees/service.ts:385,406,436`                                   | Login interno (RH/DP, gestor, Gerente Comercial) | **Código implantado em produção** (`d019fdb`); reproduzido de ponta a ponta no ambiente isolado com o código da main (RH/DP entrou como Diretoria) | Hotfix pronto: branch `hotfix/producao-email-login-inativar` (`4e66ad4`, `efe8252`, `338a5c7`), validado (41/41 e A1–A3 bloqueados). **PR para a main e deploy: precisam do Eric** |
| **A2**                | Gestor cria conta (ou muda subordinado) para nível com permissões que ele não tem e fica com o login                                                                                          | `packages/shared/src/rbac/policy.ts` (`roleChangeDenial` só comparava rank) | Gerente Comercial ou qualquer gestor de setor    | develop, staging e produção                                                                                                                        | **Corrigido no PR #43** (`72bd318`); também no hotfix                                                                                                                              |
| **A3**                | Gestor inativa ou reativa quem está acima (reativar devolve a senha antiga)                                                                                                                   | `policy.ts` (`statusChangeDenial`)                                          | Qualquer pessoa com a marca de gestor            | develop, staging e produção (pior na main)                                                                                                         | **Corrigido no PR #43**; também no hotfix                                                                                                                                          |

### P1

| ID             | Achado                                                                                                                                                           | Onde                                                   | Estado                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A4             | Diretoria importa e desfaz histórico de WhatsApp sem `leads.write`                                                                                               | `whatsapp/import-routes.ts`                            | **Corrigido no PR #45** (`7788916`)                                                                                                                                           |
| A5             | Vendedor cria etapa do funil de todos pela importação de CSV (sem `crm.manage`, sem auditoria)                                                                   | `leads/csv.ts` (`ensureStage`)                         | **Corrigido no PR #45** (`e00271f`)                                                                                                                                           |
| A6             | Bloqueio de conta (5 falhas) burlado por rajada paralela                                                                                                         | `auth/service.ts` (`registerFailedAttempt`)            | **Corrigido no PR #44** (`f5fbf0f`)                                                                                                                                           |
| **T-1**        | `reconcileAccount` sobrescreve `committed_cents` e apaga reservas ativas: com teto 400.000, dois aumentos aprovados por uma pessoa levaram a exposição a 520.750 | `ads/reconcile.ts:441-477`                             | **Não corrigido**: redesenho do invariante de dinheiro (ver seção 13). **Precisa do Eric**                                                                                    |
| **T-2**        | Reserva devolvida duas vezes depois de um reconcile                                                                                                              | `ads/budget-guard.ts:916-921`                          | Idem T-1                                                                                                                                                                      |
| **T-3**        | Pedido de redução libera espaço na hora do pedido; pedido duplicado libera de novo                                                                               | `budget-guard.ts:561-583`                              | Idem T-1                                                                                                                                                                      |
| **M-1**        | Campanha com gasto só nos anúncios aparece "Sem veiculação" (o #11 corrige só a aba; o #18 piorou)                                                               | `ads/dashboard/queries.ts:877,911`, `CampaignsTab.tsx` | **Não corrigido**: muda a semântica dos números de todas as telas de mídia. Recomendação: derivar o nível campanha dos anúncios no ponto compartilhado (ingestão ou `sumsOf`) |
| P1-MIG-1       | Colisão de números (e datas) de migrations entre PRs abertos                                                                                                     | seção 10                                               | Documentado; #46 já usa 0097                                                                                                                                                  |
| I-1, I-2 (#37) | Pausa duplicada devolve o teto 2×; migração 0103 no idx 96 do journal (pode ser pulada em silêncio)                                                              | PR #37                                                 | Documentado para o autor do #37                                                                                                                                               |

### P2 (principais)

| ID                  | Achado                                                                                                                              | Estado                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| WA-01               | Mensagem que chega devolve à Sofia a conversa que uma pessoa acabou de assumir                                                      | Corrigido na pilha da Central (não integrada); aberto na develop                        |
| WA-02               | Quem escreve pela tela só "assume" depois da chamada à Meta; a Sofia responde junto                                                 | Idem WA-01                                                                              |
| WA-03               | Vendedor captura a conversa da Sofia cadastrando a negociação com o telefone                                                        | **Corrigido no PR #45** (`1de8613`)                                                     |
| WA-04               | Filtro da frase da IA não barra pedido de documento, foto ou CPF                                                                    | Documentado: muda regra da Sofia → **precisa do Eric** (o #31 já marca os mesmos casos) |
| A10                 | "Esqueci a senha" com SMTP falhando: 500 só para e-mail existente e texto do SMTP na resposta                                       | **Corrigido no PR #44** (`cd88afc`)                                                     |
| M-2                 | Mesmo com o #11, outras telas (Plataformas, vereditos, Funil, Cockpit, agente, Vendas) leem só o nível campanha e passam a divergir | Documentado (mesma correção de M-1)                                                     |
| M-3, M-4            | Painel de Vendas mostra "R$ 0,00" para campanha zerada; conversões fracionadas do Google viram 0                                    | Documentado                                                                             |
| M-5                 | Falha de sincronização (RD, Leads das Campanhas, GA4) aparece como "Dados lidos há X", não como falha                               | Documentado                                                                             |
| T-4, T-5            | Aprovar e rejeitar ao mesmo tempo valem as duas; pedido preso após rejeição                                                         | Documentado (junto com T-1)                                                             |
| I-3, I-4, I-5 (#37) | Teto diário de IA furável; compliance não cobre roteiro de vídeo; consentimento da CAPI não cobre compartilhar com a Meta           | Documentado para o #37                                                                  |
| P2-TEST-1           | Testes intermitentes: `leads.test.ts` (Meta Lead Ads → RD CRM) e arquivos que estouram tempo sob carga                              | Documentado; não é defeito de produto comprovado                                        |

### P3 (só documentados)

A7 (bloqueio revela que o e-mail existe: 429 x 401), A8 (`trustProxy: true` aceita X-Forwarded-For do cliente se o proxy repassar), A9 (links de senha que voltam a valer após inativar/reativar; convite segue válido após reset), A11 (RH/DP inativa Diretoria — **decisão do Eric**), A12 (permissão de leitura guardando escrita em 3 rotas, sem exploração hoje), WA-05/06/07…12 (status de entrega que chega antes do `wamid` se perde; sem auditoria quando a Sofia passa para uma pessoa; motivo de handoff errado; trava `official_number_live` não segura a Sofia; **texto livre ainda permitido por 24 h depois de "SAIR"**; rollback da 0097 não documentado), tentativas negadas de convite não geram auditoria. Detalhes em `achados/*.md`.

## 6. PR #35 e demais PRs investigados

| PR                      | Situação real                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#35** (hotfix → main) | Mesclado em 26/10. Corrige `POST /auth/invite` (alvo fora do setor). **Está na main e na develop** (via #28, patch idêntico). Confirmado por teste do auditor (404 nas duas rotas, também na main) e pelo E2E (gestor de Marketing e Gerente recebem 403/404 fora do setor; dentro do setor o convite chega ao SMTP falso; o link não serve duas vezes: 410). |
| #28                     | Mesclado na develop 27/10; mesmo conteúdo do #35.                                                                                                                                                                                                                                                                                                             |
| #1                      | Mesclado na develop 13/10; **não está na main** → P0-PROD-1.                                                                                                                                                                                                                                                                                                  |
| #22 / #36               | Abertos; 41 commits atrás; migração 0096 colide. Retenção do Google conferida e reforçada por teste; proposta atualizada no **#46**.                                                                                                                                                                                                                          |
| #9→#10→#12→#41→#38→#39  | Pilha da Central, já sobre a develop atual (0 atrás); migrações 0097–0100; 426/426 testes; corrige WA-01/02; WA-03, 04 e 06 seguem abertos. Não integrada, não configurada.                                                                                                                                                                                   |
| #31                     | Avaliação de qualidade (87 conversas com modelo roteirizado, só `readTurn`); não é teste de integração; o modo com modelo real nunca rodou; migração 0096 colide.                                                                                                                                                                                             |
| #37                     | Ads Intelligence: telas só com dados espelhados, IA sem dado de lead, CAPI desligada por padrão, 8 rotas com permissão, suítes 51/51 (API) e 15/15 (worker); achados I-1 a I-5; migração 0103 mal posicionada.                                                                                                                                                |
| #11 / #18               | #18 mesclado na develop (não na main); #11 (rascunho) aplica limpo e corrige só a aba Campanhas (M-1/M-2).                                                                                                                                                                                                                                                    |

## 7. Correções implementadas e arquivos alterados

| PR (rascunho)        | Branch                                               | Commits                                         | Arquivos                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#43** P0           | `fix/seguranca-niveis-e-inativacao`                  | `72bd318`                                       | `packages/shared/src/rbac/policy.ts`, `policy.test.ts`; `apps/api/src/modules/employees/service.ts`, `escalation.test.ts` (novo); `apps/web/src/pages/EmployeeFormPage.tsx`; `AGENTS.md`; `docs/auth.md` |
| **#44** auth         | `fix/auth-bloqueio-e-esqueci-senha`                  | `f5fbf0f`, `cd88afc`                            | `apps/api/src/modules/auth/service.ts`, `credentials-service.ts`, `auth.test.ts`, `credentials.test.ts`                                                                                                  |
| **#45** CRM/WhatsApp | `fix/crm-whatsapp-escopo`                            | `7788916`, `e00271f`, `1de8613`                 | `whatsapp/import-routes.ts`, `import.test.ts`; `leads/csv.ts`, `nucleo-routes.ts`, `contacts.ts`, `service.ts`, `routes.ts`, `owner-scope.test.ts`, `nucleo.test.ts`                                     |
| **#46** prospecção   | `feat/prospeccao-sobre-develop`                      | `9213bed` (merge + 0097), `9bec0f6` (teste)     | ver PR; conflitos em `CallPanel.tsx`, `docs/niveis-de-acesso.md`, journal/snapshot                                                                                                                       |
| (sem PR)             | `hotfix/producao-email-login-inativar` (base `main`) | `4e66ad4`, `efe8252` (PR #1), `338a5c7` (A2/A3) | PR #1 + `policy.ts` etc.                                                                                                                                                                                 |

Cada correção: problema e evidência → reprodução por teste → causa raiz → mudança pequena no ponto compartilhado → teste de regressão (que **falha** no código antigo) → suítes relacionadas → revisão do diff.

## 8. Testes executados

Banco efêmero `audit-pg` (postgres 17, 127.0.0.1:55432, tmpfs). Cada teste de integração cria e apaga o próprio banco; sempre com `--config ../../vitest.config.ts` (bloqueio de rede).

| Alvo                                         | Comando (resumo)                                                                 | Resultado                                                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| develop — linha de base                      | `pnpm build`, `typecheck`, `lint`, `db:migrate`, `db:seed` ×2, testes por pacote | Tudo OK; shared 452, landing 87, worker 150, studio 2091, web 1197/1201 (4 instáveis, 74/74 isolados), api 2077/2080 (3 intermitentes)                                                                        |
| Integração local das correções (#43+#44+#45) | idem + prettier dos alterados                                                    | build/typecheck/lint/format/migrate/seed OK; shared 455, worker 150, landing 87, web **1201/1201**, api 2091/2095 (as mesmas intermitentes; `leads.test.ts` isolado 28/28 em 2 de 3 rodadas, igual à develop) |
| #43                                          | `escalation.test.ts`, rbac, employees, auth, tela                                | 8/8 (6 falham na develop), shared 455, API 112, tela 30                                                                                                                                                       |
| #44                                          | auth + employees                                                                 | 106/106; os 2 testes novos falham na develop                                                                                                                                                                  |
| #45                                          | import, route-access, owner-scope, nucleo                                        | 36/36, 27/27, OK; teste A4 falha na develop                                                                                                                                                                   |
| #46                                          | CI completa + prospecting/db                                                     | 89/89; API 2147+10 (2 por tempo, passam isolados); web CRM 371; shared 463                                                                                                                                    |
| Hotfix de produção                           | employees, auth, frame-guard, rbac, tela                                         | 103/103, 52/52, 28/28 (o lint da main já falha antes, em `scripts/gtm`)                                                                                                                                       |
| Auditores                                    | testes `*.audit.test.ts` nas worktrees                                           | auth/CRM: 29 testes (14 vermelhos = achados); WhatsApp/Sofia: 14 (develop 9 ok, 5 achados); Marketing: 9 arquivos                                                                                             |

CI do GitHub nos PRs #43–#46: disparada na abertura (resultado no próprio PR).

## 9. Resultado dos testes ponta a ponta (os 10 fluxos pedidos)

Servidor real da API rodando num **namespace de rede só com loopback** (teste de saída para a Meta: "sem rede"), banco por socket Unix, SMTP falso local, 13 pessoas fictícias. Rodado igual na develop, na main, na integração das correções e no hotfix.

| #   | Fluxo                                         | Como                                                    | Resultado                                                                                                                                                      |
| --- | --------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Usuário autorizado cria e atualiza lead       | E2E                                                     | **Passou** (criar 201, mover etapa 200, anotar 201, releitura confere)                                                                                         |
| 2   | Sem escopo acessa lead de outro → bloqueio    | E2E + 63 rotas do auditor                               | **Passou** (404 em leitura, edição, nota, troca de dono; lista não traz; Diretoria lê e não edita; sem sessão 401; Origin estranha 403)                        |
| 3   | Gestor convida fora do escopo → bloqueio      | E2E                                                     | **Passou** (403/404 nas duas rotas; dentro do setor 200 com e-mail; aceite 200; link reusado 410; login OK)                                                    |
| 4   | Google Places com mocks e retenção            | Teste de integração (API falsa via `app.inject`)        | **Passou** (89/89 + varredura de todas as tabelas). Não rodado como servidor: sem rede, a busca cairia no erro 502                                             |
| 5   | Mensagem de WhatsApp simulada sem número real | Testes de integração do auditor (HMAC, duplicata, fila) | **Passou** (503 sem segredo, 401 com corpo alterado, duplicata = 1 resposta, nenhum envio real)                                                                |
| 6   | Sofia passa para humano e se cala             | Testes do auditor (IA simulada)                         | **Passou** no caso sequencial e em rajada; **falha** nas corridas WA-01/02 da develop (corrigidas na pilha)                                                    |
| 7   | Marketing produz indicadores esperados        | Testes do auditor (dados sintéticos)                    | **Passou** para gasto, impressões, cliques, CTR, CPC, CPM, CPL "—"; **falha** em M-1                                                                           |
| 8   | Dashboard bate com a fonte                    | Testes do auditor (SQL independente)                    | **Passou** em vendas (ganhos, perdidos, ticket, conversão, carteira, fuso de São Paulo) e sem vazamento; M-3 aberto                                            |
| 9   | Falha de integração aparece como falha        | E2E + testes                                            | **Passou** (status do Meta Lead Ads mostra "não configurado"; prospecção 503 sem chave; A10 corrigido); **falha** em M-5                                       |
| 10  | Auditoria sem segredos                        | E2E (varredura)                                         | **Passou**: 0 de 19 segredos da rodada (senhas, cookies, token) e 0 e-mails no log do servidor e na `audit_log`; login, convite, senha, lead e etapa auditados |
| —   | Escalada A1, M1, A2, A3                       | E2E (`flows-a1.mjs`)                                    | **main: os 4 vulneráveis** · develop: A1/M1 protegidos, A2/A3 vulneráveis · integração e hotfix: **os 4 protegidos**                                           |

## 10. Estado das migrations

- develop: 0000–**0096** (`journal.test.ts` confere ordem). Produção: até **0083** (faltam 0084–0096: entram com o próximo deploy da develop para a main).
- PRs abertos: 0096 (#22/#36 → regenerada como **0097** no #46; #31), 0097 (#9, #25), 0098 (#41, #27), 0099 (#38), 0100 (#39), 0103 (#37, no idx 96 do journal).
- Nenhuma migration de PRs diferentes mexe na mesma tabela (só dentro da pilha do WhatsApp): o conflito é de **número e data**.
- **Regra para quem mesclar por último:** regenerar com `drizzle-kit generate` (novo número e novo `when`); só renomear não basta, porque o drizzle aplica só migração com `when` maior que a última aplicada e pode pular em silêncio (achado I-2).
- Aplicadas apenas nos bancos efêmeros (`audit-pg`, `audit-pg-e2e`), do zero. **Nenhuma migration em banco existente.**

## 11. O que foi efetivamente validado em homologação

- Homologação do Coolify: não serve (só landing do #42; staging é o CRM real da equipe). **Validação feita na homologação efêmera isolada** descrita na seção 9: API compilada de cada branch, banco do zero, dados fictícios, sem internet.
- Validado ali: fluxos 1, 2, 3, 9 e 10 e a escalada A1–A3, nas quatro versões (develop, main, integração, hotfix). Fluxos 4–8 validados por testes de integração com mocks (servidor Fastify em memória + Postgres real), não por servidor isolado.
- Não validado: interface web no navegador (sem navegador disponível), worker em execução, staging e produção reais, Meta, Google, RD e IA reais.

## 12. Pendente, bloqueado ou não verificado

- **Precisa do Eric:** PR do hotfix para a `main` + deploy; revisão e merge de #43–#46; deploy em staging; travas de verba (T-1 a T-5); M-1/M-2 (como corrigir os números); WA-04 (regra da Sofia); A11; chave da Places API; conexão de número de trabalho e Tech Provider na Meta.
- **Não verificado:** variáveis e cron do Coolify; configuração real do Traefik (A8); SMTP real; uso real e contas existentes em produção; exploração real de qualquer achado.
- **Pendente técnico:** P2/P3 documentados; testes intermitentes (P2-TEST-1).

## 13. Riscos residuais

1. **Produção vulnerável até o deploy do hotfix** (A1, M1, A2, A3) — insider com papel de gestor/RH.
2. **Teto de verba ultrapassável** (T-1 a T-3) mesmo no fluxo manual, se um pedido atravessar um ciclo de reconcile (15 min). Mitigação enquanto não corrige: aprovar e executar aumentos no mesmo ciclo, evitar pedidos duplicados e manter **zero automação** (regra do AGENTS.md). Proposta de correção: reconcile numa transação com `FOR UPDATE`; comprometido = exposição na plataforma + soma dos aumentos com reserva ativa; reduções só contam executadas; um pedido aberto por campanha; liberação idempotente (`reservation_active=false` + recálculo).
3. Corridas da Sofia (WA-01/02) na develop até a pilha da Central entrar.
4. Números de mídia subestimados quando a Meta zera a linha da campanha (M-1/M-2).
5. Testes intermitentes podem esconder regressões reais na fila do Meta Lead Ads.

## 14. Dependências externas

Google Places API (chave restrita, cota), Meta (Tech Provider, Análise do app, permissões, número de trabalho), SMTP real, OpenRouter/IA da Sofia, RD Station CRM, Coolify (deploys, variáveis, tarefas agendadas).

## 15. Instruções para revisão e integração

1. **Hotfix de produção:** Eric (ou alguém autorizado) abre o PR `hotfix/producao-email-login-inativar` → `main`, revisa e publica com `wings-deploy production`. Alternativa: levar a develop inteira para a main (PR #30), que já contém tudo.
2. **#43** primeiro (P0, pequeno). Depois **#44** e **#45** (independentes; juntam sem conflito, testados juntos).
3. **#46** (prospecção) quando o Eric decidir; se a pilha do WhatsApp entrar antes, regenerar a migração.
4. Pilha da Central (#9→#39): manter a ordem; regenerar migrações se outro PR com migração entrar antes; corrigir WA-03 nela (o #45 corrige na develop) e WA-04/06.
5. #37: corrigir I-1 e regenerar a 0103 antes de mesclar.
6. Depois de cada merge: CI verde + `wings-deploy staging` (pelo Eric) + teste manual com contas de teste.

## 16. Plano de rollback

- #43, #44, #45: `git revert` dos commits; sem migração, sem dado alterado.
- #46: reverter o merge; a migração só cria 3 tabelas e uma coluna anulável (remover em migração nova, se preciso); desligar sem reverter: tirar `GOOGLE_PLACES_API_KEY` (503) ou as permissões `prospecting.*`.
- Hotfix de produção: redeploy do commit anterior (`d019fdb`) pelo Coolify.
- Ambiente desta auditoria: containers `audit-pg` e `audit-pg-e2e` removidos ao final; pastas em `/opt/auditoria-integral`.

## 17. Itens que exigem autorização humana

1. Abrir PR para a `main` e publicar o hotfix (produção).
2. Mesclar #43, #44, #45, #46 e publicar em staging.
3. Corrigir as travas de verba (mexe em dinheiro de anúncio) e decidir a regra de M-1/M-2.
4. Mudar o filtro de frases da Sofia (WA-04) e a regra de texto livre após "SAIR" (WA-12).
5. Decidir A11 (RH/DP inativar Diretoria).
6. Configurar a Places API, conectar número de WhatsApp, Tech Provider/Análise do app da Meta, ligar a CAPI.
7. Ler a auditoria de produção para saber se algum achado foi explorado.

## 18. Checkouts compartilhados: antes e depois

Comandos usados neles: só `GIT_OPTIONAL_LOCKS=0 git rev-parse/status --porcelain/log/diff/show`.

| Checkout                        | Antes (19:18 UTC)                                      | Depois (20:27 UTC) |
| ------------------------------- | ------------------------------------------------------ | ------------------ |
| `/opt/wings-system`             | develop `4fd3d9f`, 0 linhas, sha `e3b0c442…b855`       | **idêntico**       |
| `/opt/homologacao/wings-system` | homologacao `4fd3d9f`, 247 linhas, sha `42dc7678…1484` | **idêntico**       |

`diff` entre `estado-antes.txt` e `estado-depois.txt` (sem a linha de data): sem diferença. As 247 alterações da homologação ficaram intactas.

## 19. O que não fiz ou não conferi

Não abri `/etc/wings-crm`, `.env` reais nem variáveis de containers; não li bancos de staging ou produção; não chamei APIs reais; não enviei mensagens; não fiz deploy, merge, push em develop/main nem force push; não toquei no PR #42 nem em PRs de outras pessoas. A interface web não foi testada em navegador.
