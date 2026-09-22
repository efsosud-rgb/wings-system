import { randomBytes } from 'node:crypto';
import { SESSION_COOKIE, type OwnedChannelsResponse } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { siteBlogPosts } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { WordPressClient } from '../../lib/wordpress.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { syncBlogPosts } from './blog-sync.js';

/**
 * The blog mirror: the ingest job reads the site's published posts once, the
 * dashboard reads the mirror and never the site. A scripted fetch stands in
 * for WordPress.
 */

const NOW = new Date('2026-09-22T12:00:00.000Z');
const sent: { method: string; path: string; query: URLSearchParams }[] = [];

const wordpressFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const path = url.pathname.replace('/wp-json/wp/v2/', '');
  sent.push({ method, path, query: url.searchParams });
  if (method === 'GET' && path === 'categories') {
    return Response.json([
      { id: 37, name: 'Formatação de Franquia', count: 14 },
      { id: 39, name: 'Governança &amp; Franchising', count: 1 },
    ]);
  }
  if (method === 'GET' && path === 'posts') {
    const page = url.searchParams.get('page');
    const body =
      page === '1'
        ? [
            {
              id: 2477,
              date_gmt: '2026-09-20T13:00:00',
              modified_gmt: '2026-09-21T09:00:00',
              title: { rendered: 'Como formatar uma franquia &#8211; guia' },
              link: 'https://site.example.test/como-formatar',
              slug: 'como-formatar',
              categories: [37, 39],
            },
            {
              id: 2470,
              date_gmt: '2026-08-01T13:00:00',
              modified_gmt: null,
              title: { rendered: 'Post antigo' },
              link: 'https://site.example.test/antigo',
              slug: 'antigo',
              categories: [37],
            },
          ]
        : [
            {
              id: 2460,
              date_gmt: '2026-07-01T13:00:00',
              title: { rendered: 'Mais antigo' },
              link: 'https://site.example.test/mais-antigo',
              slug: 'mais-antigo',
              categories: [],
            },
          ];
    return Response.json(body, { headers: { 'x-wp-totalpages': '2' } });
  }
  return Response.json({ code: 'unexpected', message: `${method} ${path}` }, { status: 500 });
}) as typeof fetch;

let harness: TestDatabase;
let db: Database;
let app: FastifyInstance;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: randomBytes(48).toString('base64'),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      APP_BASE_URL: 'https://staging.wingssystem.online',
      WORDPRESS_BASE_URL: 'https://site.example.test/',
      WORDPRESS_USERNAME: 'studio',
      WORDPRESS_APP_PASSWORD: 'abcd efgh ijkl',
    }),
    db,
    wordpressFetch,
    now: () => NOW,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

async function cookies() {
  const employee = await createEmployee(db, { role: 'marketing', sector: 'marketing' });
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const token = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error('login failed in setup');
  return { [SESSION_COOKIE]: token };
}

describe('the blog mirror', () => {
  it('reads every page of published posts with their categories, and re-running rewrites', async () => {
    const client = new WordPressClient({
      baseUrl: 'https://site.example.test',
      username: 'studio',
      applicationPassword: 'x',
      fetchImpl: wordpressFetch,
    });
    const first = await syncBlogPosts(db, client, NOW);
    expect(first.posts).toBe(3);
    const posts = sent.filter((call) => call.path === 'posts');
    expect(posts.map((call) => call.query.get('page'))).toEqual(['1', '2']);
    expect(posts[0]?.query.get('status')).toBe('publish');
    expect(sent.every((call) => call.method === 'GET')).toBe(true);

    const rows = await db.select().from(siteBlogPosts);
    expect(rows).toHaveLength(3);
    const guide = rows.find((row) => row.wordpressPostId === 2477);
    expect(guide?.title).toBe('Como formatar uma franquia – guia');
    expect(guide?.categories).toEqual([
      { id: 37, name: 'Formatação de Franquia' },
      { id: 39, name: 'Governança & Franchising' },
    ]);
    expect(guide?.publishedAt.toISOString()).toBe('2026-09-20T13:00:00.000Z');

    await syncBlogPosts(db, client, NOW);
    expect(await db.select().from(siteBlogPosts)).toHaveLength(3);
  });

  it('serves the period from the mirror without calling the site', async () => {
    const before = sent.length;
    const response = await app.inject({
      method: 'GET',
      url: '/marketing/site/blog-posts?days=30',
      cookies: await cookies(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as OwnedChannelsResponse;
    expect(body.days).toBe(30);
    expect(body.blog.configured).toBe(true);
    expect(body.blog.mirrored).toBe(3);
    expect(body.blog.syncedAt).toBe(NOW.toISOString());
    expect(body.blog.posts.map((post) => post.id)).toEqual([2477]);
    expect(body.blog.posts[0]).toMatchObject({
      title: 'Como formatar uma franquia – guia',
      categories: ['Formatação de Franquia', 'Governança & Franchising'],
      link: 'https://site.example.test/como-formatar',
    });
    expect(body.social).toBeNull();
    expect(sent.length).toBe(before);

    const wider = await app.inject({
      method: 'GET',
      url: '/marketing/site/blog-posts?days=90',
      cookies: await cookies(),
    });
    expect((wider.json() as OwnedChannelsResponse).blog.posts.map((post) => post.id)).toEqual([
      2477, 2470, 2460,
    ]);
    const bad = await app.inject({
      method: 'GET',
      url: '/marketing/site/blog-posts?days=5',
      cookies: await cookies(),
    });
    expect(bad.statusCode).toBe(400);
  });
});
