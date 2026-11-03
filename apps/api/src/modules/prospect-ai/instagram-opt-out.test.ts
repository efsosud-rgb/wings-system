import {
  DO_NOT_CONTACT_REASON,
  SESSION_COOKIE,
  type Actor,
  type InstagramProspect,
  type PastePreviewResponse,
} from '@wings/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { contactOptOuts, prospectOpportunities } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { recordContactOptOut } from '../leads/contact-block.js';
import { instagramProspectInReach, promote } from './prospects.js';

/**
 * "Não me contate" at the moment of each action, not only at the paste (revisão do PR #70, lições
 * 3 e 4): reopening, "Copiar mensagem", "Abordei" and transfer check the register by the @, and
 * the paste never lets another channel's older entry hide the Instagram one. AI off, made-up @.
 */

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;
const clock = new Date('2026-11-02T15:00:00Z');

type Session = { id: string; cookies: Record<string, string> };
let seller: Session;
let otherSeller: Session;
let gerente: Session;

async function loginAs(role: 'vendedor_formatacao' | 'gerente_comercial'): Promise<Session> {
  const employee = await createEmployee(db, { role, sector: 'comercial' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

const call = (who: Session, method: InjectOptions['method'], url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/prospect-ai/instagram${url}`,
    cookies: who.cookies,
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  });

let post = 0;
const newPost = () => `https://www.instagram.com/p/PostOptOut${String(++post).padStart(4, '0')}/`;

/** One pasted comment of this @, then the seller's prospect of it (in "Revisar": AI off). */
async function prospectOf(username: string): Promise<InstagramProspect> {
  const pasted = await call(seller, 'POST', '/pastes', {
    text: `@${username}: quero abrir uma unidade`,
    postUrl: newPost(),
  });
  expect(pasted.statusCode).toBe(200);
  return stateOf(username);
}

async function stateOf(username: string): Promise<InstagramProspect> {
  const { prospects } = (await call(seller, 'GET', '/prospects')).json<{
    prospects: InstagramProspect[];
  }>();
  return prospects.find((p) => p.username === username)!;
}

const optOut = (instagramUser: string, channels: ('all' | 'instagram' | 'whatsapp')[]) =>
  recordContactOptOut(db, {
    instagramUser,
    channels,
    origin: 'crm',
    reason: 'teste',
    createdBy: null,
  });

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    db,
    now: () => clock,
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      PROSPECT_AI_INSTAGRAM_PASTE_ENABLED: 'true',
    }),
  });
  seller = await loginAs('vendedor_formatacao');
  otherSeller = await loginAs('vendedor_formatacao');
  gerente = await loginAs('gerente_comercial');
});

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

describe('"não me contate" at the moment of the action', () => {
  it('the manager cannot reopen a prospect closed by "Não contatar"', async () => {
    const p = await prospectOf('usuario.optout1');
    await call(seller, 'POST', `/prospects/${p.id}/do-not-contact`, {});
    const reopened = await call(gerente, 'POST', `/prospects/${p.id}/promote`);
    expect([reopened.statusCode, reopened.json().error]).toEqual([409, 'contact_blocked']);
    expect((await stateOf('usuario.optout1')).state).toBe('rejeitada');
    expect((await call(seller, 'GET', `/prospects/${p.id}/message`)).statusCode).toBe(409);
  });

  it('closed by "Não contatar", it stays closed even after the register is revoked', async () => {
    const p = await prospectOf('usuario.optout7');
    await call(seller, 'POST', `/prospects/${p.id}/do-not-contact`, {});
    // Only the prospect's own reason holds now: the register no longer blocks the @.
    await db
      .update(contactOptOuts)
      .set({ revokedAt: clock, revokedReason: 'teste' })
      .where(
        and(
          eq(contactOptOuts.keyKind, 'instagram_user'),
          eq(contactOptOuts.keyValue, 'usuario.optout7'),
        ),
      );
    const reopened = await call(gerente, 'POST', `/prospects/${p.id}/promote`);
    expect([reopened.statusCode, reopened.json().error]).toEqual([409, 'contact_blocked']);
    expect(await stateOf('usuario.optout7')).toMatchObject({
      state: 'rejeitada',
      decisionReason: DO_NOT_CONTACT_REASON,
    });
  });

  it('a "Não contatar" written while the manager reopens a discarded prospect is not undone', async () => {
    const p = await prospectOf('usuario.optout8');
    await call(seller, 'POST', `/prospects/${p.id}/discard`, { reason: 'sem perfil' });
    const manager: Actor = {
      employeeId: gerente.id,
      role: 'gerente_comercial',
      sector: 'comercial',
      isSectorManager: false,
    };
    const read = (await instagramProspectInReach(db, manager, p.id))!;
    // Between the read and the update: closed by "Não contatar" (register since revoked).
    await db
      .update(prospectOpportunities)
      .set({ decisionReason: DO_NOT_CONTACT_REASON })
      .where(eq(prospectOpportunities.id, p.id));
    const reopened = await promote(db, manager, read, clock);
    expect(reopened).toMatchObject({ ok: false, status: 409, error: 'prospect_mudou' });
    expect(await stateOf('usuario.optout8')).toMatchObject({
      state: 'rejeitada',
      decisionReason: DO_NOT_CONTACT_REASON,
    });
  });

  it('a register written after the paste refuses the message and "Abordei", and closes the prospect', async () => {
    const p = await prospectOf('usuario.optout2');
    await optOut('usuario.optout2', ['all']);
    const message = await call(seller, 'GET', `/prospects/${p.id}/message`);
    expect([message.statusCode, message.json().error]).toEqual([409, 'contact_blocked']);
    expect(message.json().message).not.toMatch(/Wings/);
    expect(await stateOf('usuario.optout2')).toMatchObject({
      state: 'rejeitada',
      decisionReason: 'Não contatar',
    });
    const approached = await call(seller, 'POST', `/prospects/${p.id}/approached`);
    expect(approached.statusCode).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [row] = await db
      .select()
      .from(prospectOpportunities)
      .where(eq(prospectOpportunities.id, p.id));
    expect(row!.respondedAt).toBeNull();
  });

  it('"Abordei" alone checks it too, and so does a transfer', async () => {
    const a = await prospectOf('usuario.optout3');
    await optOut('usuario.optout3', ['instagram']);
    expect((await call(seller, 'POST', `/prospects/${a.id}/approached`)).statusCode).toBe(409);
    expect((await stateOf('usuario.optout3')).approachedAt).toBeNull();

    const b = await prospectOf('usuario.optout4');
    await optOut('usuario.optout4', ['instagram']);
    const moved = await call(gerente, 'POST', `/prospects/${b.id}/transfer`, {
      ownerEmployeeId: otherSeller.id,
    });
    expect(moved.statusCode).toBe(409);
    const [row] = await db
      .select()
      .from(prospectOpportunities)
      .where(eq(prospectOpportunities.id, b.id));
    expect(row!.ownerEmployeeId).toBe(seller.id);
  });

  it('another channel only (WhatsApp) leaves the Instagram approach open', async () => {
    const p = await prospectOf('usuario.optout5');
    await optOut('usuario.optout5', ['whatsapp']);
    expect((await call(seller, 'GET', `/prospects/${p.id}/message`)).statusCode).toBe(200);
    expect((await call(seller, 'POST', `/prospects/${p.id}/approached`)).statusCode).toBe(200);
  });

  it('at the paste, an older WhatsApp entry does not hide the Instagram one', async () => {
    await optOut('usuario.optout6', ['whatsapp']);
    await optOut('usuario.optout6', ['instagram']);
    const text = '@usuario.optout6: quero abrir uma unidade';
    const preview = (
      await call(seller, 'POST', '/pastes/preview', { text, postUrl: newPost() })
    ).json<PastePreviewResponse>();
    expect(preview.comments[0]!.tag).toEqual({ kind: 'nao_contatar' });
    const confirmed = await call(seller, 'POST', '/pastes', { text, postUrl: newPost() });
    expect(confirmed.json().created).toBe(0);
    expect(await stateOf('usuario.optout6')).toBeUndefined();
  });

  it('at the paste, a WhatsApp-only entry does not tag the @ "não contatar"', async () => {
    await optOut('usuario.optout7', ['whatsapp']);
    const preview = (
      await call(seller, 'POST', '/pastes/preview', {
        text: '@usuario.optout7: quero abrir uma unidade',
        postUrl: newPost(),
      })
    ).json<PastePreviewResponse>();
    expect(preview.comments[0]!.tag).toBeNull();
  });
});
