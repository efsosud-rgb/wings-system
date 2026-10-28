@AGENTS.md

# CLAUDE.md

The rules every AI agent follows — folder structure, code standard, what never to do — are in `AGENTS.md`, imported above. Put a rule there, not here, so Codex and Jules get it too. This file keeps only what belongs to Claude Code (claude.ai/code).

## Claude Code in this repository

- **Skills** live in `.claude/skills/`; `INSTALLED.md` there says what is installed and what was left out. `/handoff` and `/grill-me` run only when typed.
- **Handoff:** `/handoff` writes a document for the next session into the OS temporary directory, not the repository, with secrets and personal data redacted. It points to commits and docs instead of copying them.
- **Agents** in `.claude/agents/`: `repo-researcher`, `docs-checker` and `code-reviewer` are the read-only ones (see "Contexto e custo"); the `impeccable-*` agents belong to the design skill.
- **Hooks and settings:** `.claude/settings.json` is versioned. It wires the status line, `context-warn.sh` (every prompt), `guard-production.sh` (before Bash) and `guard-secrets.sh` (before Bash and Read), all in `.claude/hooks/`, and allows `wings-staging-sql`, `wings-deploy`, `wings-env` and `wings-openrouter`. `.claude/settings.local.json` is personal and not tracked; the repository `.gitignore` has no entry for it, only a user-level git ignore on this machine hides it.

## Contexto e custo

- **Contexto: ao passar de ~150k tokens, avise o Eric em uma linha** (a barra de status e o hook `context-warn` mostram o tamanho) e sugira `/compact` se a tarefa continua a mesma, ou `/handoff` + `/clear` se muda a onda, a branch ou a worktree. Não pare a tarefa por isso. Sessões acima de 150k concentram a maior parte do gasto.
- **Subagentes só quando há paralelismo real**: trabalho independente que roda ao mesmo tempo, ou uma varredura grande de arquivos em que só a conclusão importa. Um fato em arquivo conhecido, uma edição pequena e um passo que depende do anterior ficam na sessão principal.
- No máximo **3 subagentes por tarefa**. **Nunca repetir uma busca já delegada.** Workflows multiagente (`Workflow`, "ultracode") só a pedido do Eric.
- Pesquisa, varredura e revisão de rotina usam os agents baratos de `.claude/agents/` (`repo-researcher`, `docs-checker` em haiku; `code-reviewer` em sonnet), todos só de leitura. **Código de risco** (autenticação, CPF, verba de anúncio, migrações, permissões) continua no modelo principal, e quem revisa não é mais fraco que quem escreveu.
- `.claude/settings.json` é versionado e traz travas: `guard-production` bloqueia deploy/escrita em produção e push/merge em `main` sem `WINGS_ALLOW_PRODUCTION=1`, que **só o Eric define** no terminal antes de iniciar o `claude`; `guard-secrets` bloqueia comandos que imprimem valores de segredo. Uma trava bloqueando não é erro a contornar: pare e peça ao Eric.

## Método (desde 27/10/2026)

- **Decisões** do Eric: `docs/decisoes.md` (uma por linha; consulte antes de propor algo que esbarre nelas). **Regras que nunca quebram**, com onde são garantidas, o teste e o estado: `docs/invariantes.md`. **Congelado até 14/11**: `docs/ideias.md` (ideia nova vai para lá, não para o código).
- **Briefing** que todo agente recebe e formato do relatório final: `docs/briefing-agente.md`. **Relatório de sexta**: `docs/relatorio-semanal.md`.
- **Portão de qualidade** (`.github/workflows/ci.yml`, todo PR): build, typecheck, lint, migrations do zero e seed ×2, `pnpm test`, os testes de escalada, `pnpm e2e` (fluxos de ponta a ponta da auditoria em `apps/api/e2e/`, API real num banco `wings_e2e` descartável, com a trava de rede) e nenhum arquivo novo com mais de 600 linhas (`scripts/arquivos-novos-grandes.sh`). Rode tudo no seu clone antes do PR.
- **Gancho do Git:** `sh scripts/instalar-hooks.sh` uma vez por clone (`git config core.hooksPath .githooks`). O `.githooks/pre-push` recusa push direto em `develop`, `main` e `homologacao`: só por PR. Não instale nos checkouts compartilhados (`/opt/wings-system`, `/opt/homologacao`) nem num worktree criado a partir deles (o `core.hooksPath` vai para o config compartilhado): isso é com o Eric. Use um clone próprio.
- **O gancho é uma ajuda, não uma trava.** `git push --no-verify` pula o gancho, um clone sem `instalar-hooks.sh` não tem gancho nenhum, e `gh pr merge` e o site do GitHub não passam por ele. O GitHub também não protege as branches: neste repositório (privado, plano grátis) a proteção de branch exige o plano Pro ou Team (a API responde 403 "Upgrade to GitHub Pro"), então uma CI vermelha avisa mas **não impede** o merge. Até o Eric decidir, quem segura develop e main é a disciplina de PR + revisão e as travas do Claude (`guard-production` cobre só `main`).
