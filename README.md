# Wings System

Sistema interno da Wings Company: CRM, RH/DP e módulos de automação.
Frontend em React (Vite), API em Fastify, banco PostgreSQL próprio.

## Requisitos

- Node.js 24+
- pnpm (via `corepack enable`)
- Docker (para o banco de desenvolvimento)

## Desenvolvimento

```bash
pnpm install
cp .env.example .env     # preencha os segredos locais
pnpm db:up               # PostgreSQL local em 127.0.0.1:5433
pnpm dev                 # web em :5173, api em :3000
```

Outros comandos: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## Estrutura

| Caminho           | Conteúdo                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`        | API Fastify. `src/modules/<nome>/` um por domínio; `src/plugins/auth.ts` sessões e `requirePermission`; `src/db/schema/` tabelas Drizzle; `src/lib/` auditoria, cripto de CPF, e-mail, storage; `src/scripts/` CLIs manuais; `src/test/`; `migrations/` SQL numerado |
| `apps/web`        | Frontend Vite + React. `src/pages/XxxPage.tsx` uma por tela, `src/components/`, `src/api/` cliente da API, `src/lib/`, `src/router.tsx`; gera `dist/`, a única coisa que a imagem nginx serve                                                                        |
| `apps/landing`    | Landing pages estáticas em hosts próprios (Vite, sem React): `<slug>/index.html`, `src/pages/<slug>/`, `src/lib/` (formulário, tracking, Turnstile, GTM). Ver `docs/landing/`                                                                                        |
| `apps/worker`     | Worker de fundo: jobs do banco (`WORKER_JOB_TYPES` escolhe quais), um handler por tipo em `src/jobs/`                                                                                                                                                                |
| `packages/shared` | Contrato entre web e api: schemas Zod, `src/rbac/` (papéis, permissões, `policy.ts`), `src/navigation.ts`, enums                                                                                                                                                     |
| `packages/studio` | Fork do Shotstack Studio SDK, o editor de vídeo (licença em `docs/studio/README.md`)                                                                                                                                                                                 |
| `docs/`           | Um arquivo ou pasta por módulo ou tema                                                                                                                                                                                                                               |
| `docker/`         | Dockerfiles da API, do web (nginx), das landing pages (template nginx) e do worker                                                                                                                                                                                   |
| `scripts/gtm/`    | Scripts pontuais do Google Tag Manager                                                                                                                                                                                                                               |
| `.github/`        | `workflows/ci.yml` é a CI; `agents/`, `hooks/` e `skills/`, como `.claude/`, `.agents/` e `.codex/`, são ferramental das IAs, não produto (o ESLint os ignora)                                                                                                       |
| Raiz              | `README.md`, `PRODUCT.md`, `docker-compose.dev.yml`, `.env.example` (só nomes de variáveis, nunca valores)                                                                                                                                                           |

## Ambientes

| Ambiente | Branch    | Domínio                    |
| -------- | --------- | -------------------------- |
| Staging  | `develop` | staging.wingssystem.online |
| Produção | `main`    | wingssystem.online         |

O deploy é feito pelo Coolify a partir do GitHub. Segredos ficam nas variáveis
de ambiente do Coolify — nunca neste repositório.

## LGPD

Registros de funcionários contêm CPF e outros dados pessoais. O CPF é
criptografado na aplicação, exibido mascarado por padrão e toda exibição
completa é registrada em log de auditoria. Detalhes em `docs/` (Fase 2).

> ⚠️ **Ponto eletrônico:** o modelo de dados é preparado para a Portaria MTP
> 671/2021 (registros apenas adicionáveis, com origem e exportáveis), mas a
> conformidade **ainda não foi validada juridicamente**. Não use para folha de
> pagamento até a aprovação do Jurídico.
