import { randomBytes } from 'node:crypto';
import {
  SESSION_COOKIE,
  type SiteImageUpload,
  type SitePostRecord,
  type SiteStatus,
  type SiteTerms,
} from '@wings/shared';
import { desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import type { Database } from '../../db/client.js';
import { sitePosts } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';

/**
 * The studio's only power over the public site is to leave a draft behind,
 * with new media in it. A scripted fetch stands in for WordPress: no test
 * reaches a real site.
 */

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  json: Record<string, unknown> | null;
  bytes: number;
}

let harness: TestDatabase;
let db: Database;
let configured: FastifyInstance;
let unconfigured: FastifyInstance;
const sent: Sent[] = [];
let nextMediaId = 500;
/** Media uploads to refuse, by order of arrival (1-based), for one test. */
let failMediaAt: number | null = null;
let postResponse: () => Response = () => Response.json({ id: 321 }, { status: 201 });

const wordpressFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const path = url.pathname.replace('/wp-json/wp/v2/', '');
  const body = init?.body;
  sent.push({
    method,
    path,
    query: url.searchParams,
    headers: new Headers(init?.headers),
    json: typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : null,
    bytes: Buffer.isBuffer(body) ? body.length : 0,
  });

  if (method === 'GET' && path === 'categories') {
    return Response.json([
      { id: 37, name: 'Formatação de Franquia', count: 14 },
      { id: 39, name: 'Governança &amp; Franchising', count: 1 },
    ]);
  }
  if (method === 'GET' && path === 'tags') {
    return Response.json([
      { id: 7, name: 'Artigo', count: 9 },
      { id: 8, name: 'IA', count: 2 },
    ]);
  }
  if (method === 'POST' && path === 'media') {
    const arrival = sent.filter((s) => s.method === 'POST' && s.path === 'media').length;
    if (failMediaAt === arrival) {
      return Response.json(
        { code: 'rest_upload_unknown_error', message: 'Arquivo grande demais.' },
        { status: 400 },
      );
    }
    nextMediaId += 1;
    return Response.json(
      {
        id: nextMediaId,
        source_url: `https://site.example.test/wp-content/uploads/m-${nextMediaId}.jpg`,
      },
      { status: 201 },
    );
  }
  if (method === 'POST' && path === 'posts') return postResponse();
  return Response.json({ code: 'unexpected', message: `${method} ${path}` }, { status: 500 });
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

beforeEach(() => {
  sent.length = 0;
  failMediaAt = null;
  postResponse = () => Response.json({ id: 321 }, { status: 201 });
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

/** Header bytes only: what the server reads to learn type and size. */
function jpegOf(width: number, height: number): Buffer {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255];
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    ...sof,
    ...new Array<number>(12).fill(0),
  ]);
}
function webpOf(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(40);
  bytes.write('RIFF', 0, 'latin1');
  bytes.write('WEBP', 8, 'latin1');
  bytes.write('VP8X', 12, 'latin1');
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

async function hold(cookies: Record<string, string>, bytes: Buffer, type = 'image/jpeg') {
  return configured.inject({
    method: 'POST',
    url: '/marketing/site/images',
    cookies,
    headers: { 'content-type': type },
    payload: bytes,
  });
}
async function heldId(cookies: Record<string, string>, width = 1600, height = 900) {
  return (await hold(cookies, jpegOf(width, height))).json<{ image: SiteImageUpload }>().image.id;
}

const post = {
  title: 'Como é o dia a dia de um franqueado Wings',
  excerpt: 'Rotina, suporte e primeiros passos.',
  content:
    '## Rotina\n\nPrimeiro parágrafo com **força** e <b>marcação</b> digitada.\n\nSegundo parágrafo.',
  categories: [37],
};
const send = (cookies: Record<string, string>, payload: Record<string, unknown>) =>
  configured.inject({ method: 'POST', url: '/marketing/site/posts', cookies, payload });
const wpCalls = (method: string, path: string) =>
  sent.filter((s) => s.method === method && s.path === path);

describe('the site terms', () => {
  it('lists real categories and tags, decoded, and reads the site once for many requests', async () => {
    const cookies = await cookiesFor(configured, 'marketing');
    const first = await configured.inject({ url: '/marketing/site/terms', cookies });
    const { terms } = first.json<{ terms: SiteTerms }>();
    expect(terms.categories.map((c) => c.name)).toEqual([
      'Formatação de Franquia',
      'Governança & Franchising',
    ]);
    expect(terms.tags.map((t) => t.id)).toEqual([7, 8]);

    await configured.inject({ url: '/marketing/site/terms', cookies });
    // A click on "atualizar" seconds later is served from the same read too.
    await configured.inject({ url: '/marketing/site/terms?refresh=1', cookies });
    expect(wpCalls('GET', 'categories')).toHaveLength(1);
    expect(wpCalls('GET', 'tags')[0]?.query.get('per_page')).toBe('100');
  });

  it('answers 503 without credentials', async () => {
    const response = await unconfigured.inject({
      url: '/marketing/site/terms',
      cookies: await cookiesFor(unconfigured, 'marketing'),
    });
    expect(response.statusCode).toBe(503);
  });
});

describe('holding an image before it goes anywhere', () => {
  it('accepts JPG, PNG-or-WebP by their bytes, and sends nothing to the site', async () => {
    const cookies = await cookiesFor(configured, 'marketing');
    // The browser's claim about the type is ignored: the bytes are WebP.
    const response = await hold(cookies, webpOf(1200, 630), 'image/png');
    expect(response.statusCode).toBe(201);
    const { image } = response.json<{ image: SiteImageUpload }>();
    expect(image).toMatchObject({ mimeType: 'image/webp', width: 1200, height: 630 });

    const served = await configured.inject({ url: `/marketing/site/images/${image.id}`, cookies });
    expect(served.headers['content-type']).toBe('image/webp');
    expect(sent).toEqual([]);
  });

  it('refuses what is not an image, what is over 5 MB, and who may not publish', async () => {
    const cookies = await cookiesFor(configured, 'marketing');
    expect((await hold(cookies, Buffer.from('GIF89a' + 'x'.repeat(60)))).statusCode).toBe(400);
    expect(
      (await hold(cookies, Buffer.from('<svg onload=alert(1)>'), 'image/png')).statusCode,
    ).toBe(400);
    const big = Buffer.concat([jpegOf(2000, 2000), Buffer.alloc(5 * 1024 * 1024)]);
    expect((await hold(cookies, big)).statusCode).toBe(413);
    const outsider = await cookiesFor(configured, 'vendedor_expansao');
    expect((await hold(outsider, jpegOf(1600, 900))).statusCode).toBe(403);
  });
});

describe('building the draft', () => {
  it('uploads the media first, then one DRAFT with categories, tags, featured image and blocks', async () => {
    const cookies = await cookiesFor(configured, 'marketing');
    await configured.inject({ url: '/marketing/site/terms', cookies });
    sent.length = 0;
    const featuredImageId = await heldId(cookies);
    const images = [
      { uploadId: await heldId(cookies, 1080, 1080), caption: 'Equipe "Wings" <3' },
      { uploadId: await heldId(cookies, 1080, 1080) },
      { uploadId: await heldId(cookies, 1080, 1080), caption: 'Treinamento' },
    ];

    const response = await send(cookies, {
      ...post,
      content: `${post.content}\n\n{{img:1}}\n\nMeio.\n\n{{galeria}}\n\n{{video}}`,
      categories: [37, 39],
      tags: [8],
      featuredImageId,
      images,
      gallery: [2, 3],
      videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
      status: 'publish',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json<{ editUrl: string }>().editUrl).toBe(
      'https://site.example.test/wp-admin/post.php?post=321&action=edit',
    );

    // Four new media items, in order, then exactly one post — and nothing else.
    const media = wpCalls('POST', 'media');
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST media',
      'POST media',
      'POST media',
      'POST media',
      'POST posts',
    ]);
    expect(media[0]?.query.get('title')).toBe(`${post.title} — imagem destacada`);
    expect(media[0]?.headers.get('content-disposition')).toBe(
      'attachment; filename="como-e-o-dia-a-dia-de-um-franqueado-wings-destaque.jpg"',
    );
    expect(media[1]?.query.get('caption')).toBe('Equipe "Wings" <3');
    expect(media[1]?.query.get('alt_text')).toBe('Equipe "Wings" <3');
    expect(media[2]?.query.get('alt_text')).toBe(post.title);
    expect(media[0]?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('studio:abcd efgh ijkl').toString('base64')}`,
    );

    const [first, second, third, fourth] = media.map((_, i) => nextMediaId - 3 + i);
    const body = wpCalls('POST', 'posts')[0]?.json ?? {};
    expect(body).toMatchObject({
      title: post.title,
      excerpt: post.excerpt,
      status: 'draft',
      categories: [37, 39],
      tags: [8],
      featured_media: first,
    });
    const content = String(body.content);
    expect(content).toContain('<h2>Rotina</h2>');
    expect(content).toContain('<strong>força</strong> e &lt;b&gt;marcação&lt;/b&gt; digitada.');
    expect(content).toContain(`<!-- wp:image {"id":${second},`);
    expect(content).toContain(
      '<figcaption class="wp-element-caption">Equipe &quot;Wings&quot; &lt;3</figcaption>',
    );
    const gallery = content.slice(
      content.indexOf('<!-- wp:gallery'),
      content.indexOf('<!-- /wp:gallery'),
    );
    expect([...gallery.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]))).toEqual([third, fourth]);
    expect(content).toContain('\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(content.indexOf('wp:image')).toBeLessThan(content.indexOf('<p>Meio.</p>'));

    // Everything that went up is on record, in order, with its caption.
    const [row] = await db.select().from(sitePosts).orderBy(desc(sitePosts.createdAt)).limit(1);
    expect(row?.featuredMediaId).toBe(first);
    expect(row?.categories).toEqual([
      { id: 37, name: 'Formatação de Franquia' },
      { id: 39, name: 'Governança & Franchising' },
    ]);
    expect(row?.media).toMatchObject([
      { role: 'featured', position: 0, wordpressMediaId: first },
      {
        role: 'inline',
        position: 1,
        wordpressMediaId: second,
        caption: 'Equipe "Wings" <3',
        inGallery: false,
      },
      { role: 'inline', position: 2, wordpressMediaId: third, inGallery: true },
      {
        role: 'inline',
        position: 3,
        wordpressMediaId: fourth,
        caption: 'Treinamento',
        inGallery: true,
      },
    ]);
    expect(row?.videoUrl).toBe('https://youtu.be/dQw4w9WgXcQ');

    const list = await configured.inject({ url: '/marketing/site/posts', cookies });
    expect(list.json<{ posts: SitePostRecord[] }>().posts[0]).toMatchObject({
      outcome: 'draft_created',
      categoryNames: ['Formatação de Franquia', 'Governança & Franchising'],
      hasFeaturedImage: true,
      imageCount: 3,
      editUrl: 'https://site.example.test/wp-admin/post.php?post=321&action=edit',
    });
  });

  it('only ever POSTs to collections: nothing existing on the site can be touched', async () => {
    const cookies = await cookiesFor(configured, 'marketing');
    await send(cookies, { ...post, images: [{ uploadId: await heldId(cookies) }] });
    for (const call of sent) {
      expect(['GET', 'POST']).toContain(call.method);
      if (call.method === 'POST') expect(['media', 'posts']).toContain(call.path);
    }
  });

  it('creates no post when an upload fails midway, says which file, and reuses the rest on retry', async () => {
    const cookies = await cookiesFor(configured, 'marketing');
    const payload = {
      ...post,
      images: [
        { uploadId: await heldId(cookies) },
        { uploadId: await heldId(cookies) },
        { uploadId: await heldId(cookies) },
      ],
    };
    failMediaAt = 2;
    const failed = await send(cookies, payload);
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({
      error: 'media_upload_failed',
      failedImage: { role: 'inline', position: 2 },
    });
    expect(failed.json<{ message: string }>().message).toMatch(
      /^Imagem 2 não subiu.*Arquivo grande demais.*NÃO foi criado/,
    );
    expect(wpCalls('POST', 'posts')).toHaveLength(0);

    const [row] = await db.select().from(sitePosts).orderBy(desc(sitePosts.createdAt)).limit(1);
    expect(row).toMatchObject({
      outcome: 'failed',
      detail: 'media:inline:2:rest_upload_unknown_error',
    });
    expect(row?.media).toHaveLength(1);
    const alreadyUp = (row?.media as { wordpressMediaId: number }[])[0]?.wordpressMediaId;

    // Same form, sent again: image 1 is not uploaded a second time.
    sent.length = 0;
    failMediaAt = null;
    expect((await send(cookies, payload)).statusCode).toBe(201);
    expect(wpCalls('POST', 'media')).toHaveLength(2);
    expect(String(wpCalls('POST', 'posts')[0]?.json?.content)).toContain(`"id":${alreadyUp},`);
  });

  it('refuses before sending anything: a small featured image, an unknown term, a missing image', async () => {
    const cookies = await cookiesFor(configured, 'marketing');
    await configured.inject({ url: '/marketing/site/terms', cookies });
    sent.length = 0;

    const small = await send(cookies, {
      ...post,
      featuredImageId: await heldId(cookies, 800, 600),
    });
    expect(small.json<{ error: string }>().error).toBe('featured_too_small');
    expect((await send(cookies, { ...post, tags: [999] })).json<{ error: string }>().error).toBe(
      'unknown_term',
    );
    const missing = await send(cookies, {
      ...post,
      images: [{ uploadId: '33333333-3333-4333-8333-333333333333' }],
    });
    expect(missing.json<{ error: string }>().error).toBe('image_not_found');
    expect((await send(cookies, { ...post, categories: [] })).statusCode).toBe(400);
    expect(sent.filter((s) => s.method === 'POST')).toEqual([]);
  });

  it('answers 503 when the server has no credentials, and sends nothing', async () => {
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
    postResponse = () =>
      Response.json({ code: 'rest_cannot_create', message: 'Sem permissão.' }, { status: 403 });
    const refused = await send(cookies, post);
    expect(refused.statusCode).toBe(502);
    expect(refused.json<{ message: string }>().message).toContain('Sem permissão.');

    postResponse = () => new Response('bad gateway', { status: 502 });
    const unknown = await send(cookies, post);
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json<{ error: string }>().error).toBe('unknown_outcome');
  });

  it('refuses someone without site.publish', async () => {
    const outsider = await send(await cookiesFor(configured, 'vendedor_expansao'), post);
    expect(outsider.statusCode).toBe(403);
  });
});
