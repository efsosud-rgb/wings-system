// The landing's end-to-end check against the real API (the "API de teste"):
//
//   pnpm --filter @wings/landing build
//   DATABASE_URL=<local dev database> pnpm --filter @wings/landing test:e2e:api
//
// It creates a throwaway database with apps/api's test helper (wings_test_<hex>,
// migrated and seeded; the seed runs again with a made-up Wings number so the
// Wings "Site" link exists), builds the API the way the site-forms tests do and
// listens on 127.0.0.1, runs e2e/run.mjs against it (API_BASE) at 1440x900 and
// 390x844, checks in that database what the submissions left, and drops it on
// the way out (also on Ctrl+C or SIGTERM). DATABASE_URL only names the server
// where that database is made: no other database is read or written.
//
// No request leaves this process: the API's network kill switch is the first
// import, and Turnstile's siteverify is answered here (Cloudflare's public test
// keys, the dummy token the page's fake widget hands out).
import '../../api/src/test/no-network.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WINGS_CLIENT_ID } from '@wings/shared';
import { buildApp } from '../../api/src/app.js';
import { FALE_COM_A_WINGS, seed } from '../../api/src/db/seed.js';
import { loadEnv } from '../../api/src/env.js';
import { siteWhatsappUrl } from '../../api/src/modules/leads/site-forms.js';
import { createTestDatabase, type TestDatabase } from '../../api/src/test/db.js';
import { TEST_CPF_KEY, TEST_INDEX_KEY } from '../../api/src/test/factories.js';

const SLUG = FALE_COM_A_WINGS.pattern;
const FORM_PATH = `/public/site-forms/${SLUG}`;
/** Made-up: 55 + DDD 21 + a number nobody has. */
const WINGS_NUMBER = '5521900000000';
/** Cloudflare's public test keys ("always passes"), documented for exactly this. */
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';
/** The response token Cloudflare's test site keys give, which the page's fake widget hands out. */
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/**
 * The funnel each answer to "O que você procura?" leads to: the page's own
 * (Formatação) unless the seeded spec names another. "Ainda não sei" names
 * none, which counts only while the Jev triage is on; this API runs without
 * it (no JEV_API_KEY), so that lead keeps the page's Formatação too.
 */
const EXPECTED_PIPELINE: Record<string, string | null> = {
  formatacao: 'formatacao',
  expansao: 'formatacao',
  consultoria: 'formatacao',
  'nao-sei': 'formatacao',
};

interface Submission {
  label: string;
  answer: string;
  answerText: string;
  instagramTyped: string;
  email: string;
  phone: string;
  sent: boolean;
  /** The form ref the thank-you link carried after the code, or null. */
  ref: string | null;
}

interface Report {
  /** How many forms the browser run meant to send. */
  planned: number;
  consentShown: string;
  submissions: Submission[];
}

interface ApiCall {
  method: string;
  path: string;
  status: number;
  origin: string | null;
  browser: boolean;
  allowOrigin: string | null;
  allowCredentials: string | null;
}

// ---------------------------------------------------------------- results

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: unknown, detail = ''): void {
  results.push({ name, ok: Boolean(ok), detail });
  console.warn(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const headerOf = (value: unknown): string | null =>
  value === undefined || value === null ? null : String(value);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const address = server.address();
  await new Promise<void>((ok) => server.close(() => ok()));
  if (!address || typeof address === 'string') throw new Error('no free port');
  return address.port;
}

// ---------------------------------------------------------------- lifecycle

let harness: TestDatabase | null = null;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let child: ChildProcess | null = null;
let reportDir: string | null = null;
let stopping = false;

/** Stops the e2e, the API and drops the throwaway database; safe to call more than once. */
async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await app?.close().catch(() => {});
    if (harness) {
      const name = new URL(harness.url).pathname.slice(1);
      await harness
        .drop()
        .then(() => console.warn(`test database ${name} dropped`))
        .catch((error: unknown) => {
          console.error(
            `could not drop ${name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
    if (reportDir) rmSync(reportDir, { recursive: true, force: true });
  }
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

// ---------------------------------------------------------------- the API

async function startApi(pageOrigin: string) {
  const database = await createTestDatabase();
  harness = database;
  const name = new URL(database.url).pathname.slice(1);
  if (!/^wings_test_[0-9a-f]{12}$/.test(name)) {
    throw new Error('the test helper did not make a throwaway database');
  }
  console.warn(`test database ${name} created`);
  // createTestDatabase seeds without the number; the seed is safe to run again.
  await seed(database.db, { wingsWhatsappNumber: WINGS_NUMBER });

  const captchaCalls: { secretOk: boolean; tokenOk: boolean }[] = [];
  const captchaFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ''));
    const call = {
      secretOk: params.get('secret') === TURNSTILE_TEST_SECRET,
      tokenOk: params.get('response') === DUMMY_TOKEN,
    };
    captchaCalls.push(call);
    const success = call.secretOk && call.tokenOk;
    return new Response(
      JSON.stringify({ success, 'error-codes': success ? [] : ['invalid-input-response'] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    TURNSTILE_SITE_KEY: TURNSTILE_TEST_SITE_KEY,
    TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET,
    LANDING_ORIGINS: pageOrigin,
    WINGS_WHATSAPP_NUMBER: WINGS_NUMBER,
  });
  const api = await buildApp({ env, db: database.db, captchaFetch });
  app = api;

  // What reached /public/*: method, status and the CORS answer; never a body.
  const calls: ApiCall[] = [];
  api.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/public/')) return;
    calls.push({
      method: request.method,
      path,
      status: reply.statusCode,
      origin: request.headers.origin ?? null,
      // a browser's request (its preflight included) says how it fetches; a plain HTTP client does not
      browser: request.headers['sec-fetch-mode'] !== undefined,
      allowOrigin: headerOf(reply.getHeader('access-control-allow-origin')),
      allowCredentials: headerOf(reply.getHeader('access-control-allow-credentials')),
    });
  });
  await api.listen({ host: '127.0.0.1', port: 0 });
  const address = api.server.address();
  if (!address || typeof address === 'string') throw new Error('the API did not listen');
  const whatsappUrl = await siteWhatsappUrl(database.db, WINGS_CLIENT_ID, true, WINGS_NUMBER);
  return { db: database.db, port: address.port, calls, captchaCalls, whatsappUrl };
}

// ---------------------------------------------------------------- the browser run

function runE2e(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((ok, fail) => {
    child = spawn(process.execPath, [resolve(import.meta.dirname, 'run.mjs')], {
      stdio: 'inherit',
      env,
    });
    child.once('error', fail);
    child.once('exit', (code) => ok(code ?? 1));
  });
}

// ---------------------------------------------------------------- what the database kept

async function checkDatabase(db: TestDatabase['db'], report: Report): Promise<void> {
  const spec = FALE_COM_A_WINGS.spec;
  const question = spec.qualifier.question;
  const rows = await db.query.leads.findMany({
    where: (lead, { eq }) => eq(lead.landingPage, SLUG),
  });
  const sent = report.submissions.filter((submission) => submission.sent);
  check(
    `db: one lead per sent form (${sent.length} sent, ${report.planned} planned)`,
    report.planned > 0 && sent.length === report.planned && rows.length === sent.length,
    `${rows.length} leads with landing_page ${SLUG}`,
  );

  for (const submission of report.submissions) {
    const label = `db ${submission.label} (${submission.answer})`;
    const matches = rows.filter((row) => row.email === submission.email);
    const lead = matches[0];
    check(`${label}: exactly one lead for this form`, matches.length === 1, `${matches.length}`);
    if (!lead) continue;
    const expected = EXPECTED_PIPELINE[submission.answer];
    const option = spec.qualifierValues.find((entry) => entry.value === submission.answer)?.option;
    check(
      `${label}: source site_form, landing_page ${SLUG}, Wings Company`,
      lead.source === 'site_form' && lead.landingPage === SLUG && lead.clientId === WINGS_CLIENT_ID,
      `lead ${lead.id}: ${lead.source}, ${lead.landingPage}`,
    );
    check(
      `${label}: pipeline ${expected ?? 'null'}`,
      expected !== undefined && lead.pipeline === expected,
      `pipeline ${lead.pipeline ?? 'null'}`,
    );
    check(
      `${label}: phone kept with 55 + DDD`,
      lead.phone === `55${submission.phone}`,
      lead.phone === `55${submission.phone}` ? 'ok' : 'different',
    );
    check(
      `${label}: Instagram typed as "${submission.instagramTyped}" kept as the bare username`,
      lead.instagram === 'marca.teste',
      `instagram ${lead.instagram ?? 'null'}`,
    );
    check(
      `${label}: form_answers holds the option's text under the question`,
      option !== undefined &&
        JSON.stringify(lead.formAnswers) === JSON.stringify({ [question]: option }),
      JSON.stringify(lead.formAnswers),
    );
    check(
      `${label}: the page shows the API's option text`,
      submission.answerText === option,
      submission.answerText,
    );
    const events = await db.query.leadEvents.findMany({
      where: (event, { and, eq }) =>
        and(eq(event.leadId, lead.id), eq(event.kind, 'lead.received.site_form')),
    });
    const detail = (events[0]?.detail ?? {}) as Record<string, unknown>;
    check(
      `${label}: lead.received.site_form event carries the code and the funnel`,
      events.length === 1 &&
        detail.qualifier === submission.answer &&
        (detail.pipeline ?? null) === expected,
      JSON.stringify({ qualifier: detail.qualifier, pipeline: detail.pipeline }),
    );
    check(
      `${label}: the thank-you link's ref is the one the lead keeps (form_ref)`,
      submission.ref !== null && lead.formRef === submission.ref && lead.formRefAt !== null,
      lead.formRef === submission.ref ? 'same ref' : 'different',
    );
    check(
      `${label}: the lead keeps the consent line the page shows`,
      lead.consentText === report.consentShown,
      lead.consentText === report.consentShown ? 'same line' : `kept "${lead.consentText}"`,
    );
  }
}

/** The line next to the checkbox is the one the seed gives the rule and the GET hands out. */
async function checkConsentLine(api: NonNullable<typeof app>, report: Report): Promise<void> {
  const seeded = FALE_COM_A_WINGS.spec.consentText;
  check(
    'page: consent label is the seeded consentText, word for word',
    report.consentShown === seeded,
    `shown "${report.consentShown}"`,
  );
  const info = await api.inject({ method: 'GET', url: FORM_PATH });
  const fromGet = (info.json() as { form?: { consentText?: string } | null }).form?.consentText;
  check('api: the GET hands out the same consentText', fromGet === seeded, `GET "${fromGet}"`);
}

function checkCalls(calls: ApiCall[], pageOrigin: string, posts: number): void {
  const fromPage = calls.filter(
    (call) => call.browser && call.origin === pageOrigin && call.path === FORM_PATH,
  );
  // each run is a new browser context, so each POST had a preflight of its own
  const preflights = fromPage.filter((call) => call.method === 'OPTIONS');
  const gets = fromPage.filter((call) => call.method === 'GET');
  const sends = fromPage.filter((call) => call.method === 'POST');
  const allowed = (call: ApiCall) =>
    call.allowOrigin === pageOrigin && call.allowCredentials === null;
  check(
    'api: the browser preflight reached the API and passed (204, page origin)',
    preflights.length === posts && preflights.every((call) => call.status === 204 && allowed(call)),
    `${preflights.length} preflights: ${preflights.map((call) => call.status).join(' ')}`,
  );
  check(
    'api: every GET from the page answered 200 with the page origin',
    gets.length >= posts && gets.every((call) => call.status === 200 && allowed(call)),
    `${gets.length} GETs: ${gets.map((call) => call.status).join(' ')}`,
  );
  check(
    'api: every POST from the page answered 200 with the page origin',
    sends.length === posts && sends.every((call) => call.status === 200 && allowed(call)),
    `${sends.length} POSTs: ${sends.map((call) => call.status).join(' ')}`,
  );
  check(
    'api: no answer allowed credentials',
    calls.every((call) => call.allowCredentials === null),
  );
}

// ---------------------------------------------------------------- main

/** The whole run; its exit code. */
async function main(): Promise<number> {
  const pagePort = await freePort();
  const pageOrigin = `http://127.0.0.1:${pagePort}`;
  const api = await startApi(pageOrigin);
  check('api: Wings "Site" link made by the seed', api.whatsappUrl !== null, api.whatsappUrl ?? '');
  reportDir = mkdtempSync(join(tmpdir(), 'wings-landing-api-'));
  const reportPath = join(reportDir, 'report.json');
  // The browser run never needs the database server's address.
  const inherited = { ...process.env };
  delete inherited.DATABASE_URL;
  const e2eCode = await runE2e({
    ...inherited,
    API_BASE: `http://localhost:${api.port}`,
    E2E_PORT: String(pagePort),
    E2E_EXPECT_WHATSAPP: api.whatsappUrl ?? '',
    E2E_REPORT: reportPath,
  });
  child = null;
  check('e2e: browser run passed', e2eCode === 0, `exit ${e2eCode}`);

  let report: Report | null = null;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  } catch {
    check('e2e: report written', false, 'no report from run.mjs');
  }
  if (report) {
    // every planned form must have gone through: a run that stopped early fails here too
    const posts = report.planned;
    if (app) await checkConsentLine(app, report);
    await checkDatabase(api.db, report);
    checkCalls(api.calls, pageOrigin, posts);
    check(
      'api: Turnstile checked once per sent form, with the test secret and the dummy token',
      api.captchaCalls.length === posts &&
        api.captchaCalls.every((call) => call.secretOk && call.tokenOk),
      `${api.captchaCalls.length} siteverify calls`,
    );
  }
  const failed = results.filter((result) => !result.ok);
  console.warn(`\nAPI and database: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.warn(`FAILED:\n${failed.map((f) => `  - ${f.name} — ${f.detail}`).join('\n')}`);
  }
  return failed.length === 0 ? 0 : 1;
}

const exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
await shutdown(exitCode);
