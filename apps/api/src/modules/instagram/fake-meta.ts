import {
  DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS,
  SESSION_COOKIE,
  type PrivateReplyMode,
  type RoleKey,
} from '@wings/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createHmac } from 'node:crypto';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { AgentLlm } from '../agent/llm.js';
import { saveInstagramSettings } from '../prospect-ai/settings.js';
import { processInstagramEvents } from './intake.js';

/**
 * A playground for parte 1's tests: a throwaway database, the API with the Instagram switches on,
 * a fake Graph that records every call (no network), a scripted model and a pinned clock. Every
 * id, @, phone and text is made up.
 */

export const WINGS_ACCOUNT = '17841400000000001';
export const APP_SECRET = 'segredo-falso-do-app-de-teste';
export const VERIFY_TOKEN = 'token-de-verificacao-falso-1234';
export const MESSAGING_TOKEN = 'token-falso-de-mensagens';
export const POLICY = 'https://exemplo.com/privacidade';

export type GraphCall = { url: string; body: unknown; headers: Record<string, string> };
type Scripted = { status: number; body: unknown } | 'timeout';

export interface Harness {
  db: Database;
  app: FastifyInstance;
  graphCalls: GraphCall[];
  /** The next answers of the Graph's messages endpoint, in order; then `message_id`s. */
  nextReplies: Scripted[];
  clock: { now: Date };
  close: () => Promise<void>;
}

/**
 * Buys whatever says "quero" (or asks the price), doubts "como funciona", praises the rest; the
 * confidence is the number after "conf" (`conf85`), 90 without one.
 */
export const scriptedLlm: AgentLlm = {
  async complete(request) {
    const user = request.messages.find((m) => m.role === 'user')!.content;
    const { comentarios } = JSON.parse(user) as { comentarios: { i: number; texto: string }[] };
    const itens = comentarios.map(({ i, texto }) => ({
      i,
      sinal: /quero|quanto/i.test(texto)
        ? 'quer_comprar'
        : /como funciona/i.test(texto)
          ? 'duvida'
          : 'elogio',
      categoria: 'formatacao_franquias',
      intencao: 'interesse_declarado',
      confianca: Number(texto.match(/conf(\d+)/)?.[1] ?? 90),
      frase: texto.slice(0, 200),
    }));
    return {
      text: '',
      toolCalls: [{ id: 'c1', name: 'classificar_lote', arguments: JSON.stringify({ itens }) }],
      usage: { inputTokens: 300, outputTokens: 60, costUsd: 0.0006 },
      finishReason: 'tool_calls',
    };
  },
};

export async function createHarness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const harness: TestDatabase = await createTestDatabase();
  const graphCalls: GraphCall[] = [];
  const nextReplies: Scripted[] = [];
  const clock = { now: new Date('2026-11-01T15:00:00Z') };
  const fakeGraph = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    graphCalls.push({
      url: href,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (href.includes('fields=permalink'))
      return new Response(JSON.stringify({ permalink: 'https://www.instagram.com/p/PostWings/' }));
    const next = nextReplies.shift();
    if (next === 'timeout') throw new DOMException('timeout', 'TimeoutError');
    if (next) return new Response(JSON.stringify(next.body), { status: next.status });
    return new Response(
      JSON.stringify({ recipient_id: 'x', message_id: `m.${graphCalls.length}` }),
    );
  }) as typeof fetch;
  const app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: 'x'.repeat(48),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'http://localhost:5173',
      INSTAGRAM_WEBHOOK_ENABLED: 'true',
      INSTAGRAM_AUTO_REPLY_ENABLED: 'true',
      INSTAGRAM_APP_SECRET: APP_SECRET,
      INSTAGRAM_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
      INSTAGRAM_MESSAGING_TOKEN: MESSAGING_TOKEN,
      INSTAGRAM_ACCOUNT_ID: WINGS_ACCOUNT,
      ...extraEnv,
    }),
    db: harness.db,
    instagramFetch: fakeGraph,
    now: () => clock.now,
  });
  return {
    db: harness.db,
    app,
    graphCalls,
    nextReplies,
    clock,
    close: async () => {
      await app.close();
      await harness.drop();
    },
  };
}

/** Ajustes → Instagram: the reply's mode and the policy's link (the rest at the defaults). */
export async function setReply(
  h: Harness,
  modo: PrivateReplyMode,
  linkPolitica: string | null = POLICY,
): Promise<void> {
  const admin = await createEmployee(h.db, { role: 'admin_master' });
  await saveInstagramSettings(
    h.db,
    {
      ...DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS,
      privateReply: { ...DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS.privateReply, modo },
      messages: { ...DEFAULT_INSTAGRAM_PROSPECTING_SETTINGS.messages, linkPolitica },
    },
    admin.id,
    h.clock.now,
  );
}

/** The 60-second loop, once, with the scripted model (on or off). */
export const runIntake = (h: Harness, ai = false) =>
  processInstagramEvents({
    db: h.db,
    fetch: h.app.wings.instagramFetch!,
    accountId: WINGS_ACCOUNT,
    messagingToken: MESSAGING_TOKEN,
    replyConfig: { token: MESSAGING_TOKEN, accountId: WINGS_ACCOUNT },
    llm: scriptedLlm,
    aiEnabled: ai,
    dailyUsd: 1,
    now: () => h.clock.now,
    log: () => undefined,
  });

export const sign = (raw: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

/** POSTs a body to the webhook, signed like Meta does over the exact bytes. */
export function deliver(h: Harness, body: unknown, signature?: string | null) {
  const raw = JSON.stringify(body);
  return h.app.inject({
    method: 'POST',
    url: '/integrations/instagram/webhook',
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'x-hub-signature-256': signature ?? sign(raw) }),
    },
    payload: raw,
  });
}

let ids = 0;
export const nextId = () => String(900_000 + ++ids);

export interface CommentInput {
  id?: string;
  from?: string;
  username?: string;
  text: string;
  adId?: string;
  mediaId?: string;
  at?: Date;
}

export const commentBody = (c: CommentInput, at: Date) => ({
  object: 'instagram',
  entry: [
    {
      id: WINGS_ACCOUNT,
      time: Math.floor((c.at ?? at).getTime() / 1000),
      changes: [
        {
          field: 'comments',
          value: {
            comment_id: c.id ?? nextId(),
            text: c.text,
            from: { id: c.from ?? '5001', username: c.username ?? 'pessoa.teste' },
            media: {
              id: c.mediaId ?? '7001',
              media_product_type: c.adId ? 'AD' : 'FEED',
              ...(c.adId ? { ad_id: c.adId } : {}),
            },
          },
        },
      ],
    },
  ],
});

export const messageBody = (
  m: { from: string; text?: string; echo?: boolean; mid?: string },
  at: Date,
) => ({
  object: 'instagram',
  entry: [
    {
      id: WINGS_ACCOUNT,
      time: Math.floor(at.getTime() / 1000),
      messaging: [
        {
          sender: { id: m.echo ? WINGS_ACCOUNT : m.from },
          recipient: { id: m.echo ? m.from : WINGS_ACCOUNT },
          timestamp: at.getTime(),
          message: { mid: m.mid ?? `mid.${nextId()}`, text: m.text, is_echo: m.echo ?? false },
        },
      ],
    },
  ],
});

/** A comment through the webhook and the loop; returns the comment's id. */
export async function comment(h: Harness, c: CommentInput, ai = false): Promise<string> {
  const id = c.id ?? nextId();
  const response = await deliver(h, commentBody({ ...c, id }, h.clock.now));
  if (response.statusCode !== 200) throw new Error(`webhook ${response.statusCode}`);
  await runIntake(h, ai);
  return id;
}

export async function direct(
  h: Harness,
  m: { from: string; text?: string; echo?: boolean; mid?: string },
) {
  const response = await deliver(h, messageBody(m, h.clock.now));
  if (response.statusCode !== 200) throw new Error(`webhook ${response.statusCode}`);
  await runIntake(h, true);
}

export type Session = { id: string; cookies: Record<string, string> };

export async function loginAs(h: Harness, role: RoleKey): Promise<Session> {
  const employee = await createEmployee(h.db, { role, sector: 'comercial' });
  const login = await h.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { id: employee.id, cookies: { [SESSION_COOKIE]: token } };
}

export const call = (
  h: Harness,
  who: Session,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
) =>
  h.app.inject({
    method,
    url: `/prospect-ai/instagram${url}`,
    cookies: who.cookies,
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  });

/** Graph calls to the messages endpoint (the private reply), not the permalink reads. */
export const replyCalls = (h: Harness) => h.graphCalls.filter((c) => c.url.endsWith('/messages'));
