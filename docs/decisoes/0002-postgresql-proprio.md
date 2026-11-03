# 0002 — PostgreSQL próprio em cada ambiente, com migrations do Drizzle

- **Data:** 16/09/2026 (commits `d66a8bbb`, `f82b64bc` e `b5afdb9a`); 27/10/2026 (migration em conflito é regenerada);
  30/10/2026 (cópia do banco antes de cada etapa da produção)
- **Quem decidiu:** não registrado para a escolha do banco; Eric para as regras de 27/10 e 30/10
- **Situação:** em vigor
- **Fonte:** `README.md` ("banco PostgreSQL próprio"); `AGENTS.md` (tabela de ambientes; seção 2, Migrations; seção 3,
  "The n8n PostgreSQL instance is never used by this app"); `docs/deploy.md` (banco `wings-system-db-staging`,
  postgres:17-alpine, sem porta pública, separado do n8n; backups); `docs/decisoes.md` (linha de 27/10 sobre migration);
  `/opt/hermes/entrada/decisoes-2026-10-30.md` (primeira linha: cópia manual antes de cada etapa e cópia diária depois)
- **Onde conferir:** `apps/api/src/db/schema/`, `apps/api/migrations/`, `apps/api/src/db/journal.test.ts`,
  `apps/api/src/test/db.ts`, passos de migrate e seed da `.github/workflows/ci.yml`

## Contexto

O sistema guarda CPF, dados de leads, ponto e dinheiro de anúncios. No mesmo servidor roda também o n8n, com o
PostgreSQL dele.

## Decisão

- Cada ambiente (staging e produção) tem o seu PostgreSQL, criado no Coolify, sem porta pública. O PostgreSQL do n8n
  nunca é usado por este sistema. Nenhum banco gerenciado de terceiros.
- O esquema muda só por migration gerada pelo Drizzle (`db:generate`), commitada junto do código. O contêiner da API roda
  `db:migrate` e `db:seed` antes de servir, então os dois precisam poder rodar de novo sem erro.
- Migration em conflito com outra branch é regenerada (número e data novos), nunca só renomeada (27/10).
- Antes de cada etapa da produção, cópia manual do banco; depois das etapas, cópia diária automática da produção (30/10).

## Motivo

A escolha do PostgreSQL não tem motivo registrado; a separação do n8n está em `docs/deploy.md`. A regra de regenerar a
migration existe porque o Drizzle pula em silêncio uma migration com data mais antiga que a última aplicada (achado I-2
da auditoria de 27/10).

## Consequências

- Dinheiro em inteiro (`*_cents`, `cost_micro_usd`), nunca em ponto flutuante; tabelas e colunas em `snake_case`.
- Testes da API criam um banco descartável por rodada a partir do `DATABASE_URL`; nenhum teste usa o banco do staging
  ou da produção.
- Tabela que o papel só de leitura `wings_ro` precisa ver ganha o `GRANT` numa migration.
- Voltar atrás numa etapa da produção volta o programa e deixa o banco como está; restaurar a cópia é último caso e
  decisão do Eric (ver [0009](0009-producao-so-com-o-eric.md)).
