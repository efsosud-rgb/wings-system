import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE, type RoleKey } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import {
  leadEvents,
  leadFiles,
  leadTriageQueue,
  leads,
  waConversations,
  waMessages,
  waNumbers,
  waWebhookEvents,
} from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createSecretBox } from '../../lib/secret-box.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import {
  createEmployee,
  setOfficialLive,
  TEST_CPF_KEY,
  TEST_INDEX_KEY,
} from '../../test/factories.js';
import { applyWhatsAppPayload } from './intake.js';

/**
 * What the Central's tests share (central-*.test.ts): a simulated Meta that records every send
 * and template read, the app on a throwaway database, a connected work number of the owner, and
 * the work number's webhook shapes. The shapes follow Meta's reference with made-up data: NOT
 * verified against Meta. Each test file wires `startCentral`, `stopCentral` and `resetCentral` to
 * its own hooks; nothing here reaches the network.
 */

export const KEY = randomBytes(32).toString('base64');
export const TOKEN = 'fake-official-token';
export const NUMBER_TOKEN = 'EAAG-fake-work-number-token';
export const PHONE_ID = '1253469287856067';
export const WABA = '2116475762622670';
export const WORK_ID = '4200000000000077';
export const WORK_WABA = '3100000000000077';
export const WORK_PHONE = '5521911110000';
export const PERSON = '5521988880001';
export const NOW = new Date('2026-10-07T15:00:00Z');
export const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));
export const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

export let harness: TestDatabase;
export let db: Database;
export let app: FastifyInstance;
export let clock = NOW;
let mediaDir = '';

export const sends: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
/** Each file sent up to Meta: to which number, with which token, as which type. */
export const mediaUploads: { url: string; auth: string | null; type: string | null }[] = [];
/** Each read of a WABA's templates: which WABA, with which token. */
export const templateReads: { url: string; auth: string | null }[] = [];
export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const whatsappFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const auth = new Headers(init?.headers).get('authorization');
  if (url.pathname.endsWith('/message_templates')) {
    templateReads.push({ url: url.pathname, auth });
    return json({
      data: [
        {
          id: '9100000000000001',
          name: 'retomar_conversa_numero',
          language: 'pt_BR',
          status: 'APPROVED',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: 'Olá! Ainda quer conversar sobre a franquia?' }],
        },
      ],
    });
  }
  if (url.pathname.endsWith('/media')) {
    mediaUploads.push({
      url: url.pathname,
      auth,
      type: (init?.body as FormData).get('type') as string,
    });
    return json({ id: `MEDIA${mediaUploads.length}` });
  }
  if (url.pathname.endsWith('/messages')) {
    sends.push({ url: url.pathname, auth, body: JSON.parse(String(init?.body)) });
    return json({ contacts: [{ wa_id: PERSON }], messages: [{ id: `wamid.SENT${sends.length}` }] });
  }
  return json({ error: { code: 100, message: 'unknown path' } }, 400);
}) as typeof fetch;

export async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'diretoria' || role === 'admin_master' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

export let owner: Awaited<ReturnType<typeof sessionFor>>;
export let otherSeller: Awaited<ReturnType<typeof sessionFor>>;
export let admin: Awaited<ReturnType<typeof sessionFor>>;
export let numberId = '';

export async function deal(phone: string, ownerId: string | null, name = 'Negociação fictícia') {
  const [row] = await db
    .insert(leads)
    .values({ source: 'manual', name, phone, ownerEmployeeId: ownerId, pipeline: 'expansao' })
    .returning({ id: leads.id });
  return row!.id;
}

/** One change for the work number, as Meta's reference shapes it (made-up data). */
export const workChange = (field: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WORK_WABA,
      changes: [
        {
          field,
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: WORK_PHONE, phone_number_id: WORK_ID },
            ...value,
          },
        },
      ],
    },
  ],
});

export const fixtures = {
  message: (id: string, at: Date, text = 'Oi, vi o anúncio') =>
    workChange('messages', {
      contacts: [{ wa_id: PERSON, profile: { name: 'Pessoa Fictícia' } }],
      messages: [{ from: PERSON, id, timestamp: unix(at), type: 'text', text: { body: text } }],
    }),
  echo: (id: string, at: Date) =>
    workChange('smb_message_echoes', {
      message_echoes: [
        {
          from: WORK_PHONE,
          to: PERSON,
          id,
          timestamp: unix(at),
          type: 'text',
          text: { body: 'Resposta pelo celular' },
        },
      ],
    }),
  history: (at: Date) =>
    workChange('history', {
      history: [
        {
          metadata: { phase: 1, chunk_order: 1, progress: 55 },
          threads: [
            {
              id: PERSON,
              messages: [
                {
                  from: PERSON,
                  id: 'wamid.HIST1',
                  timestamp: unix(at),
                  type: 'text',
                  text: { body: 'Mensagem antiga' },
                  history_context: { status: 'READ' },
                },
                {
                  from: WORK_PHONE,
                  to: PERSON,
                  id: 'wamid.HIST2',
                  timestamp: unix(new Date(at.getTime() + 60_000)),
                  type: 'text',
                  text: { body: 'Resposta antiga' },
                  history_context: { status: 'DELIVERED' },
                },
              ],
            },
          ],
        },
      ],
    }),
  contacts: (removed = false) =>
    workChange('smb_app_state_sync', {
      state_sync: [
        {
          type: 'contact',
          contact: { full_name: 'Nome no Celular', first_name: 'Nome', phone_number: PERSON },
          action: removed ? 'remove' : 'add',
          metadata: { timestamp: unix(NOW) },
        },
      ],
    }),
};

export const apply = (body: unknown) =>
  applyWhatsAppPayload(
    { db, phoneNumberId: PHONE_ID, wabaId: WABA, log: () => {}, now: () => clock },
    body,
  );

export const chatOfPerson = async () =>
  (await db.select().from(waConversations).where(eq(waConversations.numberId, numberId)))[0];

export const list = (cookies: Record<string, string>, query = '') =>
  app.inject({ method: 'GET', url: `/whatsapp/conversations${query}`, cookies });

/** Moves the simulated time the app and the queue read. */
export const setClock = (at: Date) => {
  clock = at;
};

/** The app on a throwaway database, and the three people the tests act as. */
export async function startCentral() {
  harness = await createTestDatabase();
  db = harness.db;
  mediaDir = await mkdtemp(join(tmpdir(), 'wings-central-'));
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      MEDIA_DIR: mediaDir,
      WHATSAPP_APP_SECRET: 'whatsapp-app-secret-for-tests',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'whatsapp-verify-token-long-enough',
      WHATSAPP_ACCESS_TOKEN: TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
      WHATSAPP_WABA_ID: WABA,
      INTEGRATIONS_ENCRYPTION_KEY: KEY,
    }),
    db,
    now: () => clock,
    whatsappFetch,
  });
  owner = await sessionFor('vendedor_expansao');
  otherSeller = await sessionFor('vendedor_formatacao');
  admin = await sessionFor('admin_master');
}

export async function stopCentral() {
  await app?.close();
  await harness?.drop();
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
}

/** Each test starts with no deal, conversation or event, and the work number connected again. */
export async function resetCentral() {
  clock = NOW;
  sends.length = 0;
  mediaUploads.length = 0;
  templateReads.length = 0;
  await setOfficialLive(db, true);
  await db.delete(leadTriageQueue);
  await db.delete(waMessages);
  await db.delete(waConversations);
  await db.delete(waNumbers);
  await db.delete(leadEvents);
  // A recorded voice note kept in a deal's files (central-voice.test.ts).
  await db.delete(leadFiles);
  await db.delete(leads);
  await db.delete(waWebhookEvents);
  const [row] = await db
    .insert(waNumbers)
    .values({
      phone: WORK_PHONE,
      label: 'Comercial Expansão',
      sector: 'comercial',
      ownerEmployeeId: owner.id,
      phoneNumberId: WORK_ID,
      wabaId: WORK_WABA,
      tokenEnc: createSecretBox(KEY).seal(NUMBER_TOKEN),
      status: 'connected',
      connectedAt: ago(60 * 24),
      webhooksSubscribed: true,
    })
    .returning({ id: waNumbers.id });
  numberId = row!.id;
}
