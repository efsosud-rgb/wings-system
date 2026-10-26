import { SESSION_COOKIE, type RoleKey, type WaManagedTemplates } from '@wings/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { auditLog, waTemplates } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

/**
 * CRM Vendas → WhatsApp → Modelos against a simulated Meta: write a template
 * and send it to review, list every status with Meta's reason, edit the words
 * (back to review), save only the fields, and who may. No test reaches the network.
 */

const TOKEN = 'fake-whatsapp-token';
const PHONE_ID = '1253469287856067';
const WABA = '2116475762622670';

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
let listed: Record<string, unknown>[] = [];
let refuse = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const metaFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  calls.push({ method: init?.method ?? 'GET', path: url.pathname, body });
  if (refuse)
    return json(
      { error: { code: 100, message: 'Invalid parameter', error_user_title: 'Texto' } },
      400,
    );
  if (url.pathname.endsWith(`/${WABA}/message_templates`))
    return init?.method === 'POST'
      ? json({ id: 'tpl-new', status: 'PENDING', category: 'UTILITY' })
      : json({ data: listed });
  return json({ success: true });
}) as typeof fetch;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      WHATSAPP_ACCESS_TOKEN: TOKEN,
      WHATSAPP_PHONE_NUMBER_ID: PHONE_ID,
      WHATSAPP_WABA_ID: WABA,
    }),
    db,
    whatsappFetch: metaFetch,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

beforeEach(() => {
  calls.length = 0;
  listed = [];
  refuse = false;
});

async function sessionFor(role: RoleKey) {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'diretoria' ? 'diretoria' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed');
  return { [SESSION_COOKIE]: token };
}

const draft = {
  name: 'boas_vindas_curta',
  language: 'pt_BR',
  category: 'UTILITY',
  body: 'Olá, {{1}}! Recebemos o interesse em transformar {{2}} em franquia.',
  examples: ['Mariana', 'a Padaria Pão Dourado'],
  fields: [{ role: 'lead' }, { role: 'company', fallback: 'sua empresa' }],
  footer: '',
  buttons: ['Sim, pode perguntar', 'Prefiro uma ligação'],
  callPermission: true,
};

describe('the Modelos screen', () => {
  it('writes a template and sends it to Meta’s review, with the fields kept here', async () => {
    const admin = await sessionFor('admin_master');
    const created = await app.inject({
      method: 'POST',
      url: '/whatsapp/templates/manage',
      cookies: admin,
      payload: draft,
    });
    expect(created.statusCode).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: expect.stringMatching(`/${WABA}/message_templates$`),
    });
    expect(calls[0]!.body).toEqual({
      name: 'boas_vindas_curta',
      language: 'pt_BR',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: draft.body,
          example: { body_text: [['Mariana', 'a Padaria Pão Dourado']] },
        },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Sim, pode perguntar' },
            { type: 'QUICK_REPLY', text: 'Prefiro uma ligação' },
          ],
        },
        { type: 'call_permission_request' },
      ],
    });
    const { template } = created.json<{ template: WaManagedTemplates['templates'][number] }>();
    expect(template).toMatchObject({
      status: 'PENDING',
      paramCount: 2,
      callPermission: true,
      fields: [{ role: 'lead' }, { role: 'company', fallback: 'sua empresa' }],
    });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'whatsapp_template.created'));
    expect(audit?.metadata).toEqual({
      name: 'boas_vindas_curta',
      language: 'pt_BR',
      category: 'UTILITY',
    });
    // The same name and language twice: refused before Meta.
    calls.length = 0;
    const again = await app.inject({
      method: 'POST',
      url: '/whatsapp/templates/manage',
      cookies: admin,
      payload: draft,
    });
    expect(again.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it('refuses a text whose {{n}} skip a number or lack an example', async () => {
    const admin = await sessionFor('admin_master');
    for (const payload of [
      { ...draft, name: 'pulou', body: 'Olá {{1}} e {{3}}', examples: ['a', 'b', 'c'] },
      { ...draft, name: 'sem_exemplo', examples: ['Mariana'] },
    ]) {
      const answer = await app.inject({
        method: 'POST',
        url: '/whatsapp/templates/manage',
        cookies: admin,
        payload,
      });
      expect(answer.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('lists every status with Meta’s reason, and our first templates’ fields', async () => {
    const director = await sessionFor('diretoria');
    listed = [
      {
        id: 'tpl-1',
        name: 'wings_formatacao_boas_vindas',
        language: 'pt_BR',
        status: 'APPROVED',
        category: 'UTILITY',
        rejected_reason: 'NONE',
        components: [{ type: 'BODY', text: 'Olá, {{1}}! Aqui é {{2}}. Transformar a {{3}}.' }],
      },
      {
        id: 'tpl-2',
        name: 'oferta_relampago',
        language: 'pt_BR',
        status: 'REJECTED',
        category: 'MARKETING',
        rejected_reason: 'INVALID_FORMAT',
        components: [{ type: 'BODY', text: 'Promoção {{1}}' }],
      },
    ];
    const answer = await app.inject({
      method: 'GET',
      url: '/whatsapp/templates/manage',
      cookies: director,
    });
    expect(answer.statusCode).toBe(200);
    const { templates, syncError } = answer.json<WaManagedTemplates>();
    expect(syncError).toBeNull();
    const byName = new Map(templates.map((t) => [t.name, t]));
    expect(byName.get('oferta_relampago')).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'INVALID_FORMAT',
      fields: [{ role: 'free' }],
    });
    expect(byName.get('wings_formatacao_boas_vindas')).toMatchObject({
      status: 'APPROVED',
      rejectedReason: null,
      fields: [{ role: 'lead' }, { role: 'seller' }, { role: 'company', form: 'plain' }],
    });
  });

  it('edits the words (back to review, keeping the art header) and only when Meta allows', async () => {
    const admin = await sessionFor('admin_master');
    const header = { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['h'] } };
    const [row] = await db
      .insert(waTemplates)
      .values({
        metaId: 'tpl-arte',
        name: 'retomar_arte',
        language: 'pt_BR',
        category: 'MARKETING',
        status: 'APPROVED',
        components: [
          header,
          { type: 'BODY', text: 'Oi {{1}}' },
          {
            type: 'BUTTONS',
            buttons: [{ type: 'URL', text: 'Ver o site', url: 'https://exemplo.com' }],
          },
        ],
      })
      .returning();
    const edit = {
      body: 'Oi, {{1}}! Ainda quer falar da franquia?',
      examples: ['Mariana'],
      fields: [{ role: 'lead', fallback: 'tudo bem' }],
      buttons: [],
      footer: 'Responda SAIR para não receber mais.',
    };
    const edited = await app.inject({
      method: 'PUT',
      url: `/whatsapp/templates/manage/${row!.id}`,
      cookies: admin,
      payload: edit,
    });
    expect(edited.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({ method: 'POST', path: expect.stringMatching(/\/tpl-arte$/) });
    expect(calls[0]!.body).toEqual({
      components: [
        header,
        { type: 'BODY', text: edit.body, example: { body_text: [['Mariana']] } },
        { type: 'FOOTER', text: edit.footer },
        // The form edits only quick replies: the link button stays.
        {
          type: 'BUTTONS',
          buttons: [{ type: 'URL', text: 'Ver o site', url: 'https://exemplo.com' }],
        },
      ],
    });
    expect(edited.json<{ template: { status: string } }>().template.status).toBe('PENDING');
    // Under review: Meta does not take another edit.
    calls.length = 0;
    const pending = await app.inject({
      method: 'PUT',
      url: `/whatsapp/templates/manage/${row!.id}`,
      cookies: admin,
      payload: edit,
    });
    expect(pending.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
    // Meta's refusal is said, and nothing changes here.
    await db.update(waTemplates).set({ status: 'REJECTED' }).where(eq(waTemplates.id, row!.id));
    refuse = true;
    const refused = await app.inject({
      method: 'PUT',
      url: `/whatsapp/templates/manage/${row!.id}`,
      cookies: admin,
      payload: edit,
    });
    expect(refused.statusCode).toBe(502);
    expect(refused.json<{ message: string }>().message).toMatch(/A Meta recusou/);
    const [kept] = await db.select().from(waTemplates).where(eq(waTemplates.id, row!.id));
    expect(kept?.status).toBe('REJECTED');
  });

  it('saves only the fields without asking Meta, and the count must match', async () => {
    const admin = await sessionFor('admin_master');
    const [row] = await db
      .insert(waTemplates)
      .values({
        metaId: 'tpl-f',
        name: 'lembrete_simples',
        language: 'pt_BR',
        status: 'APPROVED',
        components: [{ type: 'BODY', text: 'Oi {{1}}, até {{2}}' }],
      })
      .returning();
    const saved = await app.inject({
      method: 'PUT',
      url: `/whatsapp/templates/manage/${row!.id}/fields`,
      cookies: admin,
      payload: {
        fields: [
          { role: 'lead', fallback: 'tudo bem' },
          { role: 'company', form: 'of', fallback: 'sua empresa' },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
    const [stored] = await db.select().from(waTemplates).where(eq(waTemplates.id, row!.id));
    // The name's form stays: an art version keeps "da Malkuth".
    expect(stored?.fields).toEqual([
      { role: 'lead', fallback: 'tudo bem' },
      { role: 'company', form: 'of', fallback: 'sua empresa' },
    ]);
    const wrong = await app.inject({
      method: 'PUT',
      url: `/whatsapp/templates/manage/${row!.id}/fields`,
      cookies: admin,
      payload: { fields: [{ role: 'lead' }] },
    });
    expect(wrong.statusCode).toBe(422);
  });

  it('drops a template Meta no longer lists, so its name can be used again', async () => {
    const admin = await sessionFor('admin_master');
    await db.insert(waTemplates).values({
      metaId: 'tpl-gone',
      name: 'apagado_na_meta',
      language: 'pt_BR',
      status: 'APPROVED',
      components: [{ type: 'BODY', text: 'Oi' }],
    });
    listed = [];
    const answer = await app.inject({
      method: 'GET',
      url: '/whatsapp/templates/manage',
      cookies: admin,
    });
    expect(answer.json<WaManagedTemplates>().templates.map((t) => t.name)).not.toContain(
      'apagado_na_meta',
    );
  });

  it('is for Admin Master and Diretoria only', async () => {
    for (const role of [
      'vendedor_formatacao',
      'vendedor_expansao',
      'gerente_comercial',
      'marketing',
    ] as const) {
      const cookies = await sessionFor(role);
      const answer = await app.inject({
        method: 'GET',
        url: '/whatsapp/templates/manage',
        cookies,
      });
      expect(answer.statusCode, role).toBe(403);
      const create = await app.inject({
        method: 'POST',
        url: '/whatsapp/templates/manage',
        cookies,
        payload: { ...draft, name: `de_${role}` },
      });
      expect(create.statusCode, role).toBe(403);
    }
    expect(calls).toHaveLength(0);
    expect(
      (await app.inject({ method: 'GET', url: '/whatsapp/templates/manage' })).statusCode,
    ).toBe(401);
  });
});
