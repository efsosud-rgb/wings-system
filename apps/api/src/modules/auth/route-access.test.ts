import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_COOKIE, type RoleKey, type SectorSlug } from '@wings/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { loadEnv } from '../../env.js';
import { createEmployee, TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';

/**
 * Every route names who may call it (plugins/auth.ts), and the matrix in
 * @wings/shared decides each level (Eric, 13/10). This file fails when a route
 * appears without a declared permission, when a route opens without a login or
 * to any login without being listed here, and when a level reaches a module it
 * should not.
 */

/** Routes with no login. Adding one means adding it here, on purpose. */
const PUBLIC_ROUTES = [
  'GET /health',
  'POST /auth/login',
  'POST /auth/logout',
  'POST /auth/forgot-password',
  'POST /auth/set-password',
  'GET /media/public/:id',
  // Only with local storage (no R2): the stand-in for R2's signed addresses.
  'PUT /drive/blob',
  'GET /drive/blob',
  'POST /integrations/rd-station/webhook',
  'POST /integrations/zapi/webhook',
  'GET /integrations/meta/leadgen/webhook',
  'POST /integrations/meta/leadgen/webhook',
  'GET /integrations/instagram/webhook',
  'POST /integrations/instagram/webhook',
  'POST /integrations/tiktok/leads/webhook',
  'POST /integrations/google-ads/leads/webhook',
  'GET /integrations/whatsapp/webhook',
  'POST /integrations/whatsapp/webhook',
  'GET /public/site-forms/:slug',
  'POST /public/site-forms/:slug',
  'POST /public/site-forms/:slug/events',
];

/** Routes any login may call: the person's own session and Google connection. */
const SESSION_ROUTES = [
  'GET /auth/me',
  'GET /me/google',
  'POST /me/google/connect',
  'GET /me/google/callback',
  'DELETE /me/google',
];

let harness: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  harness = await createTestDatabase();
  app = await buildApp({
    env: loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: harness.url,
      SESSION_SECRET: randomBytes(48).toString('base64'),
      CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
      CPF_INDEX_KEY: TEST_INDEX_KEY,
      // Local storage registers the blob routes, so they are pinned here too.
      MEDIA_DIR: mkdtempSync(join(tmpdir(), 'wings-route-access-')),
    }),
    db: harness.db,
  });
  // A route someone forgot to declare: it must exist and still refuse everyone.
  app.get('/test/undeclared', async () => ({ ok: true }));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.drop();
});

const routes = () =>
  app
    .declaredRoutes()
    .filter((route) => route.method !== 'HEAD' && route.url !== '/test/undeclared');

describe('every route declares its access', () => {
  it('leaves no route without a permission, a session or a public reason', () => {
    const undeclared = routes()
      .filter((route) => route.access === null)
      .map((route) => `${route.method} ${route.url}`);
    expect(undeclared).toEqual([]);
  });

  it('opens without a login only the routes listed here', () => {
    const open = routes()
      .filter((route) => route.access?.kind === 'public')
      .map((route) => `${route.method} ${route.url}`);
    expect(open.sort()).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('opens to any login only the routes listed here', () => {
    const anyLogin = routes()
      .filter((route) => route.access?.kind === 'session')
      .map((route) => `${route.method} ${route.url}`);
    expect(anyLogin.sort()).toEqual([...SESSION_ROUTES].sort());
  });

  it('refuses an undeclared route to everyone, even the Admin Master', async () => {
    const admin = await signIn('admin_master', 'diretoria');
    const res = await app.inject({
      method: 'GET',
      url: '/test/undeclared',
      cookies: { [SESSION_COOKIE]: admin },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('route_not_declared');
  });
});

async function signIn(role: RoleKey, sector: SectorSlug): Promise<string> {
  const employee = await createEmployee(harness.db, { role, sector });
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: employee.email, password: employee.password },
  });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error(`login failed for ${role}: ${res.statusCode}`);
  return cookie.value;
}

/** One route per module, called straight at the API. */
const PROBES = {
  register: '/employees',
  leads: '/leads',
  companies: '/crm/companies',
  landingPages: '/crm/landing-pages',
  team: '/crm/sellers',
  sofia: '/sofia/conversations',
  ads: '/ads/approvals',
  campaignLeads: '/campaign-leads',
  projects: '/projects',
  drive: '/drive/tree',
  crmSettings: '/crm/distribution',
  integrations: '/crm/meta-leads/failed',
  roadmap: '/roadmap/modules',
  // Every level opens the Agenda (calendar.use, scope own; Eric, 14/10).
  agenda: '/agenda',
  // Prospecção: the Formatação seller and the managers (prospecting.use).
  prospecting: '/prospecting/usage',
  // Prospecção Instagram, parte 2 (prospecting.instagram_paste): the same levels.
  instagramProspecting: '/prospect-ai/instagram/status',
} as const;
type Probe = keyof typeof PROBES;

/** What each level opens; every other probe must answer 403. */
const LEVELS: { role: RoleKey; sector: SectorSlug; opens: Probe[] }[] = [
  {
    role: 'vendedor_expansao',
    sector: 'comercial',
    // Eric, 14/10: the CRM of their own deals; no Empresas, Landing pages, team list or Drive.
    opens: ['leads', 'projects', 'agenda'],
  },
  {
    role: 'vendedor_formatacao',
    sector: 'comercial',
    opens: ['leads', 'campaignLeads', 'projects', 'agenda', 'prospecting', 'instagramProspecting'],
  },
  {
    role: 'gerente_comercial',
    sector: 'comercial',
    opens: [
      'register',
      'leads',
      'companies',
      'landingPages',
      'team',
      'sofia',
      'campaignLeads',
      'projects',
      'drive',
      'crmSettings',
      'agenda',
      'prospecting',
      'instagramProspecting',
    ],
  },
  {
    role: 'diretoria',
    sector: 'diretoria',
    opens: [
      'register',
      'leads',
      'companies',
      'landingPages',
      'team',
      'sofia',
      'ads',
      'campaignLeads',
      'projects',
      'drive',
      'agenda',
      'prospecting',
      'instagramProspecting',
    ],
  },
  { role: 'marketing', sector: 'marketing', opens: ['ads', 'projects', 'drive', 'agenda'] },
  { role: 'formatacao_ti', sector: 'formatacao-ti', opens: ['projects', 'drive', 'agenda'] },
  { role: 'rh_dp', sector: 'diretoria', opens: ['register', 'projects', 'drive', 'agenda'] },
  {
    role: 'admin_master',
    sector: 'diretoria',
    opens: Object.keys(PROBES) as Probe[],
  },
];

describe('each level reaches only its modules, straight at the API', () => {
  it.each(LEVELS)('$role', async ({ role, sector, opens }) => {
    const cookie = await signIn(role, sector);
    const outcome: Record<string, 'opens' | 'refused'> = {};
    for (const [probe, url] of Object.entries(PROBES)) {
      const res = await app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: cookie } });
      // The module gate is what is tested: past it, a route may still answer 4xx/5xx for its own reasons.
      outcome[probe] = res.statusCode === 403 ? 'refused' : 'opens';
    }
    const expected = Object.fromEntries(
      Object.keys(PROBES).map((probe) => [
        probe,
        opens.includes(probe as Probe) ? 'opens' : 'refused',
      ]),
    );
    expect(outcome).toEqual(expected);
  });
});
