# 0011 — Portão de qualidade em todo PR, numa CI que roda no servidor da Wings

- **Data:** 27/10/2026 (portão obrigatório; arquivo novo acima de 600 linhas não entra); 28/10/2026, 13h20 (runner
  próprio); 30/10/2026 (passada do Prettier depois das 5 etapas)
- **Quem decidiu:** Eric
- **Situação:** em vigor
- **Fonte:** `docs/decisoes.md` (linhas de 27/10 e 28/10); `CLAUDE.md` ("Método"); `AGENTS.md`, seção 2 ("Tests");
  `/opt/hermes/entrada/decisoes-2026-10-30.md` ("Passada do Prettier"); lições 6 e 7 de [`../licoes.md`](../licoes.md)
- **Onde conferir:** `.github/workflows/ci.yml`, `scripts/arquivos-novos-grandes.sh`, `apps/api/src/test/no-network.ts`,
  `apps/api/e2e/`

## Contexto

A auditoria de 27/10 achou regressões que passaram sem ser vistas. Em 28/10 o GitHub parou de iniciar jobs por limite de
cobrança, e não há orçamento para minutos pagos.

## Decisão

- Todo PR para `develop` e `main` passa por: build, tipos, lint, migrations do zero, seed duas vezes, todos os testes,
  os testes de escalada com nome próprio, os fluxos de ponta a ponta (`pnpm e2e`) e nenhum arquivo novo com mais de 600
  linhas.
- Quem faz o PR roda o mesmo portão antes, com banco descartável próprio (lição 6: "rodou só sem banco" não é verde).
- A CI roda num runner próprio do GitHub Actions no servidor da Wings, sem minutos pagos e sem GitHub Pro.
- Nenhum teste fala com plataforma real: a trava de rede (`no-network.ts`) é carregada pela configuração da raiz.

## Motivo

Regressões e correções fora da produção (27/10); arquivos gigantes não são revisáveis (27/10); sem orçamento para a CI
do GitHub (28/10). A trava de rede existe porque a Wings não tem conta de anúncio de teste.

## Consequências

- Comportamento novo traz teste na mesma mudança, e o teste novo prova algo (mutação registrada no relatório, lição 7).
- O `pnpm format:check` roda sem barrar o job até a passada única do Prettier, marcada para depois das 5 etapas da
  produção.
- Teste não depende do dia de hoje (lição 2): relógio fixo injetado.
