# Product

<!-- impeccable:product-schema 1 -->

<!-- Written from CLAUDE.md's existing product/architecture record, not an
interactive /impeccable init interview. Facts below are what CLAUDE.md
already states; nothing here is invented. -->

## Platform

web

## Users

Wings Company's own employees, across departments (Marketing, Jurídico,
Financeiro, Produção, Processos, Logística, TI, RH/DP, Projetos, Comercial).
Not a customer-facing product: every user is internal staff, working under a
role (Admin Master, Diretoria, RH/DP, sector manager, or a department role)
that determines which sectors and records they can see and edit. UI copy is
Brazilian Portuguese; the people using it work in Portuguese day to day.

## Product Purpose

An internal system — CRM, RH/DP (HR and payroll-adjacent operations), and
marketing automation — built one module at a time rather than as a single
launch. The first module is Cadastro de Funcionários (employee registration)
with role-based access control; later modules (Drive, media/Kairogen
generation, ad-spend cockpit, Wings Studio video editor) have shipped
incrementally on top of it.

## Positioning

Not a generic off-the-shelf CRM/HR/marketing SaaS: it is built specifically
around Wings Company's own approval chains, sector boundaries, and safety
rules (who may see TI's employee records, who may approve an ad-spend
increase, who may generate paid media). Authorization and every
money-moving or platform-write action are enforced centrally, server-side,
by rules this company defined for itself — not configured after the fact
in a third-party tool.

## Operating Context

Same origin in every environment (Traefik routes `/api/*` to the API,
everything else to the web app), deployed from GitHub through Coolify to
staging (`develop` branch) and production (`main` branch, still mid-migration
off a manual container). Server-side sessions, not JWT. Each environment has
its own PostgreSQL database. Code, comments and docs are English; the product
itself speaks Portuguese to its users.

## Capabilities and Constraints

- Role-based access control with sector scoping: a sector manager may only
  create/edit within their own sector and can never assign Admin Master or
  Diretoria; Diretoria is fully blocked from TI's employee records.
- CPF is encrypted at the application layer (AES-256-GCM + HMAC blind index),
  masked by default, every reveal audited.
- Personal data (CPF, full name, email, phone) must never reach logs or
  error messages.
- The Drive (company file storage) never exposes a storage path or key to a
  client; access is decided server-side per folder, per department.
- Ad spend: no automation end to end — a person approves and executes one
  change at a time; anything the system creates on an ad platform is born
  paused. The traffic agent may only read and propose, never act.
- Kairogen (paid media generation): no credit is spent without a person's
  click on a price; the editing agent estimates and proposes, never
  generates on its own.
- Wings Studio (manual video editor): renders in the browser when possible;
  when it can't, a job goes to `apps/worker`, which renders with FFmpeg
  server-side and is never retried automatically.
- Time clock entries are append-only; corrections are new rows with a reason
  and an approver. Portaria MTP 671/2021 compliance is not yet legally
  confirmed — the model is kept compliance-ready until Jurídico signs off.

## Brand Commitments

"Wings Company" / "Wings System" as the product's own name. No documented
visual identity system (palette, typography, logo usage) exists yet in the
product record available to this file — that belongs in DESIGN.md, written
separately, not assumed here.

## Evidence on Hand

Reference documentation lives in `docs/` (`auth.md`, `drive.md`,
`timeclock.md`, `ads/*`, `integracoes/*`, `studio/*`, `deploy.md`) and is
the durable source for how each shipped module actually behaves. There are
no customer testimonials, case studies, or external press: this is an
internal tool with no public-facing marketing surface, and future work must
not invent any.

## Product Principles

1. The API owns every authorization decision; the frontend only hides UI, it
   never decides access.
2. Personal data is protected by construction — encrypted, masked, and never
   logged — not by convention.
3. Anything that moves money or writes to an external platform waits for one
   person's explicit click; no agent or background job executes it alone.
4. Where compliance is on the line (time clock, audit trail), records are
   append-only and every sensitive change is logged with who did it and why.
5. Ship one module at a time, safely, over shipping the whole platform at once.
