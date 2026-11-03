# 0005 — Permissão e escopo dos dados são decididos só na API

- **Data:** 16/09/2026 (commit `f82b64bc`, modelo de RBAC); regra de toda rota declarar o acesso registrada no
  `AGENTS.md` (seção 2)
- **Quem decidiu:** não registrado no repositório
- **Situação:** em vigor
- **Fonte:** `AGENTS.md`, seção 1 ("owns all authorization") e seção 2 ("Where logic lives"); `PRODUCT.md`, princípio 1;
  `docs/niveis-de-acesso.md`
- **Onde conferir:** `packages/shared/src/rbac/`, `apps/api/src/plugins/auth.ts` (`requirePermission`),
  `apps/api/src/modules/auth/route-access.test.ts`, `apps/api/src/modules/employees/escalation.test.ts`

## Contexto

O sistema tem níveis (Admin Master, Diretoria, RH/DP, gestor de setor, papéis por departamento) e dados com escopo
próprio, do setor ou de todos. A tela pode ser alterada por quem usa; a API não.

## Decisão

- A API decide toda permissão, numa camada central de política, e aplica o escopo (próprio / setor / todos) dentro das
  consultas. A tela só esconde o que a pessoa não pode usar.
- Toda rota declara o acesso no `preHandler`: `requirePermission`, `requireSession` ou `publicRoute(motivo)`. Rota sem
  declaração responde 403 para todos.
- Regra de negócio e consulta ficam em `service.ts` ou num arquivo do assunto, nunca dentro do handler.

## Motivo

Registrado no `AGENTS.md` e no `PRODUCT.md`: só o servidor é confiável para decidir acesso, e uma regra só, usada pela
tela e conferida pela API, não diverge.

## Consequências

- Id que vem da tela é sempre conferido no servidor; quem não pode recebe 403 ou 404, com teste.
- Os testes de escalada de privilégio (auditoria de 27/10) rodam com nome próprio na CI.
