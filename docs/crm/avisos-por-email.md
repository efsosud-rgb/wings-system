# Aviso por e-mail ao dono da negociação

O pop-up e o sino do mesmo aviso: `docs/crm/aviso-lead-novo.md`.

Ordem do Eric, 09/10/2026 17:04. Dois avisos do painel (`crm_notifications`,
`docs/crm/automacoes.md`) também saem por e-mail, **só para o dono da negociação** (e, desde
13/10/2026, um terceiro para o gerente, com chave própria — ver "Ligar"):

| aviso                                                                                                                   | assunto                                 | quando sai                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `new_lead` (lead novo com dono pelo rodízio)                                                                            | `Novo lead para você: <nome>`           | na hora, qualquer horário: a chegada dispara uma passada do envio (`onLeadArrivedKick`), sem esperar o ciclo               |
| `first_contact_overdue` (1ª hora útil vencida sem contato)                                                              | `Primeiro contato atrasado: <nome>`     | no ciclo do CRM, **só em horário útil** (seg–sex 9h–18h, Brasília, sem feriados): escrito sexta à noite, vai segunda às 9h |
| `first_contact_escalated` (1º contato ainda sem registro no fim do dia útil, para o **gerente do setor e a Diretoria**) | `Primeiro contato sem registro: <nome>` | no ciclo, só em horário útil; **desligado** até `CRM_ESCALATION_EMAIL_ENABLED=true`                                        |

O texto é curto, em português, e traz **só o nome do lead, a origem (plataforma — campanha,
quando houver), o prazo do 1º contato e o link da ficha** (`APP_BASE_URL/crm-vendas/negociacoes/<id>`).
Nenhum telefone, e-mail ou outro dado da pessoa. O endereço do dono vai só para o SMTP; a linha do
aviso e o log guardam estado e código, nunca o endereço nem o texto do erro.

## Como funciona (`crm-notice-mail.ts`)

- A linha do aviso é a fila: `email_state` = `none` (sem e-mail: os outros tipos de aviso),
  `pending`, `sending`, `sent`, `skipped` (motivo em `email_error`) ou `failed` (código, ex.
  `Error:550`). `announceLeadArrival` e `runCrmAlerts` gravam `pending` na linha do dono e, no passo do gerente
  (`first_contact_escalated`), nas linhas dos gerentes e da Diretoria.
- `sendPendingNoticeMails` roda no fim de cada ciclo (`runCrmCycle`, a cada `CRM_AUTOMATIONS_CRON`
  minutos) e logo após uma chegada. Reivindica até 50 linhas com `for update skip locked`
  (`sending`); uma reivindicação esquecida por queda volta a `pending` depois de 15 min.
- Antes de enviar confere, e pula com o motivo: `disabled` (variável desligada),
  `smtp_not_configured`, `too_old` (aviso com mais de 3 dias — uma parada longa não vira rajada — ou, no `new_lead`, com mais de 6 horas),
  `no_lead`, `not_owner` (o lead mudou de dono: o aviso do novo dono é o que vale),
  `deal_closed` (ganho/perdido), `contact_made` (atraso cujo contato já foi registrado),
  `no_recipient` (dono inativo ou sem e-mail). Atraso fora do horário útil fica `pending`.
- Remetente: o SMTP da empresa (`SMTP_HOST/PORT/USER/PASSWORD/FROM`, o mesmo das senhas,
  `lib/mailer.ts`). Sem SMTP nada sai e a linha fica `skipped`.

## Ligar

`CRM_NOTICE_EMAIL_ENABLED=true` no ambiente da API (desligado quando ausente). O e-mail do gerente
(`first_contact_escalated`) tem **variável própria**, `CRM_ESCALATION_EMAIL_ENABLED=true`, também
desligada quando ausente: ligar a primeira não liga a segunda, porque ela alcança gente que o
e-mail do dono não alcança. Os dois e-mails de atraso só saem em horário útil, e são pulados
(`contact_made`) quando a tarefa foi concluída ou a negociação saiu da etapa de entrada. Com a variável
desligada os avisos continuam no painel e a cópia por e-mail é marcada `skipped: disabled` — não
fica guardada para sair depois. Antes de ligar num ambiente com gente de verdade: confirmar com o
Eric (ordem de 09/10: nenhum e-mail real à equipe sem ele saber).

## Migração

`0085_crm_notification_email`: `crm_notifications.email_state` (`none`), `emailed_at`,
`email_error` e o índice parcial dos `pending`. `wings_ro` continua sem acesso à tabela (tem texto).

## Testes

`apps/api/src/modules/leads/crm-notice-mail.test.ts` (mailer falso: dono recebe uma vez, link,
motivos de pulo, falha do SMTP vira código, reivindicação esquecida, disparo na chegada, atraso
espera o horário útil e some com o contato registrado, ciclo) e `packages/shared/src/crm.test.ts`
(`isBusinessInstant`).
