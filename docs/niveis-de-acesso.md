# Access levels (níveis de acesso)

Eric's order of 13/10/2026, after the sellers opened the whole system on staging. One matrix decides who sees
what, and both the API and the screen read it:

- **The matrix:** `ROLE_PERMISSIONS` in `packages/shared/src/rbac/permissions.ts`, level × permission. A
  permission is `module.action` (`leads.read`, `sofia.read`). What a level does not hold is denied.
- **The API** (`apps/api/src/plugins/auth.ts`): every route declares its access in its `preHandler`, one of
  - `app.requirePermission(p)` or `app.requireAnyPermission([...])`: the module permission from the matrix;
  - `app.requireSession`: any login (only `/auth/me` and the person's own Google connection);
  - `app.publicRoute(reason)`: no login (login, password links, webhooks with their own secret, the landing
    page form, signed file links).

  `app.requireAuth` alone declares nothing. A route without a declaration answers **403 `route_not_declared`**
  to everyone, the Admin Master included, and `apps/api/src/modules/auth/route-access.test.ts` fails: it lists
  every undeclared route, pins the public and any-login routes by name, and calls one route per module as each
  level. Row scope (own / sector / all) is still decided inside the route, as before (`leads/access.ts`).

- **The screen:** `GET /auth/me` returns the person's permissions; the menu (`visibleNavigation`) and every route
  (`RequireSubmodule` in `apps/web/src/components/RequirePermission.tsx`) use the same rule, `canSeeSubmodule` in
  `packages/shared/src/navigation.ts`. An address typed by hand shows **"Sem acesso"** when the menu would not
  have offered it. Deny by default: a built screen with no permission is shown to nobody (only Início says
  `everyone`), and an "em breve" placeholder also needs `modules.preview`, which only Admin Master and Diretoria
  hold.

## The matrix by module

`own` = only the person's own leads; `dept` = the departments of the level (Drive) or the stages of its own
department (Projects); `sector` = the person's own sector. Formatação is the six sub-levels (Jurídico,
Financeiro, Processos e Projetos, Contábil/Tributário, Logística, TI).

| Module → screen                         | Admin Master | Diretoria         | RH/DP | Gerente Comercial | Marketing | Formatação                    | Vendedor Expansão | Vendedor Formatação |
| --------------------------------------- | ------------ | ----------------- | ----- | ----------------- | --------- | ----------------------------- | ----------------- | ------------------- |
| Início                                  | yes          | yes               | yes   | yes               | yes       | yes                           | yes               | yes                 |
| CRM Vendas (deals, WhatsApp, contacts…) | all          | all, no editing   | —     | all               | —         | —                             | own               | own                 |
| CRM → Configurações                     | yes          | —                 | —     | yes               | —         | —                             | —                 | —                   |
| CRM → Sofia (every conversation)        | yes          | yes               | —     | yes               | —         | —                             | —                 | —                   |
| Dashboard → Vendas                      | all          | all               | —     | all               | —         | —                             | own               | own                 |
| Dashboard → Marketing                   | yes          | yes               | —     | —                 | yes       | —                             | —                 | —                   |
| Dashboard → Leads das Campanhas         | all          | all               | —     | all               | —         | —                             | —                 | own                 |
| Marketing (traffic agent, media studio) | yes          | yes               | —     | —                 | yes       | —                             | —                 | —                   |
| Formatação → Clientes                   | yes          | yes               | —     | —                 | yes       | Jurídico only                 | —                 | —                   |
| Gestão → Projetos                       | all          | all               | read  | dept              | dept      | dept (P&P all; Log., TI read) | dept              | dept                |
| Drive                                   | all          | all               | dept  | dept              | dept      | dept                          | dept              | dept                |
| Administração → Usuários e acessos      | all          | all (levels only) | all   | sector            | —         | —                             | —                 | —                   |
| Administração → Drive: modelo de pastas | yes          | yes               | —     | —                 | —         | —                             | —                 | —                   |
| Administração → Roadmap, Integrações    | yes          | —                 | —     | —                 | —         | —                             | —                 | —                   |
| Configurações, APIs e credenciais       | yes          | —                 | —     | —                 | —         | —                             | —                 | —                   |
| Laboratório, SaaS                       | yes          | —                 | —     | —                 | —         | —                             | —                 | —                   |
| "Em breve" placeholders                 | yes          | yes               | —     | —                 | —         | —                             | —                 | —                   |

Also by level, outside the menu: the sector-manager flag (`is_sector_manager`) adds the register of the person's
own sector; Diretoria never sees TI sector records; Diretoria does not edit deals or employee data (only levels);
nobody but the Admin Master sets the ad budget caps or connects Kairogen.

Decisions of 13/10, asked and answered: sellers keep the WhatsApp inbox, Projects, the Sales dashboard and (Vendedor
Formatação) Leads das Campanhas, and lose the Sofia screen and the employee register; the Gerente Comercial keeps
what the repository gave it and gains the Sofia screen; Diretoria stays as it was; Configurações and APIs belong to
the Admin Master alone (Formatação — TI lost them); Marketing and Formatação lost the register of their sector.

Not in the system: **Notion** (no module or link exists). **Agenda and Meet** for a seller are the Google
connection in "Minha conta" and the meetings and tasks inside the deal; the Produtividade → Agenda and Reuniões
menu entries are still "em breve", so they show only to Admin Master and Diretoria.

## Test accounts (staging)

`apps/api/src/scripts/test-accounts.ts`, run inside the staging API container, makes one account per level except
Admin Master (`Teste <nível>`, e-mail `teste.<nivel>@contas-teste.invalid`). It sends no invite and no e-mail: it
issues the invite link and uses it itself, with a random password, and prints `nível, e-mail, senha` on stdout,
which goes straight into a mode-600 file outside the repository. It refuses to run outside staging.

```bash
docker exec <api-staging> node dist/scripts/test-accounts.js estado
docker exec <api-staging> node dist/scripts/test-accounts.js criar > /root/.segredos/contas-teste-staging.tsv  # umask 077
docker exec <api-staging> node dist/scripts/test-accounts.js desativar   # when the check is over
```

The test sellers are not in any rotation (rotation members are chosen on the CRM settings screen), but they appear
in the owner list until deactivated, and a test Gerente Comercial or Diretoria receives the in-app escalation notices
of the Comercial sector.
