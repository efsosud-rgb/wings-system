# 0001 — TypeScript em tudo, React (Vite) na tela e Fastify na API, num monorepo pnpm

- **Data:** 16/09/2026 (primeiro commit, `d66a8bbb`)
- **Quem decidiu:** não registrado no repositório
- **Situação:** em vigor
- **Fonte:** `README.md` ("Frontend em React (Vite), API em Fastify, banco PostgreSQL próprio"); `AGENTS.md`, seções 1 e 2;
  commit `d66a8bbb` ("scaffold pnpm workspace (web, api, shared)")
- **Onde conferir:** `package.json` (`engines.node`, `packageManager`), `pnpm-workspace.yaml`, `tsconfig.base.json`,
  `apps/web/package.json` (react, vite), `apps/api/package.json` (fastify, drizzle-orm, zod), `packages/shared`

## Contexto

O Wings System é o sistema interno da Wings (CRM, RH/DP, automação de marketing), construído um módulo por vez, por
pessoas e por agentes de IA. A tela, a API e o worker precisam concordar sobre os mesmos dados e as mesmas permissões.

## Decisão

- Uma linguagem só: TypeScript `strict`, com `noUncheckedIndexedAccess` e `verbatimModuleSyntax`, em todos os pacotes.
- `apps/web`: Vite + React. `apps/landing`: Vite sem React. `apps/api`: Fastify. `apps/worker`: Node, com as tarefas
  tiradas do banco. Banco pelo Drizzle (ver [0002](0002-postgresql-proprio.md)).
- `packages/shared` é o contrato entre a tela e a API: schemas Zod, papéis, permissões e enums.
- pnpm workspaces e Node 24.

## Motivo

Não registrado. O efeito que a estrutura garante, e que o `AGENTS.md` descreve: o que a tela e a API precisam combinar
fica num pacote só (`packages/shared`), e as duas não divergem.

## Consequências

- Linguagem, framework de tela ou de API novos precisam de decisão nova do Eric, registrada aqui.
- Regra que a tela também precisa (nome de permissão, `roleChangeDenial`, um schema) vem de `packages/shared`; a tela
  nunca reescreve a regra.
- Depois de mudar `packages/shared`, é preciso compilá-lo (`pnpm --filter @wings/shared build`) antes da API e da tela.
- `packages/studio` é um fork de terceiros com licença própria (PolyForm Shield) e fica fora do padrão de código.
