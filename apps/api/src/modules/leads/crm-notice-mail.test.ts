import { WINGS_CLIENT_ID, nextBusinessInstant } from '@wings/shared';
import { and, eq, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { crmNotifications, employees, leadTasks, leads } from '../../db/schema/index.js';
import type { Mail, Mailer } from '../../lib/mailer.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee } from '../../test/factories.js';
import { runCrmCycle } from './automations-scheduler.js';
import { onLeadArrivedKick, runCrmAlerts } from './crm-alerts.js';
import { testTransport } from './crm-mail.js';
import { dealUrlOf, noticeMailOf, originOf, sendPendingNoticeMails } from './crm-notice-mail.js';
import { upsertLead } from './service.js';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

const BASE_URL = 'https://staging.example.test/';

function fakeMailer(enabled = true, failWith?: Error) {
  const sent: Mail[] = [];
  const mailer: Mailer = {
    enabled,
    send: async (mail) => {
      if (failWith) throw failWith;
      sent.push(mail);
    },
  };
  return { mailer, sent };
}

const depsOf = (mailer: Mailer, enabled = true) => ({ mailer, enabled, baseUrl: BASE_URL });

let phoneSeq = 0;
const arrive = (
  ownerEmployeeId: string | null,
  extra: { campaignName?: string; pipeline?: 'expansao' | 'consultoria' } = {},
) => {
  phoneSeq += 1;
  return upsertLead(db, {
    source: 'meta_lead_ads',
    name: 'Fulana Teste da Silva',
    phone: `55119777${String(phoneSeq).padStart(5, '0')}`,
    clientId: WINGS_CLIENT_ID,
    clientMapped: true,
    pipeline: extra.pipeline ?? 'expansao',
    ownerEmployeeId,
    campaignName: extra.campaignName ?? null,
    skipResearch: true,
    event: { kind: 'lead.received.meta_lead_ads' },
  });
};

const noticesOf = (leadId: string, kind?: string) =>
  db
    .select()
    .from(crmNotifications)
    .where(
      kind
        ? and(eq(crmNotifications.leadId, leadId), eq(crmNotifications.kind, kind))
        : eq(crmNotifications.leadId, leadId),
    );

/** A Saturday 15h in São Paulo at least three days from now, and the working instant after it (Monday 9h). */
function weekendAndMonday(): { saturday: Date; monday: Date } {
  const day = new Date(Date.now() + 3 * 86_400_000);
  for (let i = 0; i < 8; i += 1) {
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      weekday: 'short',
    }).format(day);
    if (weekday === 'Sat') break;
    day.setTime(day.getTime() + 86_400_000);
  }
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(day);
  const saturday = new Date(`${ymd}T15:00:00-03:00`);
  return { saturday, monday: nextBusinessInstant(saturday) };
}

describe('noticeMailOf', () => {
  it('writes the arrival: first name, lead name, origin, deadline and the link, nothing else', () => {
    const mail = noticeMailOf({
      kind: 'new_lead',
      ownerName: 'Daniele Souza Ramos',
      leadName: 'Fulana Teste da Silva',
      origin: 'Meta Lead Ads — Form 5 perguntas',
      firstContactDueAt: new Date('2026-10-09T18:00:00Z'),
      url: dealUrlOf(BASE_URL, 'abc'),
    });
    expect(mail.subject).toBe('Novo lead para você: Fulana Teste da Silva');
    expect(mail.text).toContain('Olá, Daniele.');
    expect(mail.text).toContain('Origem: Meta Lead Ads — Form 5 perguntas');
    expect(mail.text).toMatch(/Primeiro contato até 09\/10,? 15:00 \(1 hora útil\)\./);
    expect(mail.text).toContain('https://staging.example.test/crm-vendas/negociacoes/abc');
    expect(mail.text).not.toMatch(/\d{4}-\d{4}|@/);
  });

  it('writes the overdue warning, and copes with a lead without name or owner name', () => {
    const mail = noticeMailOf({
      kind: 'first_contact_overdue',
      ownerName: null,
      leadName: '  ',
      origin: 'Site',
      firstContactDueAt: null,
      url: dealUrlOf('http://x', 'id'),
    });
    expect(mail.subject).toBe('Primeiro contato atrasado: sem nome');
    expect(mail.text.startsWith('Olá.\n')).toBe(true);
    expect(mail.text).toContain('passou da 1 hora útil');
    expect(mail.text).toContain('http://x/crm-vendas/negociacoes/id');
  });

  it('originOf: the platform label, then the campaign when there is one', () => {
    expect(originOf({ source: 'meta_lead_ads', campaignName: null, utmCampaign: null })).toBe(
      'Meta Lead Ads',
    );
    expect(
      originOf({ source: 'site_form', campaignName: null, utmCampaign: 'form-out26' }),
    ).toMatch(/— form-out26$/);
    expect(originOf({ source: 'tiktok_lead_ads', campaignName: 'TT 1', utmCampaign: 'x' })).toMatch(
      /— TT 1$/,
    );
  });
});

describe('sendPendingNoticeMails: the arrival e-mail', () => {
  it('goes to the owner at once, with the deal link, and is recorded sent once', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const born = await arrive(owner.id, { campaignName: 'Form 5 perguntas' });
    const [notice] = await noticesOf(born.lead.id, 'new_lead');
    expect(notice).toMatchObject({ recipientEmployeeId: owner.id, emailState: 'pending' });

    const { mailer, sent } = fakeMailer();
    const result = await sendPendingNoticeMails(db, depsOf(mailer));
    expect(result).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(owner.email);
    expect(sent[0]?.subject).toBe('Novo lead para você: Fulana Teste da Silva');
    expect(sent[0]?.text).toContain('Origem: Meta Lead Ads — Form 5 perguntas');
    expect(sent[0]?.text).toContain('(1 hora útil)');
    expect(sent[0]?.text).toContain(dealUrlOf(BASE_URL, born.lead.id));
    expect(sent[0]?.text).not.toContain('55119');
    expect(sent[0]?.html).toContain('Fulana Teste da Silva');

    const [after] = await noticesOf(born.lead.id, 'new_lead');
    expect(after?.emailState).toBe('sent');
    expect(after?.emailedAt).toBeTruthy();
    expect(after?.emailError).toBeNull();

    // A second pass finds nothing to do.
    expect(await sendPendingNoticeMails(db, depsOf(mailer))).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    expect(sent).toHaveLength(1);
  });

  it('is skipped, with the reason kept, when the switch is off, SMTP is missing, or the notice is stale', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const off = await arrive(owner.id);
    const { mailer, sent } = fakeMailer();
    expect(await sendPendingNoticeMails(db, depsOf(mailer, false))).toMatchObject({ skipped: 1 });
    expect((await noticesOf(off.lead.id, 'new_lead'))[0]).toMatchObject({
      emailState: 'skipped',
      emailError: 'disabled',
    });

    const noSmtp = await arrive(owner.id);
    const disabled = fakeMailer(false);
    expect(await sendPendingNoticeMails(db, depsOf(disabled.mailer))).toMatchObject({ skipped: 1 });
    expect((await noticesOf(noSmtp.lead.id, 'new_lead'))[0]?.emailError).toBe(
      'smtp_not_configured',
    );

    const stale = await arrive(owner.id);
    await db
      .update(crmNotifications)
      .set({ createdAt: new Date(Date.now() - 4 * 86_400_000) })
      .where(eq(crmNotifications.leadId, stale.lead.id));
    expect(await sendPendingNoticeMails(db, depsOf(mailer))).toMatchObject({ skipped: 1 });
    expect((await noticesOf(stale.lead.id, 'new_lead'))[0]?.emailError).toBe('too_old');
    expect(sent).toHaveLength(0);
  });

  it('is skipped when the lead changed hands, the deal closed, or the owner cannot receive it', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const other = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const { mailer, sent } = fakeMailer();

    const moved = await arrive(owner.id);
    await db.update(leads).set({ ownerEmployeeId: other.id }).where(eq(leads.id, moved.lead.id));
    const closed = await arrive(owner.id);
    await db.update(leads).set({ won: false }).where(eq(leads.id, closed.lead.id));
    // The notice is a deactivated person's: nothing reaches a closed mailbox.
    const gone = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const orphan = await arrive(gone.id);
    await db
      .update(employees)
      .set({ status: 'inactive', deactivatedAt: new Date() })
      .where(eq(employees.id, gone.id));

    const result = await sendPendingNoticeMails(db, depsOf(mailer));
    expect(result).toEqual({ sent: 0, skipped: 3, failed: 0 });
    expect(sent).toHaveLength(0);
    expect((await noticesOf(moved.lead.id, 'new_lead'))[0]?.emailError).toBe('not_owner');
    expect((await noticesOf(closed.lead.id, 'new_lead'))[0]?.emailError).toBe('deal_closed');
    expect((await noticesOf(orphan.lead.id, 'new_lead'))[0]?.emailError).toBe('no_recipient');
  });

  it('records an SMTP failure as a code, never the address or the message', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const born = await arrive(owner.id);
    const error = Object.assign(new Error(`550 mailbox ${owner.email} unavailable`), {
      responseCode: 550,
    });
    const logged: Record<string, unknown>[] = [];
    const result = await sendPendingNoticeMails(db, {
      ...depsOf(fakeMailer(true, error).mailer),
      log: (facts) => logged.push(facts),
    });
    expect(result).toEqual({ sent: 0, skipped: 0, failed: 1 });
    const [notice] = await noticesOf(born.lead.id, 'new_lead');
    expect(notice).toMatchObject({ emailState: 'failed', emailError: 'Error:550' });
    expect(JSON.stringify(logged)).not.toContain('@');
  });

  it('a claim left behind by a crash is retried after 15 minutes; a fresh one is not touched', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const crashed = await arrive(owner.id);
    const busy = await arrive(owner.id);
    await db
      .update(crmNotifications)
      .set({ emailState: 'sending', emailedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(crmNotifications.leadId, crashed.lead.id));
    await db
      .update(crmNotifications)
      .set({ emailState: 'sending', emailedAt: new Date() })
      .where(eq(crmNotifications.leadId, busy.lead.id));
    const { mailer, sent } = fakeMailer();
    expect(await sendPendingNoticeMails(db, depsOf(mailer))).toEqual({
      sent: 1,
      skipped: 0,
      failed: 0,
    });
    expect(sent[0]?.text).toContain(crashed.lead.id);
    expect((await noticesOf(busy.lead.id, 'new_lead'))[0]?.emailState).toBe('sending');
    await db
      .update(crmNotifications)
      .set({ emailState: 'none' })
      .where(eq(crmNotifications.leadId, busy.lead.id));
  });

  it('a lead that arrives kicks one pass, so the e-mail does not wait for the cycle', async () => {
    let kicks = 0;
    onLeadArrivedKick(() => {
      kicks += 1;
    });
    try {
      const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
      await arrive(owner.id);
      expect(kicks).toBe(1);
      // A lead with nobody to own it warns the managers on the panel only: no kick, no e-mail.
      const unowned = await arrive(null, { pipeline: 'consultoria' });
      expect(kicks).toBe(1);
      expect((await noticesOf(unowned.lead.id)).every((n) => n.emailState === 'none')).toBe(true);
    } finally {
      onLeadArrivedKick(null);
    }
    await db.update(crmNotifications).set({ emailState: 'none' });
  });
});

describe('sendPendingNoticeMails: the overdue first contact', () => {
  it('is written for the owner only, waits for working hours, and is dropped once the contact is registered', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const manager = await createEmployee(db, {
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
    });
    const born = await arrive(owner.id);
    // Only this deal's first contact is late: the earlier tests' tasks are closed.
    await db
      .update(leadTasks)
      .set({ doneAt: new Date() })
      .where(ne(leadTasks.leadId, born.lead.id));
    const { saturday, monday } = weekendAndMonday();
    const written = await runCrmAlerts(db, { stageStuckDays: 0 }, saturday);
    expect(written.written).toBeGreaterThanOrEqual(2);
    // The seller is the only one told of the first step; the manager hears at the end of the day (own notice kind).
    const overdue = await noticesOf(born.lead.id, 'first_contact_overdue');
    expect(overdue.map((n) => n.recipientEmployeeId)).toEqual([owner.id]);
    expect(overdue[0]?.emailState).toBe('pending');
    const escalated = await noticesOf(born.lead.id, 'first_contact_escalated');
    expect(escalated.find((n) => n.recipientEmployeeId === manager.id)?.emailState).toBe('pending');
    // The arrival and the managers' e-mails are not the subject here.
    await db
      .update(crmNotifications)
      .set({ emailState: 'none' })
      .where(
        and(
          eq(crmNotifications.leadId, born.lead.id),
          ne(crmNotifications.kind, 'first_contact_overdue'),
        ),
      );
    await db
      .update(crmNotifications)
      .set({ createdAt: saturday })
      .where(eq(crmNotifications.leadId, born.lead.id));

    const { mailer, sent } = fakeMailer();
    // Saturday: the warning waits.
    expect(await sendPendingNoticeMails(db, depsOf(mailer), saturday)).toEqual({
      sent: 0,
      skipped: 0,
      failed: 0,
    });
    expect(
      (await noticesOf(born.lead.id, 'first_contact_overdue')).find(
        (n) => n.recipientEmployeeId === owner.id,
      )?.emailState,
    ).toBe('pending');
    // Monday 9h: sent, to the owner alone.
    expect(await sendPendingNoticeMails(db, depsOf(mailer), monday)).toEqual({
      sent: 1,
      skipped: 0,
      failed: 0,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(owner.email);
    expect(sent[0]?.subject).toBe('Primeiro contato atrasado: Fulana Teste da Silva');
    expect(sent[0]?.text).toContain('registre o contato');
    expect(sent[0]?.text).toContain(dealUrlOf(BASE_URL, born.lead.id));

    // The same condition again, after the contact was registered: nothing to say.
    await db
      .update(leadTasks)
      .set({ doneAt: monday })
      .where(and(eq(leadTasks.leadId, born.lead.id), eq(leadTasks.kind, 'first_contact')));
    await db
      .update(crmNotifications)
      .set({ emailState: 'pending' })
      .where(
        and(
          eq(crmNotifications.leadId, born.lead.id),
          eq(crmNotifications.kind, 'first_contact_overdue'),
          eq(crmNotifications.recipientEmployeeId, owner.id),
        ),
      );
    expect(await sendPendingNoticeMails(db, depsOf(mailer), monday)).toMatchObject({ skipped: 1 });
    expect(
      (await noticesOf(born.lead.id, 'first_contact_overdue')).find(
        (n) => n.recipientEmployeeId === owner.id,
      )?.emailError,
    ).toBe('contact_made');
    expect(sent).toHaveLength(1);
  });
});

describe('sendPendingNoticeMails: the manager at the end of the day', () => {
  it('has a switch of its own, goes to the manager with the seller named, and drops once the deal leaves the entry stage', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    await db
      .update(employees)
      .set({ fullName: 'Vendedora Primeira Silva' })
      .where(eq(employees.id, owner.id));
    const manager = await createEmployee(db, {
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: true,
    });
    const born = await arrive(owner.id);
    await db
      .update(leadTasks)
      .set({ doneAt: new Date() })
      .where(ne(leadTasks.leadId, born.lead.id));
    const { saturday, monday } = weekendAndMonday();
    await runCrmAlerts(db, { stageStuckDays: 0 }, saturday);
    const mine = () =>
      db
        .select()
        .from(crmNotifications)
        .where(
          and(
            eq(crmNotifications.leadId, born.lead.id),
            eq(crmNotifications.kind, 'first_contact_escalated'),
            eq(crmNotifications.recipientEmployeeId, manager.id),
          ),
        );
    expect((await mine())[0]?.emailState).toBe('pending');
    // Only the manager's row is under test: the others of this deal are set aside.
    await db
      .update(crmNotifications)
      .set({ emailState: 'none' })
      .where(
        and(
          eq(crmNotifications.leadId, born.lead.id),
          ne(crmNotifications.recipientEmployeeId, manager.id),
        ),
      );
    await db
      .update(crmNotifications)
      .set({ createdAt: saturday })
      .where(eq(crmNotifications.leadId, born.lead.id));

    // The owner's switch does not open the manager's mail: his own is off, so it is marked skipped, not kept.
    const { mailer, sent } = fakeMailer();
    expect(await sendPendingNoticeMails(db, depsOf(mailer, true), monday)).toMatchObject({
      sent: 0,
      skipped: 1,
    });
    expect((await mine())[0]).toMatchObject({ emailState: 'skipped', emailError: 'disabled' });

    // With its own switch on: to the manager, naming the seller by first name, with the link.
    await db
      .update(crmNotifications)
      .set({ emailState: 'pending', emailError: null })
      .where(eq(crmNotifications.id, (await mine())[0]!.id));
    expect(
      await sendPendingNoticeMails(db, { ...depsOf(mailer), escalationEnabled: true }, monday),
    ).toMatchObject({ sent: 1, skipped: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(manager.email);
    expect(sent[0]?.subject).toBe('Primeiro contato sem registro: Fulana Teste da Silva');
    expect(sent[0]?.text).toContain('Vendedor: Vendedora');
    expect(sent[0]?.text).not.toContain('Primeira Silva');
    expect(sent[0]?.text).toContain(dealUrlOf(BASE_URL, born.lead.id));

    // The deal left the entry stage meanwhile (someone made contact): nothing to say.
    await db.update(leads).set({ stage: 'Tentando contato' }).where(eq(leads.id, born.lead.id));
    await db
      .update(crmNotifications)
      .set({ emailState: 'pending' })
      .where(eq(crmNotifications.id, (await mine())[0]!.id));
    expect(
      await sendPendingNoticeMails(db, { ...depsOf(mailer), escalationEnabled: true }, monday),
    ).toMatchObject({ sent: 0, skipped: 1 });
    expect((await mine())[0]?.emailError).toBe('contact_made');
    expect(sent).toHaveLength(1);
  });

  it('writes the manager e-mail with the lead and origin, never a phone or an address', () => {
    const mail = noticeMailOf({
      kind: 'first_contact_escalated',
      ownerName: 'Gerente Geral',
      sellerName: 'Fernando Silva',
      leadName: 'Fulana Teste da Silva',
      origin: 'Meta Lead Ads — Form 5 perguntas',
      firstContactDueAt: null,
      url: dealUrlOf(BASE_URL, 'abc'),
    });
    expect(mail.subject).toBe('Primeiro contato sem registro: Fulana Teste da Silva');
    expect(mail.text).toContain('Olá, Gerente.');
    expect(mail.text).toContain('fim do dia útil. Vendedor: Fernando.');
    expect(mail.text).toContain('https://staging.example.test/crm-vendas/negociacoes/abc');
    expect(mail.text).not.toMatch(/\d{4}-\d{4}|@|Silva\.|Geral/);
  });
});

describe('the CRM cycle', () => {
  it('sends the pending notices after the alerts, and reports the counts', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const born = await arrive(owner.id);
    const { mailer, sent } = fakeMailer();
    const result = await runCrmCycle({
      db,
      mail: testTransport,
      stageStuckDays: 7,
      noticeMail: depsOf(mailer),
      log: () => {},
    });
    expect(result.ran).toBe(true);
    expect(result.noticeMails).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sent[0]?.to).toBe(owner.email);
    expect((await noticesOf(born.lead.id, 'new_lead'))[0]?.emailState).toBe('sent');
  });

  it('without the e-mail step configured, leaves the notices pending', async () => {
    const owner = await createEmployee(db, { role: 'vendedor_expansao', sector: 'comercial' });
    const born = await arrive(owner.id);
    const result = await runCrmCycle({
      db,
      mail: testTransport,
      stageStuckDays: 7,
      log: () => {},
    });
    expect(result.noticeMails).toBeUndefined();
    expect((await noticesOf(born.lead.id, 'new_lead'))[0]?.emailState).toBe('pending');
    await db.update(crmNotifications).set({ emailState: 'none' });
  });
});
