# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Wings System — the internal system of Wings Company (CRM, RH/DP, marketing automation), built one module at a time. UI text is Brazilian Portuguese; code, comments and docs are English.

The first module under construction is **Cadastro de Funcionários** (employee registration) with role-based access control.

## Commands

```bash
pnpm install            # install (pnpm workspaces, Node 24)
pnpm db:up              # local PostgreSQL on 127.0.0.1:5433 (docker-compose.dev.yml)
pnpm dev                # api :3000 and web :5173 in parallel
pnpm build              # builds shared -> api -> web (topological)
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @wings/api test                          # one workspace
pnpm --filter @wings/api exec vitest run src/x.test.ts # one test file

# database (apps/api)
pnpm --filter @wings/api db:generate   # generate a migration from schema changes
pnpm --filter @wings/api db:migrate    # apply pending migrations
pnpm --filter @wings/api db:seed       # reference data (sectors, roles, matrix, schedule); idempotent
```

The API container runs `db:migrate` then `db:seed` before serving, so both must stay safe to re-run. A hand-written migration goes in via `drizzle-kit generate --custom` so the journal stays consistent; never edit an applied migration. Drizzle tracks applied migrations in the separate `drizzle` schema — dropping only `public` leaves it thinking everything is applied.

`@wings/shared` compiles to `dist/`, so run `pnpm --filter @wings/shared build` (or `pnpm build`) after changing it, or the API and web builds will use stale types.

## Architecture

- **`packages/shared`** is the contract between frontend and backend: Zod schemas, role and permission names, shared enums. Anything both sides must agree on goes here so they cannot drift.
- **`apps/api`** (Fastify) owns all authorization. Permission checks run in one central policy layer, and data scoping (own / sector / all) is applied inside queries. The frontend only hides UI — it never decides access.
- **`apps/web`** (Vite + React) builds to `dist/`, which is the only thing the nginx image serves.
- Same origin in every environment: Traefik routes `/api/*` to the API and everything else to the web container, so there is no CORS and session cookies stay simple.

## Authentication

- **Server-side sessions, not JWT.** The cookie holds a random token; the database stores only its SHA-256 hash. Deactivating an employee or changing a role calls `revokeAllSessions()` so access ends at once.
- Passwords are **Argon2id** (19 MiB, t=2, p=1). Only hashes are stored, in `employee_credentials`, never in `employees`.
- Login failures are indistinguishable from outside: unknown e-mail, wrong password and credential-less accounts all return `invalid_credentials` after comparable work (`fakeVerify()` keeps the timing similar). Account lockout is 5 failures → 15 minutes, on top of a per-IP rate limit.
- Sessions expire after 30 idle minutes or 12 hours absolute. An idle expiry writes the RH/DP clock-out **at the last activity time**, never at "now".
- Unsafe methods reject a foreign `Origin` (CSRF), on top of `SameSite=Lax`.
- API integration tests create a **throwaway database per run** from `DATABASE_URL` (`src/test/db.ts`), so append-only rows never pollute a shared database.

## Non-negotiables

- **Secrets never enter the repository.** Real values live in Coolify environment variables; `.env.example` documents the names only.
- **CPF is encrypted at the application layer** (AES-256-GCM) with an HMAC blind index for uniqueness. It renders masked unless the caller holds the explicit reveal permission, and every reveal is written to the audit log. Losing `CPF_ENCRYPTION_KEY` makes stored CPFs unrecoverable.
- **Personal data must never be logged** (no CPF, full name, email or phone in logs or error messages).
- **Diretoria is fully blocked from TI sector employee records** — a deny rule evaluated before any allow rule.
- **Privilege escalation guards:** a sector manager (`is_sector_manager` flag on the employee) may only create or edit employees inside their own sector, may only assign roles below their own rank, and may never assign Admin Master or Diretoria.
- **Time entries are append-only.** Corrections are new adjustment rows with a reason and an approver; nothing is ever updated in place.

> ⚠️ Portaria MTP 671/2021 compliance for the time clock is **not yet legally confirmed**. Keep the model compliance-ready (append-only, sourced entries, exportable) and keep this warning visible until Jurídico signs off.

## Environments

| Environment | Branch    | Domain                     | Database               |
| ----------- | --------- | -------------------------- | ---------------------- |
| Staging     | `develop` | staging.wingssystem.online | own Coolify PostgreSQL |
| Production  | `main`    | wingssystem.online         | own Coolify PostgreSQL |

Coolify deploys from GitHub on push. The n8n PostgreSQL instance is never used by this app. Only `coolify-proxy` may publish host ports 80/443 — another container binding them once took every site on the server down.

The old static page still served from `/var/www/crm-vendas` (Marketing module mockup) will be ported into `apps/web` later; do not edit it as part of this work.
