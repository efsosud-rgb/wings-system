// The landing's end-to-end check against the real API (the "API de teste"):
//
//   pnpm --filter @wings/landing build
//   DATABASE_URL=<local dev database> pnpm --filter @wings/landing test:e2e:api
//
// It creates a throwaway database with apps/api's test helper (wings_test_<hex>,
// migrated and seeded; the seed runs again with a made-up Wings number so the
// Wings "Site" link exists), builds the API the way the site-forms tests do and
// listens on 127.0.0.1, runs e2e/run.mjs against it (API_BASE) from the phones
// it emulates (Android with Chrome and with the Instagram app's browser, iPhone
// with Safari's user agent), checks in that database what the sent forms left
// and that the refused ones left nothing, and drops it on the way out (also on
// Ctrl+C or SIGTERM). DATABASE_URL only names the server where that database
// is made: no other database is read or written.
//
// No request leaves this process: the API's network kill switch is the first
// import, and Turnstile's siteverify is answered here (Cloudflare's public test
// keys, the dummy token the page's fake widget hands out; two tokens of the
// test's own make it refuse, or fail as if Cloudflare were down).
import '../../api/src/test/no-network.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { siteEventSchema, WINGS_CLIENT_ID } from '@wings/shared';
import { buildApp } from '../../api/src/app.js';
import { FALE_COM_A_WINGS, seed } from '../../api/src/db/seed.js';
import { loadEnv } from '../../api/src/env.js';
import { siteEventLineOf } from '../../api/src/modules/leads/site-events.js';
import { siteWhatsappUrl } from '../../api/src/modules/leads/site-forms.js';
import { createTestDatabase, type TestDatabase } from '../../api/src/test/db.js';
import { TEST_CPF_KEY, TEST_INDEX_KEY } from '../../api/src/test/factories.js';

// Without DATABASE_URL, the local development database of docker-compose.dev.yml (pnpm db:up).
process.env.DATABASE_URL ??= 'postgresql://wings:wings_dev_only@127.0.0.1:5433/wings_system';

const SLUG = FALE_COM_A_WINGS.pattern;
const FORM_PATH = `/public/site-forms/${SLUG}`;
/** Made-up: 55 + DDD 21 + a number nobody has. */
const WINGS_NUMBER = '5521900000000';
/** Cloudflare's public test keys ("always passes"), documented for exactly this. */
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';
/** The response token Cloudflare's test site keys give, which the page's fake widget hands out. */
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
/** A token of the test's own (run.mjs) on which siteverify is down (fetch throws); any other token but the dummy is refused. */
const OFFLINE_TOKEN = 'XXXX.DUMMY.TOKEN.FORA';

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
  /** The API's answer to the POST. */
  status: number;
  /** The form ref the thank-you link carried after the code, or null. */
  ref: string | null;
  /** The visit id the page kept in sessionStorage, on every event beacon. */
  visit: string | null;
  /** The device the API should read from the run's user agent. */
  expect: { os: string; app: string } | null;
}

interface Report {
  /** How many forms the browser run meant to send, and how many it meant to have refused too. */
  planned: number;
  attempts: number;
  consentShown: string;
  submissions: Submission[];
}

/** One event beacon as the API logs it (site-events.ts): event, step, visit, UTMs and the device read from the user agent. */
type SiteEventLine = ReturnType<typeof siteEventLineOf>;

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
    const token = params.get('response');
    const call = {
      secretOk: params.get('secret') === TURNSTILE_TEST_SECRET,
      tokenOk: token === DUMMY_TOKEN,
    };
    captchaCalls.push(call);
    if (token === OFFLINE_TOKEN) throw new Error('siteverify down (e2e)');
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

  // What reached /public/*: method, status and the CORS answer; never a form's body.
  const calls: ApiCall[] = [];
  // The event beacons, as the API logs them: nothing personal is in one (site-events.ts).
  const siteEvents: SiteEventLine[] = [];
  api.addHook('onResponse', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/public/')) return;
    if (path === `${FORM_PATH}/events` && reply.statusCode === 204) {
      const event = siteEventSchema.safeParse(JSON.parse(String(request.body)));
      if (event.success) {
        siteEvents.push(siteEventLineOf(SLUG, event.data, request.headers['user-agent']));
      }
    }
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
  return { db: database.db, port: address.port, calls, siteEvents, captchaCalls, whatsappUrl };
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
  // the same phone sent twice is one lead (merged), so leads are counted by phone
  const phones = new Set(sent.map((submission) => submission.phone));
  check(
    `db: one lead per phone (${sent.length} sent, ${phones.size} phones, ${report.planned} planned)`,
    report.planned > 0 && sent.length === report.planned && rows.length === phones.size,
    `${rows.length} leads with landing_page ${SLUG}`,
  );
  // a refused send leaves nothing: no lead for its phone; the captcha refusals are in the audit log
  for (const refused of report.submissions.filter((submission) => !submission.sent)) {
    check(
      `db ${refused.label}: no lead for a send refused with ${refused.status}`,
      !rows.some((row) => row.phone === `55${refused.phone}`),
    );
  }
  const refusals = await db.query.auditLog.findMany({
    where: (entry, { eq }) => eq(entry.action, 'site_form.captcha_refused'),
  });
  const outcomes = refusals
    .map((entry) => (entry.metadata as { outcome?: string } | null)?.outcome ?? null)
    .sort();
  const expectedOutcomes = report.submissions
    .flatMap((s) => (s.status === 403 ? ['refused'] : s.status === 503 ? ['unavailable'] : []))
    .sort();
  check(
    `db: one site_form.captcha_refused audit entry per captcha refusal (${expectedOutcomes.join(', ')})`,
    JSON.stringify(outcomes) === JSON.stringify(expectedOutcomes),
    outcomes.join(', ') || 'none',
  );

  for (const submission of sent) {
    const label = `db ${submission.label} (${submission.answer})`;
    const matches = rows.filter((row) => row.phone === `55${submission.phone}`);
    const lead = matches[0];
    check(`${label}: exactly one lead for this phone`, matches.length === 1, `${matches.length}`);
    if (!lead) continue;
    // what this phone sent, in order: the first arrival sets the answer and the funnel, a later one
    // fills only the gaps (e-mail, Instagram...), and every arrival gives the lead a new form ref
    const sends = sent.filter((other) => other.phone === submission.phone);
    const first = sends[0] ?? submission;
    const last = sends[sends.length - 1] ?? submission;
    const expectedEmail = sends.find((other) => other.email)?.email ?? null;
    const expectedInstagram = sends.some((other) => other.instagramTyped) ? 'marca.teste' : null;
    const expected = EXPECTED_PIPELINE[first.answer];
    const ownPipeline = EXPECTED_PIPELINE[submission.answer];
    const option = spec.qualifierValues.find((entry) => entry.value === first.answer)?.option;
    const shown = spec.qualifierValues.find((entry) => entry.value === submission.answer)?.option;
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
      `${label}: Instagram kept as ${expectedInstagram ?? 'null (none typed)'}`,
      lead.instagram === expectedInstagram,
      `instagram ${lead.instagram ?? 'null'}`,
    );
    check(
      `${label}: e-mail kept as ${expectedEmail ? 'the one typed' : 'null (none typed)'}`,
      lead.email === expectedEmail,
      `e-mail ${lead.email ? 'set' : 'null'}`,
    );
    check(
      `${label}: form_answers holds the option's text under the question`,
      option !== undefined &&
        JSON.stringify(lead.formAnswers) === JSON.stringify({ [question]: option }),
      JSON.stringify(lead.formAnswers),
    );
    check(
      `${label}: the page shows the API's option text`,
      submission.answerText === shown,
      submission.answerText,
    );
    const events = await db.query.leadEvents.findMany({
      where: (event, { and, eq }) =>
        and(eq(event.leadId, lead.id), eq(event.kind, 'lead.received.site_form')),
    });
    const details = events.map((event) => (event.detail ?? {}) as Record<string, unknown>);
    check(
      `${label}: one lead.received.site_form event per send (${sends.length}), this send's with its code and funnel`,
      events.length === sends.length &&
        details.some(
          (detail) =>
            detail.qualifier === submission.answer && (detail.pipeline ?? null) === ownPipeline,
        ),
      JSON.stringify(details.map((d) => ({ qualifier: d.qualifier, pipeline: d.pipeline }))),
    );
    const merges = await db.query.auditLog.findMany({
      where: (entry, { and, eq }) =>
        and(eq(entry.entityId, lead.id), eq(entry.action, 'lead.merged')),
    });
    check(
      `${label}: ${sends.length - 1} lead.merged audit entries (one per repeat send)`,
      merges.length === sends.length - 1,
      `${merges.length}`,
    );
    if (sends.length > 1) {
      check(
        `${label}: the repeat send filled the gaps, e-mail among them`,
        details.some((detail) => Array.isArray(detail.filled) && detail.filled.includes('email')),
        JSON.stringify(details.map((d) => d.filled ?? null)),
      );
    }
    check(
      `${label}: this send got a ref, and the lead keeps the ref of this phone's last send (form_ref)`,
      submission.ref !== null &&
        last.ref !== null &&
        lead.formRef === last.ref &&
        lead.formRefAt !== null,
      lead.formRef === last.ref ? 'same ref' : 'different',
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

function checkCalls(calls: ApiCall[], pageOrigin: string, report: Report): void {
  const posts = report.attempts;
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
  // 200 for every sent form, and the refusal each failing run asked for; CORS on all of them
  const expectedStatuses = report.submissions.map((s) => s.status).sort();
  check(
    `api: the POSTs from the page answered ${expectedStatuses.join(' ')}, each with the page origin`,
    sends.length === posts &&
      JSON.stringify(sends.map((call) => call.status).sort()) ===
        JSON.stringify(expectedStatuses) &&
      sends.every(allowed),
    `${sends.length} POSTs: ${sends.map((call) => call.status).join(' ')}`,
  );
  // the page's server events (sendBeacon): at least page_view, form_view, form_start, submit_attempt and submit_ok/submit_error per run
  const events = calls.filter(
    (call) => call.browser && call.origin === pageOrigin && call.path === `${FORM_PATH}/events`,
  );
  check(
    'api: every event beacon from the page answered 204 with the page origin, five or more per run',
    events.length >= posts * 5 &&
      events.every((call) => call.method === 'POST' && call.status === 204 && allowed(call)),
    `${events.length} events: ${[...new Set(events.map((call) => call.status))].join(' ')}`,
  );
  check(
    'api: no answer allowed credentials',
    calls.every((call) => call.allowCredentials === null),
  );
}

/**
 * The server events of each run as the API kept them (one log line each): the
 * visit's funnel in order (sent: through submit_ok and the thank-you's WhatsApp
 * click; refused: submit_error with why, nothing after), form_view once, the
 * UTMs of the ad link, and the device the API read from the user agent: the
 * phone, its system and the Instagram browser when the run came from it.
 */
function checkSiteEvents(seen: SiteEventLine[], report: Report): void {
  for (const run of report.submissions) {
    const label = `events ${run.label}`;
    const own = seen.filter((line) => line.visit === run.visit);
    const names = own.map((line) => line.event);
    const count = (name: string) => names.filter((n) => n === name).length;
    const inOrder = (...expected: string[]) => {
      let at = 0;
      for (const name of names) if (name === expected[at]) at++;
      return at === expected.length;
    };
    const funnel = run.sent
      ? ['page_view', 'form_start', 'submit_attempt', 'submit_ok', 'whatsapp_click']
      : ['page_view', 'form_start', 'submit_attempt', 'submit_error'];
    check(
      `${label}: the API kept this visit's funnel in order (${funnel.join(', ')}), form_view once`,
      run.visit !== null &&
        inOrder(...funnel) &&
        count('page_view') === 1 &&
        count('form_view') === 1 &&
        count('submit_ok') === (run.sent ? 1 : 0),
      names.join(' ') || 'no event for this visit',
    );
    const errorSteps = own.filter((line) => line.event === 'submit_error').map((line) => line.step);
    const stepOf: Record<number, string> = { 400: 'validation', 403: 'captcha', 503: 'network' };
    const expectedSteps = run.sent ? [] : [stepOf[run.status] ?? null];
    check(
      `${label}: refusals counted with why (${expectedSteps.join(', ') || 'none'})`,
      JSON.stringify(errorSteps) === JSON.stringify(expectedSteps),
      errorSteps.join(' ') || 'none',
    );
    check(
      `${label}: every event carries the ad's UTMs and the device read from the user agent (phone, ${run.expect?.os}, ${run.expect?.app})`,
      own.length > 0 &&
        own.every(
          (line) =>
            line.utm_source === 'e2e' &&
            line.utm_campaign === 'lancamento' &&
            line.device === 'phone' &&
            line.os === run.expect?.os &&
            line.app === run.expect?.app,
        ),
      JSON.stringify(own[0] && { device: own[0].device, os: own[0].os, app: own[0].app }),
    );
  }
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
    check(
      `e2e: every run reported (${report.attempts} attempts, ${report.planned} to send)`,
      report.submissions.length === report.attempts &&
        report.submissions.filter((s) => s.sent).length === report.planned,
      `${report.submissions.length} reported, ${report.submissions.filter((s) => s.sent).length} sent`,
    );
    if (app) await checkConsentLine(app, report);
    await checkDatabase(api.db, report);
    checkCalls(api.calls, pageOrigin, report);
    checkSiteEvents(api.siteEvents, report);
    // the phone is checked after the captcha, so the 400 run spent a token too; only the two bad tokens fail
    const goodTokens = report.submissions.filter(
      (s) => s.status !== 403 && s.status !== 503,
    ).length;
    check(
      `api: Turnstile checked once per POST (${report.attempts}) with the test secret; ${goodTokens} dummy tokens passed`,
      api.captchaCalls.length === report.attempts &&
        api.captchaCalls.every((call) => call.secretOk) &&
        api.captchaCalls.filter((call) => call.tokenOk).length === goodTokens,
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
