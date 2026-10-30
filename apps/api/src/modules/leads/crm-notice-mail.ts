import { LEAD_SOURCE_LABELS, isBusinessInstant, type LeadSource } from '@wings/shared';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { crmNotifications, employees, leadTasks, leads } from '../../db/schema/index.js';
import type { Mailer } from '../../lib/mailer.js';

/**
 * The e-mail copy of two panel notices, to the deal's owner only (Eric,
 * 09/10/2026): a new lead that is theirs, and a first contact past its
 * 1-business-hour SLA with no contact registered. The notice row is the queue:
 * `announceLeadArrival` and `runCrmAlerts` write it as `pending`, this pass
 * sends it and records `sent`, `skipped` (with the reason) or `failed` (with a
 * code). The message carries the lead's name, where it came from and the link
 * to the deal — nothing else about the person; the address goes only to the
 * SMTP call, never to a log or to the row.
 *
 * The arrival e-mail goes out at once, any hour. The overdue one waits for
 * working hours (an overdue notice written Friday night is e-mailed Monday
 * 9h), and is dropped when the contact was registered meanwhile, the deal was
 * closed, or the lead changed hands. A notice older than `MAX_AGE_MS` is never
 * e-mailed (a long outage must not end in a burst of stale messages).
 *
 * Rows are claimed `sending` under `for update skip locked`, so the cycle in
 * another replica and the kick after an arrival never send the same notice
 * twice; a claim left behind by a crash goes back to `pending` after
 * `STUCK_CLAIM_MS`.
 */

export const NOTICE_MAIL_KINDS = ['new_lead', 'first_contact_overdue'] as const;
const MAX_AGE_MS = 3 * 86_400_000;
const STUCK_CLAIM_MS = 15 * 60_000;
const BATCH = 50;

export interface NoticeMailDeps {
  mailer: Mailer;
  /** CRM_NOTICE_EMAIL_ENABLED: off, the pending notices are marked skipped, not kept for later. */
  enabled: boolean;
  /** APP_BASE_URL, for the link to the deal. */
  baseUrl: string;
  log?: (facts: Record<string, unknown>) => void;
}

export interface NoticeMailResult {
  sent: number;
  skipped: number;
  failed: number;
}

export const dealUrlOf = (baseUrl: string, leadId: string) =>
  `${baseUrl.replace(/\/+$/, '')}/crm-vendas/negociacoes/${leadId}`;

const firstNameOf = (fullName: string | null) => (fullName ?? '').trim().split(/\s+/)[0] || '';

const sourceLabelOf = (source: string) =>
  (LEAD_SOURCE_LABELS as Record<string, string>)[source as LeadSource] ?? source;

/** "Meta Lead Ads — Form 5 perguntas Out26": the platform, then the campaign when the lead carries one. */
export function originOf(lead: {
  source: string;
  campaignName: string | null;
  utmCampaign: string | null;
}): string {
  const campaign = (lead.campaignName ?? lead.utmCampaign ?? '').trim();
  return campaign ? `${sourceLabelOf(lead.source)} — ${campaign}` : sourceLabelOf(lead.source);
}

const whenOf = (date: Date) =>
  date.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export interface NoticeMailInput {
  kind: (typeof NOTICE_MAIL_KINDS)[number];
  ownerName: string | null;
  leadName: string | null;
  origin: string;
  /** The first-contact deadline, when the task exists and is still open. */
  firstContactDueAt: Date | null;
  url: string;
}

/** The subject and the text of each notice: short, Brazilian Portuguese, the lead's name and origin only. */
export function noticeMailOf(input: NoticeMailInput): { subject: string; text: string } {
  const owner = firstNameOf(input.ownerName);
  const greeting = owner ? `Olá, ${owner}.` : 'Olá.';
  const leadName = (input.leadName ?? '').trim() || 'sem nome';
  if (input.kind === 'new_lead') {
    const deadline = input.firstContactDueAt
      ? `\nPrimeiro contato até ${whenOf(input.firstContactDueAt)} (1 hora útil).`
      : '';
    return {
      subject: `Novo lead para você: ${leadName}`,
      text: `${greeting}\nEntrou um lead novo para você no Wings System.\n\nNome: ${leadName}\nOrigem: ${input.origin}${deadline}\n\nAbra a negociação: ${input.url}`,
    };
  }
  return {
    subject: `Primeiro contato atrasado: ${leadName}`,
    text: `${greeting}\nO primeiro contato com o lead ${leadName} (${input.origin}) passou da 1 hora útil e ainda não foi registrado.\n\nAbra a negociação e registre o contato: ${input.url}`,
  };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlOf = (text: string) =>
  `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(text)}</div>`;

/** A code for the row and the log: the error's name and SMTP response code, never its text (it can quote the address). */
function failureCodeOf(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const code = (error as { responseCode?: unknown; code?: unknown } | null) ?? {};
  const detail =
    typeof code.responseCode === 'number'
      ? String(code.responseCode)
      : typeof code.code === 'string'
        ? code.code
        : null;
  return detail ? `${name}:${detail}`.slice(0, 60) : name.slice(0, 60);
}

interface Claimed {
  id: string;
  kind: string;
  recipientEmployeeId: string;
  leadId: string | null;
  createdAt: Date;
}

/** Marks up to `BATCH` pending notices as `sending` and returns them; nothing when there is none. */
async function claim(db: Database, now: Date): Promise<Claimed[]> {
  return db.transaction(async (tx) => {
    // A claim a crashed process left behind goes back to the queue.
    await tx
      .update(crmNotifications)
      .set({ emailState: 'pending' })
      .where(
        and(
          eq(crmNotifications.emailState, 'sending'),
          lt(crmNotifications.emailedAt, new Date(now.getTime() - STUCK_CLAIM_MS)),
        ),
      );
    const rows = await tx.execute<Claimed & Record<string, unknown>>(sql`
      select id, kind, recipient_employee_id as "recipientEmployeeId", lead_id as "leadId", created_at as "createdAt"
        from crm_notifications
       where email_state = 'pending' and kind in ('new_lead', 'first_contact_overdue')
       order by created_at
       limit ${BATCH}
         for update skip locked`);
    const ids = rows.rows.map((row) => row.id);
    if (ids.length === 0) return [];
    // `emailed_at` holds the claim time while sending; the send overwrites it.
    await tx
      .update(crmNotifications)
      .set({ emailState: 'sending', emailedAt: now })
      .where(inArray(crmNotifications.id, ids));
    return rows.rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt) }));
  });
}

async function settle(
  db: Database,
  id: string,
  state: 'sent' | 'skipped' | 'failed' | 'pending',
  now: Date,
  error: string | null = null,
) {
  await db
    .update(crmNotifications)
    .set({
      emailState: state,
      emailedAt: state === 'sent' ? now : null,
      emailError: error,
    })
    .where(eq(crmNotifications.id, id));
}

/** One pass: sends what is pending and owed now. Safe to run from the cycle and right after an arrival. */
export async function sendPendingNoticeMails(
  db: Database,
  deps: NoticeMailDeps,
  now = new Date(),
): Promise<NoticeMailResult> {
  const result: NoticeMailResult = { sent: 0, skipped: 0, failed: 0 };
  const claimed = await claim(db, now);
  if (claimed.length === 0) return result;
  const skip = async (id: string, reason: string) => {
    await settle(db, id, 'skipped', now, reason);
    result.skipped += 1;
  };
  for (const notice of claimed) {
    if (!deps.enabled) {
      await skip(notice.id, 'disabled');
      continue;
    }
    if (!deps.mailer.enabled) {
      await skip(notice.id, 'smtp_not_configured');
      continue;
    }
    if (now.getTime() - notice.createdAt.getTime() > MAX_AGE_MS) {
      await skip(notice.id, 'too_old');
      continue;
    }
    if (!notice.leadId) {
      await skip(notice.id, 'no_lead');
      continue;
    }
    const [lead] = await db
      .select({
        id: leads.id,
        name: leads.name,
        source: leads.source,
        campaignName: leads.campaignName,
        utmCampaign: leads.utmCampaign,
        ownerEmployeeId: leads.ownerEmployeeId,
        won: leads.won,
      })
      .from(leads)
      .where(eq(leads.id, notice.leadId));
    if (!lead) {
      await skip(notice.id, 'no_lead');
      continue;
    }
    // Only the owner of the deal today: a lead reassigned since the notice is the new owner's, and their own notice says so.
    if (lead.ownerEmployeeId !== notice.recipientEmployeeId) {
      await skip(notice.id, 'not_owner');
      continue;
    }
    if (lead.won !== null) {
      await skip(notice.id, 'deal_closed');
      continue;
    }
    const task = await db.query.leadTasks.findFirst({
      where: and(
        eq(leadTasks.leadId, lead.id),
        eq(leadTasks.kind, 'first_contact'),
        isNull(leadTasks.doneAt),
      ),
      columns: { dueAt: true },
    });
    if (notice.kind === 'first_contact_overdue') {
      if (!task) {
        await skip(notice.id, 'contact_made');
        continue;
      }
      if (!isBusinessInstant(now)) {
        // Outside working hours the warning waits; the next pass inside them sends it.
        await settle(db, notice.id, 'pending', now);
        continue;
      }
    }
    const [owner] = await db
      .select({ email: employees.email, fullName: employees.fullName, status: employees.status })
      .from(employees)
      .where(eq(employees.id, notice.recipientEmployeeId));
    if (!owner || owner.status !== 'active' || !owner.email) {
      await skip(notice.id, 'no_recipient');
      continue;
    }
    const mail = noticeMailOf({
      kind: notice.kind as NoticeMailInput['kind'],
      ownerName: owner.fullName,
      leadName: lead.name,
      origin: originOf(lead),
      firstContactDueAt: task?.dueAt ?? null,
      url: dealUrlOf(deps.baseUrl, lead.id),
    });
    try {
      await deps.mailer.send({
        to: owner.email,
        subject: mail.subject,
        text: mail.text,
        html: htmlOf(mail.text),
      });
      await settle(db, notice.id, 'sent', now);
      result.sent += 1;
    } catch (error) {
      const code = failureCodeOf(error);
      await settle(db, notice.id, 'failed', now, code);
      result.failed += 1;
      deps.log?.({ job: 'crm-notice-mail', kind: notice.kind, error: code });
    }
  }
  return result;
}
