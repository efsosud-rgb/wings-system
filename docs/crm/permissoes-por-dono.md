# Who sees which lead (permissões por dono)

Eric's rule of 07/10/2026, enforced in the API (`apps/api/src/modules/leads/access.ts`), never only on the screen.

| Profile                                 | Sees                     | Changes the deal               | Changes the owner                                       | WhatsApp of the system                                |
| --------------------------------------- | ------------------------ | ------------------------------ | ------------------------------------------------------- | ----------------------------------------------------- |
| Admin Master (the Admin)                | every lead, owned or not | yes                            | **yes**                                                 | every lead                                            |
| Diretoria                               | every lead, owned or not | no (`leads.write` is not held) | no                                                      | every lead: reads, sends and calls (`leads.whatsapp`) |
| Gerente comercial (nobody holds it yet) | every lead               | yes                            | yes                                                     | every lead                                            |
| Vendedor (Expansão, Formatação)         | only the leads they own  | only those                     | no: the Dono field is read-only and the API answers 403 | only their own leads                                  |

A lead nobody owns is seen only by the profiles that see every lead.

## The one rule

`access.ts` is the only place that decides. Every route that returns a lead, or something hanging from one, goes
through it:

- `leadOwnerFilter(actor, permission)`: the employee to filter queries by, or `undefined` for who sees every lead.
- `leadInScope(db, actor, leadId, permission)`: the lead row, or `null` (answered as **404**, so a URL does not tell a
  seller that the lead exists).
- `canChangeLeadOwner(actor)`: assign **and** write, both over all leads.
- Permissions: `leads.read`, `leads.write`, `leads.whatsapp` (each has its own scope: Diretoria reads and talks on every
  lead but edits none).

The rule fails closed: any scope other than `all` is `own`, and a NULL owner never matches an employee. Never hand a
NULL owner to `can()` as the target owner: `scopeSatisfied` takes an undefined owner as "nothing to compare".

## What it covers

List, kanban (board, column, counters), summary, search, CSV export, the lead page and everything under it (notes,
tasks, activities, e-mails, files, meetings, contacts, deal data, AI summary), the task list, the notice inbox, contacts
and companies, brands and landing-page counts, CSV import (preview and run), the creation of a lead and the WhatsApp
permission. Specifics:

- **Notices** (`crm_notifications`) go to the owner of the lead and to the profiles that see every lead; the inbox shows
  a lead's notice only to its current owner (a lead that moved away takes its notices with it).
- **Tasks**: the list is the tasks of the leads the person owns; a task is handed to somebody else only by the Admin.
- **Contacts and companies** are shared records, so a seller sees the ones tied to their own leads (plus what they made
  and nothing is tied to yet). Registering a person or a company that already sits in another owner's lead answers
  **409 without data** and writes nothing.
- **New lead or CSV row** whose phone or e-mail already belongs to another owner's lead (or to nobody's) is refused
  (`mergeOnlyIfOwnedBy`); nothing of that lead is read, changed or shown. A "Dono" column naming somebody else is
  skipped for a seller.
- **Contact data** (`PATCH /leads/:id/contact`, `GET /leads/:id/contact-changes`, `docs/crm/editar-contato.md`): `leads.write` and `leads.read` in the lead's scope; a phone or e-mail that sits on a deal the seller does not see is refused with 409 and no data.
- **Owner changes** (`PATCH /leads/:id`, naming an owner at creation, the CSV owner, automation rules of the kind
  "mudar o responsável", the RD user map) all require `canChangeLeadOwner`.
- **Drive**: the deals' folders (`Comercial / Negociações / <deal>`) answer only to who sees every lead; for a seller the
  Drive lists, searches, opens and writes nothing there, and the folder name (the deal's name) is not even in the tree.
  A seller opens the files of a deal they own through `GET /leads/:id/files/:fileId/link`, after the lead was checked.

## Known, accepted

- A stage-move automation of the kind "mudar o responsável" runs when a seller moves their lead into that stage: the
  Admin set the rule up, so the seller does not choose the owner.
- A Drive file attached to a lead but kept outside the Negociações folders is as visible as any file of that folder.
- The sellers' list of colleagues (`/crm/sellers`) is names only.

## Tests

`apps/api/src/modules/leads/owner-scope.test.ts`: two sellers, an Admin and a Diretoria user, a lead of each seller and
one with no owner, each with a note, task, meeting, contact, company, notice and file. Every route that names a lead (or
a child of one) is called by a seller on the leads out of reach and must answer 404.
