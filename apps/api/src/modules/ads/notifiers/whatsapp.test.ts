import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../db/client.js';
import { adAccounts, employees } from '../../../db/schema/index.js';
import { ZapiClient, normalizeBrazilianPhone } from '../../../lib/zapi.js';
import { createTestDatabase, type TestDatabase } from '../../../test/db.js';
import { createEmployee } from '../../../test/factories.js';
import type { ApprovalNotification, ApprovalNotifier } from '../approvals.js';
import { WhatsAppApprovalNotifier } from './whatsapp.js';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

interface SentMessage {
  url: string;
  phone: string;
  message: string;
}

/** Captures what would have gone to Z-API. The suite cannot reach the network. */
function recordingClient(options: { fail?: boolean } = {}) {
  const sent: SentMessage[] = [];
  const client = new ZapiClient({
    instanceId: 'INSTANCE',
    instanceToken: 'TOKEN',
    clientToken: 'CLIENT',
    fetchImpl: ((url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { phone: string; message: string };
      sent.push({ url: String(url), phone: body.phone, message: body.message });
      if (options.fail) {
        return Promise.resolve(new Response('{"error":"instance disconnected"}', { status: 400 }));
      }
      return Promise.resolve(new Response('{"messageId":"MSG-1"}', { status: 200 }));
    }) as typeof fetch,
  });
  return { client, sent };
}

async function account(): Promise<string> {
  const [row] = await db
    .insert(adAccounts)
    .values({
      platform: 'meta',
      externalId: `act_${randomBytes(4).toString('hex')}`,
      name: 'Wings Matriz',
    })
    .returning({ id: adAccounts.id });
  if (!row) throw new Error('failed');
  return row.id;
}

function notification(
  adAccountId: string,
  kind: ApprovalNotification['kind'],
  status: ApprovalNotification['status'] = 'pending',
): ApprovalNotification {
  return {
    approvalId: '11111111-2222-3333-4444-555555555555',
    adAccountId,
    amountCents: 37_500, // R$375,00
    trigger: 'policy_always',
    kind,
    status,
  };
}

describe('phone normalisation', () => {
  it('adds the country code to Brazilian mobile and landline numbers', () => {
    expect(normalizeBrazilianPhone('21999236677')).toBe('5521999236677');
    expect(normalizeBrazilianPhone('(21) 99049-1634')).toBe('5521990491634');
    expect(normalizeBrazilianPhone('2133334444')).toBe('552133334444');
  });

  it('keeps a number that already carries it', () => {
    expect(normalizeBrazilianPhone('+55 21 98768-1976')).toBe('5521987681976');
  });

  it('rejects placeholders and nonsense, so they are never dialled', () => {
    // The bootstrap employee record uses this placeholder.
    expect(normalizeBrazilianPhone('00000000000')).toBeNull();
    expect(normalizeBrazilianPhone('')).toBeNull();
    expect(normalizeBrazilianPhone(null)).toBeNull();
    expect(normalizeBrazilianPhone('123')).toBeNull();
  });
});

describe('who gets told', () => {
  it('sends a new request to Admin Master', async () => {
    const id = await account();
    const admin = await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const { client, sent } = recordingClient();

    await new WhatsAppApprovalNotifier({
      db,
      client,
      appBaseUrl: 'https://staging.wingssystem.online',
    }).send(notification(id, 'requested'));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.phone).toBe('5511999998888'); // factory default phone
    expect(admin.id).toBeTruthy();
  });

  it('sends a new request and its decision to Diretoria too, employees or not', async () => {
    // 28/09: requests reached only the company number; the directors' numbers
    // were configured but only ever used for the 4-hour escalation.
    const id = await account();
    await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    for (const kind of ['requested', 'decided'] as const) {
      const { client, sent } = recordingClient();
      await new WhatsAppApprovalNotifier({
        db,
        client,
        appBaseUrl: 'https://staging.wingssystem.online',
        extraDiretoriaPhones: ['+55 21 99049-1634', '+55 21 98768-1976'],
      }).send(notification(id, kind, kind === 'decided' ? 'approved' : 'pending'));

      const phones = sent.map((message) => message.phone);
      expect(phones).toContain('5511999998888'); // Admin Master, the factory's default phone
      expect(phones).toContain('5521990491634');
      expect(phones).toContain('5521987681976');
    }
  });

  it('sends an escalation to both Diretoria numbers, employees or not', async () => {
    const id = await account();
    await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const { client, sent } = recordingClient();

    await new WhatsAppApprovalNotifier({
      db,
      client,
      appBaseUrl: 'https://staging.wingssystem.online',
      // Thais and Umberto are not employees in the system yet.
      extraDiretoriaPhones: ['+55 21 99049-1634', '+55 21 98768-1976'],
    }).send(notification(id, 'escalated', 'escalated'));

    const phones = sent.map((message) => message.phone);
    expect(phones).toContain('5521990491634');
    expect(phones).toContain('5521987681976');
  });

  it('never sends the same number twice', async () => {
    const id = await account();
    await createEmployee(db, { role: 'diretoria', sector: 'diretoria' });
    const { client, sent } = recordingClient();

    await new WhatsAppApprovalNotifier({
      db,
      client,
      appBaseUrl: 'https://staging.wingssystem.online',
      // Same number as the factory's default, written differently.
      extraDiretoriaPhones: ['(11) 99999-8888'],
    }).send(notification(id, 'escalated', 'escalated'));

    expect(new Set(sent.map((m) => m.phone)).size).toBe(sent.length);
  });

  it('falls back to logging when no number is configured', async () => {
    const id = await account();
    const { client, sent } = recordingClient();
    const logged: ApprovalNotification[] = [];
    const fallback: ApprovalNotifier = {
      send: async (value) => {
        logged.push(value);
      },
    };

    // Nobody in Diretoria is reachable: earlier tests in this database created
    // directors, so they are deactivated here to isolate the case.
    await db
      .update(employees)
      .set({ status: 'inactive', deactivatedAt: new Date() })
      .where(eq(employees.roleId, sql`(select id from roles where key = 'diretoria')`));

    await new WhatsAppApprovalNotifier({
      db,
      client,
      appBaseUrl: 'https://staging.wingssystem.online',
      fallback,
    }).send(notification(id, 'escalated', 'escalated'));

    expect(sent).toHaveLength(0);
    expect(logged).toHaveLength(1);
  });
});

describe('the message', () => {
  it('states the amount, the reason and that nothing has been executed', async () => {
    const id = await account();
    await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const { client, sent } = recordingClient();

    await new WhatsAppApprovalNotifier({
      db,
      client,
      appBaseUrl: 'https://staging.wingssystem.online',
    }).send(notification(id, 'requested'));

    const message = sent[0]?.message ?? '';
    expect(message).toContain('375,00');
    expect(message).toContain('META — Wings Matriz');
    expect(message).toContain('toda alteração de orçamento exige aprovação');
    expect(message).toContain('Nada será executado sem sua decisão.');
    // The decision happens in the system, never by replying to WhatsApp.
    expect(message).toContain('responder esta mensagem não aprova');
    expect(message).toContain('https://staging.wingssystem.online/trafego-pago/aprovacoes/');
  });

  it('says plainly that an escalated request is still waiting', async () => {
    const id = await account();
    const { client, sent } = recordingClient();

    await new WhatsAppApprovalNotifier({
      db,
      client,
      appBaseUrl: 'https://staging.wingssystem.online',
      extraDiretoriaPhones: ['21990491634'],
    }).send(notification(id, 'escalated', 'escalated'));

    const message = sent[0]?.message ?? '';
    expect(message).toContain('4 horas');
    expect(message).toContain('aguardando decisão');
    expect(message).toContain('Nada foi executado');
  });

  it('never leaks the Z-API token into anything it reports', async () => {
    const id = await account();
    await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const { client, sent } = recordingClient();

    await new WhatsAppApprovalNotifier({
      db,
      client,
      appBaseUrl: 'https://staging.wingssystem.online',
    }).send(notification(id, 'requested'));

    // The credential lives in the URL (Z-API's design), so it must never end
    // up in the message body itself.
    expect(sent[0]?.url).toContain('/token/');
    expect(sent[0]?.message).not.toContain('TOKEN');
    expect(sent[0]?.message).not.toContain('CLIENT');
  });
});

describe('delivery failure', () => {
  it('throws, so the gate records it and the request stays pending', async () => {
    const id = await account();
    await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const { client } = recordingClient({ fail: true });

    const notifier = new WhatsAppApprovalNotifier({
      db,
      client,
      appBaseUrl: 'https://staging.wingssystem.online',
    });

    await expect(notifier.send(notification(id, 'requested'))).rejects.toThrow(/delivery failed/i);
  });

  it('does not put the full number in the error', async () => {
    const id = await account();
    await createEmployee(db, { role: 'admin_master', sector: 'diretoria' });
    const { client } = recordingClient({ fail: true });

    const error = await new WhatsAppApprovalNotifier({
      db,
      client,
      appBaseUrl: 'https://staging.wingssystem.online',
    })
      .send(notification(id, 'requested'))
      .catch((e: unknown) => e);

    expect(String(error)).not.toContain('5511999998888');
    expect(String(error)).toContain('…8888');
  });
});
