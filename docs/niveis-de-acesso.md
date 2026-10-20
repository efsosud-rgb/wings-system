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
| CRM → Empresas, Landing pages           | yes          | yes               | —     | yes               | —         | —                             | —                 | —                   |
| CRM → Configurações                     | yes          | —                 | —     | yes               | —         | —                             | —                 | —                   |
| CRM → Sofia (every conversation)        | yes          | yes               | —     | yes               | —         | —                             | —                 | —                   |
| Dashboard → Vendas                      | all          | all               | —     | all               | —         | —                             | own, in the CRM   | own, in the CRM     |
| Dashboard → Marketing                   | yes          | yes               | —     | —                 | yes       | —                             | —                 | —                   |
| Dashboard → Leads das Campanhas         | all          | all               | —     | all               | —         | —                             | —                 | own, in the CRM     |
| Marketing (traffic agent, media studio) | yes          | yes               | —     | —                 | yes       | —                             | —                 | —                   |
| Formatação → Clientes                   | yes          | yes               | —     | —                 | yes       | Jurídico only                 | —                 | —                   |
| Gestão → Projetos                       | all          | all               | read  | dept              | dept      | dept (P&P all; Log., TI read) | dept, in the CRM  | dept, in the CRM    |
| Drive                                   | all          | all               | dept  | dept              | dept      | dept                          | —                 | —                   |
| Produtividade → Agenda                  | yes          | yes               | yes   | yes               | yes       | yes                           | read only         | read only           |
| Produtividade → Reuniões                | all          | all               | —     | all               | —         | —                             | own               | own                 |
| Administração → Usuários e acessos      | all          | all (levels only) | all   | sector            | —         | —                             | —                 | —                   |
| Administração → Drive: modelo de pastas | yes          | yes               | —     | —                 | —         | —                             | —                 | —                   |
| Administração → Roadmap, Integrações    | yes          | —                 | —     | —                 | —         | —                             | —                 | —                   |
| Configurações, APIs e credenciais       | yes          | —                 | —     | —                 | —         | —                             | —                 | —                   |
| Laboratório, SaaS                       | yes          | —                 | —     | —                 | —         | —                             | —                 | —                   |
| "Em breve" placeholders                 | yes          | yes               | —     | —                 | —         | —                             | —                 | —                   |

Also by level, outside the menu: the sector-manager flag (`is_sector_manager`) adds the register of the person's
own sector; Diretoria never sees TI sector records; Diretoria does not edit deals or employee data (only levels);
nobody but the Admin Master sets the ad budget caps, connects Kairogen or connects a seller's WhatsApp number.

Decisions of 13/10, asked and answered: sellers keep the WhatsApp inbox, Projects, the Sales dashboard and (Vendedor
Formatação) Leads das Campanhas, and lose the Sofia screen and the employee register; the Gerente Comercial keeps
what the repository gave it and gains the Sofia screen; Diretoria stays as it was; Configurações and APIs belong to
the Admin Master alone (Formatação — TI lost them); Marketing and Formatação lost the register of their sector.

### The sellers' menu (Eric, 14/10)

"Ainda aparecem acessos demais": a seller's whole menu is **Início and CRM Vendas**. `CRM_ONLY_ROLES` in
`packages/shared/src/rbac/roles.ts` names the two levels, and `canSeeSubmodule` hides from them every entry
outside those two groups, whatever the level holds; a typed address shows "Sem acesso". Inside the CRM they see
Negociações, WhatsApp, Contatos, Tarefas, Avisos, **Painel de Vendas** (`/crm-vendas/painel-de-vendas`),
**Projetos** (`/crm-vendas/projetos`) and, Vendedor Formatação only, **Leads das Campanhas**
(`/crm-vendas/leads-campanhas`): the same pages as Dashboard and Gestão, at a CRM address that only these two levels
see (`NavSubmodule.levels`). Every other level keeps them where they were.

**Agenda and Reuniões in Produtividade (Eric, 19/10).** The two entries say `sellers: true`, the one exception to
the rule above, so a seller's menu also has Produtividade with them. Both are read-only for the seller: the Agenda
shows their own calendar and Wings Company's in full (every event, with the lead's name, as Google shares it), and
they lack `calendar.write`, so the API refuses `POST`, `PATCH` and `DELETE /agenda/events` with 403 and the page
hides Criar, Editar and Excluir. They schedule, reschedule and cancel only from the lead's page (`leads.write`).
Reuniões (`GET /meetings`) lists the meetings of the deals they own; Admin Master, Diretoria and the Gerente
comercial see every one. The old `/crm-vendas/agenda` redirects to `/produtividade/agenda`.

- **Empresas** and **Landing pages** need `companies.read` and `landing_pages.read` (Admin Master, Diretoria,
  Gerente Comercial). In the deal and the contact the company is a name, linked to its record only for who has
  Empresas; a seller still types it in their own deal or contact (`PATCH /leads/:id/deal`, `/crm/contacts`).
- **Drive:** no `drive.*` for the sellers. The files of their own deals still open, upload and go away through the
  deal's routes (`dealRouteAccessOf` in `apps/api/src/modules/drive/access.ts`, after `leadInScope`).
  `DRIVE_ROLE_DEPARTMENTS` still names Comercial for them: that is what lets them update stage 07 of a project.
- **Own only, on screen too:** Negociações hides "Todas", "Sem dono" and the owner filter from whoever does not
  read every lead; the team list (`GET /crm/sellers`) needs `leads.assign`; Leads das Campanhas follows the deal's
  owner now, not the copy the last sync wrote; a seller's new deal does not take in a person who is on another
  seller's deal (409, as for a phone already in one).
- **WhatsApp "em breve":** until the official number is live, a seller sees "O WhatsApp do sistema começa a
  funcionar depois da troca do número. Até lá, use o WhatsApp do celular.", "Nova conversa" is off and the menu
  entry says "em breve". The key is one row, `whatsapp_settings.official_number_live` (migration 0090), switched by
  an Admin Master on the WhatsApp screen (`PUT /whatsapp/official-number`, audited): no deploy on the day. The
  other levels do not change. Since 19/10 the API holds it too: while the key is off, a seller's send (text,
  template, call request) and outgoing call answer 403 `whatsapp_soon`, and the deal's chat, the call panel and
  the deal's WhatsApp action say "em breve". Reading the conversation stays.

Not in the system: **Notion** (no module or link exists). **Meet** for a seller is the Google connection in
"Minha conta" and the meetings inside the deal; Produtividade → Agenda and Reuniões only read (above).

## Test accounts (staging)

`apps/api/src/scripts/test-accounts.ts`, run inside the staging API container, makes one account per level except
Admin Master (`Teste <nível>`, e-mail `teste.<nivel>@contas-teste.invalid`). It sends no invite and no e-mail: it
issues the invite link and uses it itself, with a random password, and prints `nível, e-mail, senha` on stdout,
which goes straight into a mode-600 file outside the repository. It refuses to run outside staging.

```bash
docker exec <api-staging> node dist/scripts/test-accounts.js estado
docker exec <api-staging> node dist/scripts/test-accounts.js criar > /root/.segredos/contas-teste-staging.tsv  # umask 077
docker exec <api-staging> node dist/scripts/test-accounts.js reativar vendedor_expansao vendedor_formatacao > /root/.segredos/contas-teste-vendedores.tsv  # umask 077
docker exec <api-staging> node dist/scripts/test-accounts.js desativar   # when the check is over
```

`reativar` brings back only the levels named, with a new password, and refuses (counts only, nothing changed) while
one of them is an active rotation member, is mapped to an RD user, is named in an automation, or owns a deal or a
task: an active test seller must not receive leads.

The test sellers are not in any rotation (rotation members are chosen on the CRM settings screen), but they appear
in the owner list until deactivated, and a test Gerente Comercial or Diretoria receives the in-app escalation notices
of the Comercial sector.
