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
