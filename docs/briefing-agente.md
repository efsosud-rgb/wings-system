# Briefing padrão de agente

Todo agente (Claude Code, Codex, Jules ou outro) recebe este briefing preenchido antes de começar. Quem orquestra copia o bloco abaixo, troca o que está entre `<>` e manda junto com a tarefa. As regras gerais do repositório continuam no `AGENTS.md`; este briefing não as substitui.

```markdown
## Objetivo (uma frase)

<o que muda para o Eric quando isto estiver pronto>

## Branch

- Base: `origin/develop` (atualizada antes de começar).
- Nome: `<tipo>/<assunto-curto>` (ex.: `fix/crm-escopo-contato`). Trabalhe num clone seu (`gh repo clone`), nunca em `/opt/wings-system` nem num worktree dele.
- Rode `sh scripts/instalar-hooks.sh` no clone: o gancho recusa push direto em develop, main e homologacao. Ele é uma ajuda, não uma trava (`--no-verify` e outro clone passam, e o GitHub não exige CI verde neste plano): nunca faça push direto nessas branches.

## O que é "pronto"

- O objetivo acima funciona, com teste que falha sem a mudança e passa com ela.
- Portão de qualidade verde no seu clone e na CI do PR (abaixo).
- PR aberto como rascunho para `develop`, com o relatório final na descrição.
- `docs/invariantes.md` e `docs/decisoes.md` atualizados se a mudança mexe numa regra.

## Regra do período (até 14/11/2026)

Nenhum módulo novo. Só entra o que serve à prioridade: leads chegando; CRM estável e seguro; WhatsApp na tela;
Sofia com leads reais; reuniões e ligações pelo card. Ideia nova vai para `docs/ideias.md`.

## Portão de qualidade (o que a CI exige e você roda antes)

pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm lint
pnpm --filter @wings/api db:migrate && pnpm --filter @wings/api db:seed && pnpm --filter @wings/api db:seed
pnpm test # API, worker e shared sempre com --config ../../vitest.config.ts (trava de rede)
pnpm --filter @wings/api exec vitest run --config ../../vitest.config.ts src/modules/employees/escalation.test.ts
pnpm e2e # fluxos de ponta a ponta; DATABASE_URL de um Postgres local
sh scripts/arquivos-novos-grandes.sh origin/develop # nenhum arquivo novo com mais de 600 linhas
Teste que falha por tempo: rode o arquivo sozinho e diga no relatório quantas vezes passou.

## Proibido

- Deploy (inclusive `wings-deploy`), merge (`gh pr merge`), push em develop, main ou homologacao, `push --force`.
- Escrever em produção ou staging, ler banco real, mexer em variáveis do Coolify.
- Abrir `/etc/wings-crm` ou `.env` reais, imprimir variáveis de ambiente, pôr segredo em commit, log ou relatório.
- Chamar API real (Meta, Google, Z-API, RD, provedores de IA) com credencial real; enviar mensagem; ligar.
- Criar, publicar, reativar ou mudar verba de anúncio (decisão de 09/10).
- Dado pessoal de lead em qualquer coisa que você produz: cite o lead pelo id.
- Mexer em PR, branch, sessão tmux ou arquivo de outro agente.

## Precisa do Eric (pare e pergunte)

Merge, deploy, produção, verba de anúncio, regra da Sofia, decisão de produto (quem pode o quê), qualquer custo
novo, credencial, e qualquer trava (hook, permissão, confirmação digitada) que bloqueie você.

## Relatório final

1. **Resumo para o Eric, 10 linhas no topo**, em português simples: o que mudou, o que foi testado, o que ficou de
   fora e por quê, o que depende dele.
2. **Evidências**: cada afirmação com `arquivo:linha` e o comando rodado com o resultado real (números, não
   "passou"). O que não foi verificado aparece como "não verificado".
3. Lista de arquivos alterados e link do PR.

## Assinatura

- Cada commit termina com:
  Co-Authored-By: <modelo> <noreply@anthropic.com>
  Claude-Session: <link da sessão>
- A descrição do PR termina com:
  🤖 Generated with [Claude Code](https://claude.com/claude-code)

  <link da sessão>
```
