import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type SitePostRecord, type SiteStatus } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { loadEnv } from '../../env.js';
import { plainTextToHtml } from '../../lib/wordpress.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

/**
 * The studio's only power over the public site is to leave a draft behind.
 * A scripted fetch stands in for WordPress: no test reaches a real site.
 */

interface Sent {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

let harness: TestDatabase;
let db: Database;
let configured: FastifyInstance;
let unconfigured: FastifyInstance;
const sent: Sent[] = [];
let respond: () => Response | Promise<Response> = () => Response.json({ id: 321 }, { status: 201 });

const wordpressFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  sent.push({
    url: String(input),
    authorization: new Headers(init?.headers).get('authorization'),
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  });
  return respond();
}) as typeof fetch;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: randomBytes(48).toString('base64'),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'https://staging.wingssystem.online',
  };
  configured = await buildApp({
    env: loadEnv({
      ...base,
      WORDPRESS_BASE_URL: 'https://site.example.test/',
      WORDPRESS_USERNAME: 'studio',
      WORDPRESS_APP_PASSWORD: 'abcd efgh ijkl',
    }),
    db,
    wordpressFetch,
  });
  unconfigured = await buildApp({ env: loadEnv(base), db, wordpressFetch });
}, 60_000);

afterAll(async () => {
  await configured?.close();
  await unconfigured?.close();
  await harness?.drop();
});

async function cookiesFor(app: FastifyInstance, role: 'marketing' | 'vendedor_expansao') {
  const employee = await createEmployee(db, {
    role,
    sector: role === 'marketing' ? 'marketing' : 'comercial',
  });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { [SESSION_COOKIE]: token };
}

const post = {
  title: 'Como é o dia a dia de um franqueado Wings',
  excerpt: 'Rotina, suporte e primeiros passos.',
  content: 'Primeiro parágrafo, com <b>marcação</b> digitada.\n\nSegundo parágrafo\ncom quebra.',
};

describe('POST /marketing/site/posts', () => {
  it('creates a DRAFT, with escaped content, and records it', async () => {
    sent.length = 0;
    const cookies = await cookiesFor(configured, 'marketing');
    const response = await configured.inject({
      method: 'POST',
      url: '/marketing/site/posts',
      cookies,
      payload: post,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ editUrl: string }>().editUrl).toBe(
      'https://site.example.test/wp-admin/post.php?post=321&action=edit',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://site.example.test/wp-json/wp/v2/posts');
    expect(sent[0]?.authorization).toBe(
      `Basic ${Buffer.from('studio:abcd efgh ijkl').toString('base64')}`,
    );
    expect(sent[0]?.body.status).toBe('draft');
    expect(sent[0]?.body.content).toBe(
      '<p>Primeiro parágrafo, com &lt;b&gt;marcação&lt;/b&gt; digitada.</p>\n<p>Segundo parágrafo<br />com quebra.</p>',
    );

    const list = await configured.inject({ url: '/marketing/site/posts', cookies });
    const [latest] = list.json<{ posts: SitePostRecord[] }>().posts;
    expect(latest).toMatchObject({ title: post.title, outcome: 'draft_created' });
  });

  it('cannot be asked to publish', async () => {
    sent.length = 0;
    await configured.inject({
      method: 'POST',
      url: '/marketing/site/posts',
      cookies: await cookiesFor(configured, 'marketing'),
      payload: { ...post, status: 'publish' },
    });
    expect(sent[0]?.body.status).toBe('draft');
  });

  it('answers 503 when the server has no credentials, and sends nothing', async () => {
    sent.length = 0;
    const cookies = await cookiesFor(unconfigured, 'marketing');
    const status = await unconfigured.inject({ url: '/marketing/site/status', cookies });
    expect(status.json<{ status: SiteStatus }>().status).toEqual({
      configured: false,
      siteHost: null,
    });

    const response = await unconfigured.inject({
      method: 'POST',
      url: '/marketing/site/posts',
      cookies,
      payload: post,
    });
    expect(response.statusCode).toBe(503);
    expect(sent).toEqual([]);
  });

  it('reports a refusal and an unconfirmed outcome as what they are', async () => {
    const cookies = await cookiesFor(configured, 'marketing');
    const send = () =>
      configured.inject({ method: 'POST', url: '/marketing/site/posts', cookies, payload: post });

    respond = () =>
      Response.json({ code: 'rest_cannot_create', message: 'Sem permissão.' }, { status: 403 });
    const refused = await send();
    expect(refused.statusCode).toBe(502);
    expect(refused.json<{ message: string }>().message).toContain('Sem permissão.');

    respond = () => {
      throw new TypeError('fetch failed');
    };
    const unknown = await send();
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json<{ error: string }>().error).toBe('unknown_outcome');

    respond = () => Response.json({ id: 321 }, { status: 201 });
    const list = await configured.inject({ url: '/marketing/site/posts', cookies });
    expect(list.json<{ posts: SitePostRecord[] }>().posts.map((p) => p.outcome)).toEqual(
      expect.arrayContaining(['failed', 'unknown']),
    );
  });

  it('refuses someone without site.publish, and a post with no body', async () => {
    const outsider = await configured.inject({
      method: 'POST',
      url: '/marketing/site/posts',
      cookies: await cookiesFor(configured, 'vendedor_expansao'),
      payload: post,
    });
    expect(outsider.statusCode).toBe(403);

    const empty = await configured.inject({
      method: 'POST',
      url: '/marketing/site/posts',
      cookies: await cookiesFor(configured, 'marketing'),
      payload: { ...post, content: 'curto' },
    });
    expect(empty.statusCode).toBe(400);
  });
});

describe('plainTextToHtml', () => {
  it('escapes everything the operator typed', () => {
    expect(plainTextToHtml('<script>alert("x")</script> & mais')).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; mais</p>',
    );
  });
});
