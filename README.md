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

| Caminho           | Conteúdo                                                        |
| ----------------- | --------------------------------------------------------------- |
| `apps/web`        | Frontend Vite + React + TypeScript                              |
| `apps/api`        | API Fastify + TypeScript                                        |
| `packages/shared` | Schemas Zod, papéis e permissões compartilhados entre web e api |
| `docker/`         | Dockerfiles de build e configuração do nginx                    |

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
