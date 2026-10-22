// End-to-end check of the built landing pages in headless Chromium (no network).
//
//   pnpm --filter @wings/landing build && pnpm --filter @wings/landing test:e2e
//   DATABASE_URL=<local dev database> pnpm --filter @wings/landing test:e2e:api
//
// It serves dist/ on 127.0.0.1 with a tiny server that maps hosts and slugs and
// fills the runtime placeholders the way docker/landing-nginx.conf does, answers
// Google Tag Manager and Cloudflare Turnstile with local fakes, and fails on any
// other request that leaves the machine (Chromium cannot resolve any other host).
//
// Without API_BASE the API is mocked by the contract (`/public/site-forms/:slug`)
// and every POST body is checked against it. With API_BASE (a local API whose
// LANDING_ORIGINS lists http://127.0.0.1:$E2E_PORT; e2e/api-server.ts starts one
// and runs this file) the page talks to that API across origins: nothing on the
// way to it is intercepted, so the browser's own CORS preflight reaches the API.
// Each run then sends its own made-up person and answer, and E2E_REPORT, when
// set, receives what was sent so the caller can check what the API kept.
// E2E_EXPECT_WHATSAPP is the tracked link the API's GET is expected to hand out
// (the code alone); the POST's is the same with the lead's form ref after it.
// Screenshots go to E2E_SHOTS (default: a temporary folder).
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const DIST = resolve(root, 'dist');
const SLUG = 'fale-com-a-wings';
const GTM_ID = 'GTM-MXJLC5HH';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const CHROME =
  process.env.CHROME_PATH ||
  resolve(
    homedir(),
    '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  );
const SHOTS = process.env.E2E_SHOTS || join(tmpdir(), 'wings-landing-e2e');
const LIVE_API = process.env.API_BASE ? process.env.API_BASE.replace(/\/+$/, '') : null;
const EXPECT_WHATSAPP = process.env.E2E_EXPECT_WHATSAPP || null;
const REPORT = process.env.E2E_REPORT || null;
const TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
/** The only outside hosts the page asks for; both get a local fake. */
const FAKE_HOSTS = ['www.googletagmanager.com', 'challenges.cloudflare.com'];

/** The POST body's keys (API contract) and the tracking keys (SITE_FORM_TRACKING_KEYS). */
const CONTRACT_KEYS = new Set([
  'name',
  'phone',
  'email',
  'companyName',
  'instagram',
  'siteUrl',
  'qualifierAnswer',
  'consent',
  'page',
  'tracking',
  'turnstileToken',
  'website',
]);
const TRACKING_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'fbclid',
  'gbraid',
  'wbraid',
  'campaign_id',
  'campaignid',
  'gad_campaignid',
  'adset_id',
  'adgroupid',
  'ad_id',
  'creative',
  'hsa_cam',
  'hsa_grp',
  'hsa_ad',
  'referrer',
]);

/** The approved page's consent line, which the seeded spec carries as `consentText`. */
const CONSENT_TEXT =
  'Li a Política de Privacidade e autorizo a Wings a falar comigo por WhatsApp e e-mail sobre este pedido.';

/** The GET's link has the tracking code alone; the POST's adds the lead's form ref (`<code> <ref>`). */
const GET_WHATSAPP = 'https://wa.me/550000000000?text=E2EGET';
const POST_WHATSAPP = 'https://wa.me/550000000000?text=E2EGET%20REF234';
/** A tracking code and a form ref share the alphabet (no I, O, 0, 1) and the length. */
const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

/** The wa.me link's number path and its text's words, or null when it is not one. */
function waParts(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.hostname !== 'wa.me') return null;
    return { path: url.pathname, words: (url.searchParams.get('text') ?? '').split(' ') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- results

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.warn(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- static server (nginx's mapping)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function startServer({ port, hosts, rootSlugs, apiBase }) {
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (status, body = '', headers = {}) => {
      res.writeHead(status, { 'cache-control': 'no-cache', ...headers });
      res.end(body);
    };
    if (path === '/healthz') return send(200, 'ok\n', { 'content-type': 'text/plain' });
    if (!hosts.includes(host)) return send(404, 'not found');
    const page = (slug, pagePath) => {
      const file = join(DIST, slug, 'index.html');
      let html;
      try {
        html = readFileSync(file, 'utf8');
      } catch {
        return send(404, 'not found');
      }
      html = html
        .replaceAll('__LANDING_API_BASE__', apiBase)
        .replaceAll('__LANDING_GTM_ID__', GTM_ID)
        .replaceAll('__LANDING_ROBOTS__', 'noindex, nofollow')
        .replaceAll('__LANDING_ORIGIN__', `https://${host}`)
        .replaceAll('__LANDING_PAGE_URL__', `https://${host}${pagePath}`);
      return send(200, html, {
        'content-type': TYPES['.html'],
        'x-robots-tag': 'noindex, nofollow',
      });
    };
    if (path === '/') {
      const slug = rootSlugs[host];
      return slug ? page(slug, '/') : send(302, '', { location: 'https://wingscompany.com.br/' });
    }
    const slugMatch = /^\/([a-z0-9][a-z0-9-]{0,79})\/?$/.exec(path);
    if (slugMatch) return page(slugMatch[1], `/${slugMatch[1]}`);
    if (/^\/(assets|og)\/[^/]+$/.test(path)) {
      const file = join(DIST, path);
      try {
        const body = readFileSync(file);
        return send(200, body, {
          'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        });
      } catch {
        return send(404, 'not found');
      }
    }
    return send(404, 'not found');
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

// ---------------------------------------------------------------- fakes

const FAKE_GTM = `window.__fakeGtm = (window.__fakeGtm || 0) + 1;`;
const FAKE_TURNSTILE = `(() => {
  const widgets = new Map();
  let n = 0;
  const issue = (w) => setTimeout(() => w.opts.callback && w.opts.callback(${JSON.stringify(DUMMY_TOKEN)}), 150);
  window.__turnstile = { renders: 0, resets: 0, options: null };
  window.turnstile = {
    render(el, opts) {
      const id = 'fake-' + ++n;
      const box = document.createElement('div');
      box.className = 'fake-turnstile';
      box.style.cssText = 'width:100%;min-width:300px;height:65px;box-sizing:border-box;border:1px solid #d9d9d9;border-radius:4px;background:#fafafa;font:13px/65px sans-serif;text-align:center;color:#555';
      box.textContent = 'Turnstile (teste)';
      el.appendChild(box);
      const w = { el, box, opts };
      widgets.set(id, w);
      window.__turnstile.renders += 1;
      window.__turnstile.options = { sitekey: opts.sitekey, language: opts.language, size: opts.size };
      issue(w);
      return id;
    },
    reset(id) {
      const w = widgets.get(id);
      if (!w) return;
      window.__turnstile.resets += 1;
      issue(w);
    },
    remove(id) {
      const w = widgets.get(id);
      if (w) { w.box.remove(); widgets.delete(id); }
    },
    getResponse() { return ${JSON.stringify(DUMMY_TOKEN)}; },
  };
})();`;

/** What the page records before its own code runs: layout shifts, the first painted frame. */
const TIMELINE = () => {
  const t = {
    cls: 0,
    shifts: [],
    firstPaint: null,
    snapAt: null,
    visible: [],
    jsAtFirstFrame: null,
  };
  window.__e2e = t;
  const name = (node) =>
    node && node.nodeType === 1
      ? node.tagName.toLowerCase() +
        (node.id ? '#' + node.id : '') +
        (node.classList.length ? '.' + [...node.classList].join('.') : '')
      : String(node && node.nodeName);
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      t.cls += e.value;
      t.shifts.push({
        value: Number(e.value.toFixed(4)),
        at: Math.round(e.startTime),
        sources: (e.sources || []).map(
          (s) =>
            `${name(s.node)} y${Math.round(s.previousRect.y)}→${Math.round(s.currentRect.y)} h${Math.round(s.previousRect.height)}→${Math.round(s.currentRect.height)}`,
        ),
      });
    }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name === 'first-paint') t.firstPaint = e.startTime;
  }).observe({ type: 'paint', buffered: true });
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    );
  };
  const snap = () => {
    if (!document.body) return requestAnimationFrame(snap);
    t.snapAt = performance.now();
    t.jsAtFirstFrame = document.documentElement.classList.contains('js');
    t.missingAtFirstFrame = document.getElementById('f-missing')?.textContent ?? null;
    t.fontsAtFirstFrame = [...document.fonts].map((f) => `${f.family}:${f.status}`).join(' ');
    t.fontsReadyAtFirstFrame = ['Limelight', 'Nunito'].every((family) =>
      [...document.fonts].some(
        (f) => f.family.replace(/"/g, '') === family && f.status === 'loaded',
      ),
    );
    t.visible = [...document.body.querySelectorAll('*')].filter(shown);
    t.describe = name;
    t.shown = shown;
  };
  requestAnimationFrame(snap);
};

// ---------------------------------------------------------------- mock API (contract)

function contractProblems(body, href) {
  const problems = [];
  if (!body || typeof body !== 'object') return ['body is not an object'];
  for (const key of Object.keys(body))
    if (!CONTRACT_KEYS.has(key)) problems.push(`unknown key ${key}`);
  if (typeof body.name !== 'string' || body.name.trim().length < 2) problems.push('name');
  if (typeof body.phone !== 'string' || !/^\d{10,11}$/.test(body.phone))
    problems.push('phone digits');
  if (body.consent !== true) problems.push('consent');
  if (body.turnstileToken !== DUMMY_TOKEN) problems.push('turnstileToken');
  if (typeof body.website !== 'string') problems.push('website (honeypot) not sent as is');
  if (body.instagram !== undefined && !/^[a-z0-9._]{1,30}$/.test(body.instagram))
    problems.push('instagram');
  if (body.siteUrl !== undefined && !/^https?:\/\//.test(body.siteUrl)) problems.push('siteUrl');
  if (body.page !== href.split('#')[0]) problems.push(`page ${body.page}`);
  if (body.tracking !== undefined) {
    for (const [key, value] of Object.entries(body.tracking)) {
      if (!TRACKING_KEYS.has(key)) problems.push(`tracking key ${key}`);
      if (typeof value !== 'string' || value.length > 500) problems.push(`tracking value ${key}`);
    }
  }
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.length > 4096) problems.push(`long ${key}`);
  }
  return problems;
}

const CORS = (origin) => ({
  'access-control-allow-origin': origin,
  vary: 'Origin',
});

function mockApi({ apiBase, pageOrigin, posts, replies, events }) {
  const formUrl = `${apiBase}/public/site-forms/${SLUG}`;
  const eventsUrl = `${formUrl}/events`;
  return async (route, request) => {
    const method = request.method();
    // the page's server events (sendBeacon, text/plain): kept, answered 204 like the API
    if (request.url() === eventsUrl) {
      let event;
      try {
        event = JSON.parse(request.postData() ?? 'null');
      } catch {
        event = 'not JSON';
      }
      events.push({ method, contentType: request.headers()['content-type'] ?? '', event });
      return route.fulfill({ status: 204, headers: CORS(pageOrigin) });
    }
    if (method === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          ...CORS(pageOrigin),
          'access-control-allow-methods': 'GET, POST',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        },
      });
    }
    if (request.url() !== formUrl) {
      return route.fulfill({
        status: 404,
        headers: CORS(pageOrigin),
        json: { error: 'not_found' },
      });
    }
    if (method === 'GET') {
      return route.fulfill({
        status: 200,
        headers: CORS(pageOrigin),
        json: {
          slug: SLUG,
          brand: 'Wings Company',
          turnstileSiteKey: '1x00000000000000000000AA',
          instagram: '@wings.companybr',
          pipeline: 'formatacao',
          tracking: { metaPixelId: null, googleAdsConversion: null },
          whatsappUrl: GET_WHATSAPP,
          form: {
            qualifier: {
              question: 'O que você procura?',
              options: [
                'Transformar meu negócio em franquia',
                'Expandir minha rede de franquias',
                'Consultoria para o meu negócio',
                'Ainda não sei',
              ],
            },
            qualifierValues: [
              { value: 'formatacao', option: 'Transformar meu negócio em franquia' },
              { value: 'expansao', option: 'Expandir minha rede de franquias' },
              { value: 'consultoria', option: 'Consultoria para o meu negócio' },
              { value: 'nao-sei', option: 'Ainda não sei' },
            ],
            requiredFields: ['email', 'companyName', 'instagram', 'qualifierAnswer'],
            consentText: CONSENT_TEXT,
            privacyPolicyUrl: 'https://wingscompany.com.br/politica-de-privacidade/',
            thankYou: {
              title: 'Obrigado! A Wings vai falar com você.',
              body: 'Um consultor entra em contato.',
              buttonText: 'Chamar no WhatsApp',
              buttonUrl: 'https://wingscompany.com.br/',
            },
          },
        },
      });
    }
    if (method === 'POST') {
      let body;
      try {
        body = JSON.parse(request.postData() ?? 'null');
      } catch {
        body = 'not JSON';
      }
      posts.push(body);
      const next = replies.shift() ?? {
        status: 200,
        json: { ok: true, whatsappUrl: POST_WHATSAPP },
      };
      return route.fulfill({ status: next.status, headers: CORS(pageOrigin), json: next.json });
    }
    return route.fulfill({ status: 405, headers: CORS(pageOrigin), json: { error: 'method' } });
  };
}

// ---------------------------------------------------------------- one page run

/** What a run types: made-up person, company and answer. */
const PERSON = {
  name: 'Pessoa de Teste',
  phone: '21900000000',
  email: 'pessoa.teste@exemplo.com.br',
  company: 'Empresa Exemplo',
  instagram: '@Marca.Teste',
  site: 'www.exemplo.com.br',
  answer: 'formatacao',
};

/** Against a real API every run is another person (another lead) with another answer. */
const LIVE_PEOPLE = {
  'desktop-1440': { ...PERSON, phone: '21900000001', email: 'pessoa.um@exemplo.com.br' },
  'phone-390': {
    ...PERSON,
    phone: '21900000002',
    email: 'pessoa.dois@exemplo.com.br',
    instagram: 'https://instagram.com/marca.teste/',
    answer: 'expansao',
  },
  'nao-sei-1440': {
    ...PERSON,
    phone: '21900000003',
    email: 'pessoa.tres@exemplo.com.br',
    answer: 'nao-sei',
  },
};

/** What each run sent, for E2E_REPORT. */
const submissions = [];
let consentShown = '';

async function fillForm(page, person, label) {
  await page.fill('#f-nome', person.name);
  await page.click('#f-tel');
  await page.keyboard.type(person.phone);
  await page.selectOption('#f-int', person.answer);
  await page.check('#f-consent');
  // the short form (22/10): the three answers and the consent are enough, the optional block still closed
  await page
    .waitForFunction(() => !document.getElementById('f-send').disabled, null, { timeout: 5000 })
    .catch(() => {});
  const short = await page.evaluate(() => ({
    disabled: document.getElementById('f-send').disabled,
    missing: document.getElementById('f-missing').textContent,
    open: document.getElementById('f-more').open,
  }));
  check(
    `${label}: name, WhatsApp, the answer and the consent alone turn the button on (optional block closed)`,
    !short.disabled && short.missing === 'Tudo certo. Pode enviar.' && !short.open,
    short.missing,
  );
  // then the optional block, opened and filled, so the POST and the database are checked with everything
  await page.click('#f-more summary');
  await page.fill('#f-email', person.email);
  await page.fill('#f-empresa', person.company);
  await page.fill('#f-ig', person.instagram);
  await page.focus('#f-site');
  await page.fill('#f-site', person.site);
}

/**
 * Against a real API nothing is intercepted on the way to it (an intercepted
 * preflight would be answered by Playwright itself, never reaching the API):
 * only the two outside scripts are answered with fakes, through the DevTools
 * protocol, and any other outside request fails to resolve (launch flag).
 */
async function fakeOutsideScripts(context, page, gtmRequests) {
  const cdp = await context.newCDPSession(page);
  cdp.on('Fetch.requestPaused', (event) => {
    const url = new URL(event.request.url);
    const gtm = url.hostname === 'www.googletagmanager.com';
    if (gtm) gtmRequests.push(url.href);
    cdp
      .send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }],
        body: Buffer.from(gtm ? FAKE_GTM : FAKE_TURNSTILE).toString('base64'),
      })
      .catch(() => {});
  });
  await cdp.send('Fetch.enable', {
    patterns: FAKE_HOSTS.map((host) => ({
      urlPattern: `https://${host}/*`,
      requestStage: 'Request',
    })),
  });
}

async function runViewport(
  browser,
  { label, viewport, mobile, port, apiBase, replies = [], person = PERSON },
) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'pt-BR',
  });
  const pageOrigin = `http://127.0.0.1:${port}`;
  const outside = [];
  const posts = [];
  /** The server events the page sent (mock only): method, content type and body. */
  const events = [];
  const gtmRequests = [];
  const errorReplies = replies.map((reply) => reply.expect);
  // why each refused send is counted on the server (the mock consumes `replies` as it answers)
  const errorSteps = replies.map(
    (reply) =>
      ({ 400: 'validation', 403: 'captcha', 429: 'rate_limited' })[reply.status] ?? 'network',
  );
  const liveOrigin = LIVE_API ? new URL(LIVE_API).origin : null;
  /** The real API's answers to the page: method, status and the CORS headers the browser accepted. */
  const apiAnswers = [];
  if (!LIVE_API) {
    const api = mockApi({ apiBase, pageOrigin, posts, replies, events });
    await context.route('**/*', async (route, request) => {
      const url = new URL(request.url());
      if (url.origin === pageOrigin) return route.continue();
      if (url.hostname === 'www.googletagmanager.com') {
        gtmRequests.push(url.href);
        return route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: FAKE_GTM,
        });
      }
      if (url.hostname === 'challenges.cloudflare.com') {
        return route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: FAKE_TURNSTILE,
        });
      }
      if (url.href.startsWith(apiBase + '/')) return api(route, request);
      outside.push(url.href);
      return route.abort();
    });
  }
  await context.addInitScript(TIMELINE);
  const page = await context.newPage();
  if (LIVE_API) {
    await fakeOutsideScripts(context, page, gtmRequests);
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return;
      if (url.origin === pageOrigin || url.origin === liveOrigin) return;
      if (FAKE_HOSTS.includes(url.hostname)) return;
      outside.push(url.href);
    });
    page.on('response', (response) => {
      if (new URL(response.url()).origin !== liveOrigin) return;
      const headers = response.headers();
      apiAnswers.push({
        method: response.request().method(),
        path: new URL(response.url()).pathname,
        status: response.status(),
        allowOrigin: headers['access-control-allow-origin'] ?? null,
        credentials: headers['access-control-allow-credentials'] ?? null,
      });
    });
  }
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // Chrome logs every non-2xx fetch; the error run asks the mock API for those on purpose
    const expected =
      errorReplies.length > 0 &&
      msg.text().startsWith('Failed to load resource: the server responded with a status of') &&
      (msg.location().url ?? '').startsWith(apiBase + '/');
    if (!expected) errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  const href = `${pageOrigin}/?utm_source=e2e&utm_campaign=lancamento&gclid=TESTE123&utm_id=9&ttclid=x`;
  await page.goto(href, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__e2e && window.__e2e.snapAt !== null, null, {
    timeout: 15000,
  });
  await page.screenshot({ path: join(SHOTS, `${label}-first-paint.png`) });
  await page.waitForFunction(() => performance.now() >= window.__e2e.snapAt + 1500, null, {
    timeout: 15000,
  });
  await page.screenshot({ path: join(SHOTS, `${label}-after-1500ms.png`) });

  const timeline = await page.evaluate(() => {
    const t = window.__e2e;
    const hiddenLater = t.visible
      .filter((el) => el.isConnected && !t.shown(el))
      .map((el) => t.describe(el));
    return {
      cls: t.cls,
      shifts: t.shifts,
      jsAtFirstFrame: t.jsAtFirstFrame,
      missingAtFirstFrame: t.missingAtFirstFrame,
      fontsAtFirstFrame: t.fontsAtFirstFrame,
      fontsReadyAtFirstFrame: t.fontsReadyAtFirstFrame,
      hiddenLater,
      visibleCount: t.visible.length,
    };
  });
  check(
    `${label}: first frame drawn after the page's code ran (blocking=render)`,
    timeline.jsAtFirstFrame,
  );
  check(
    `${label}: first frame already has Limelight and Nunito`,
    timeline.fontsReadyAtFirstFrame,
    timeline.fontsAtFirstFrame,
  );
  check(
    `${label}: layout shift < 0.02 in the first 1.5 s`,
    timeline.cls < 0.02,
    `CLS ${timeline.cls.toFixed(4)}${timeline.shifts.length ? ' ' + JSON.stringify(timeline.shifts) + ' fonts at first frame: ' + timeline.fontsAtFirstFrame : ''}`,
  );
  check(
    `${label}: nothing visible in the first frame is hidden later`,
    timeline.hiddenLater.length === 0,
    timeline.hiddenLater.join(', ') || `${timeline.visibleCount} elements checked`,
  );
  check(
    `${label}: first frame asks for the robot check`,
    (timeline.missingAtFirstFrame ?? '').includes('verificação antirrobô'),
    timeline.missingAtFirstFrame ?? 'no line',
  );

  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    h1: document.querySelectorAll('h1').length,
    sections: document.querySelectorAll('section').length,
    robots: document.querySelector('meta[name="robots"]')?.content,
    ogImage: document.querySelector('meta[property="og:image"]')?.content,
    logos: [document.querySelector('.top-logo'), document.querySelector('.foot a:has(img)')].map(
      (a) => a && { href: a.getAttribute('href'), target: a.getAttribute('target') },
    ),
    noGl: document.documentElement.classList.contains('no-gl'),
    noFa: document.documentElement.classList.contains('no-fa'),
    scene: typeof window.__wings3d === 'function' ? window.__wings3d() : null,
    phonePoses: [...document.querySelectorAll('[data-form]')].map((el) => el.dataset.n ?? ''),
    disabled: document.getElementById('f-send').disabled,
    missing: document.getElementById('f-missing').textContent,
  }));
  check(
    `${label}: no horizontal scroll`,
    layout.scrollWidth === layout.innerWidth,
    `${layout.scrollWidth} vs ${layout.innerWidth}`,
  );
  check(
    `${label}: one h1 and six sections`,
    layout.h1 === 1 && layout.sections === 6,
    `${layout.h1} h1, ${layout.sections} sections`,
  );
  check(
    `${label}: top and footer logos go to the site, same tab`,
    layout.logos.every(
      (logo) => logo?.href === 'https://wingscompany.com.br/' && logo.target === null,
    ),
    JSON.stringify(layout.logos),
  );
  check(
    `${label}: robots from the runtime config`,
    layout.robots === 'noindex, nofollow',
    layout.robots,
  );
  check(
    `${label}: og:image absolute on this host`,
    layout.ogImage === `https://127.0.0.1/og/${SLUG}.png`,
    layout.ogImage,
  );
  check(
    `${label}: 3D scene running (WebGL)`,
    !layout.noGl && layout.scene && layout.scene.pontos > 0,
    JSON.stringify(
      layout.scene && { particulas: layout.scene.particulas, pontos: layout.scene.pontos },
    ),
  );
  check(
    `${label}: resolution brake only on a phone, ladder from at most 2x`,
    layout.scene &&
      layout.scene.freio === (mobile && layout.scene.degraus.length > 1) &&
      layout.scene.degraus[0] <= 2,
    JSON.stringify(layout.scene && { degraus: layout.scene.degraus, freio: layout.scene.freio }),
  );
  check(
    `${label}: every scene section has a phone placement (x, y, scale, alpha)`,
    layout.phonePoses.length === 6 &&
      layout.phonePoses.every((n) => /^(-?\d+(\.\d+)?,){3}-?\d+(\.\d+)?$/.test(n)),
    layout.phonePoses.join(' | '),
  );
  check(`${label}: social icon font loaded`, !layout.noFa);
  check(`${label}: send button off at start`, layout.disabled);
  const items = ['nome', 'WhatsApp', 'o que você procura', 'aceite da política'];
  check(
    `${label}: missing line lists the required items only (no e-mail, company or Instagram)`,
    layout.missing.startsWith('Para enviar, falta: ') &&
      items.every((item) => layout.missing.includes(item)) &&
      !/e-mail|empresa|Instagram/.test(layout.missing),
    layout.missing,
  );
  check(
    `${label}: GTM loaded with the runtime id`,
    gtmRequests.some((u) => u.includes(`id=${GTM_ID}`)),
    gtmRequests.join(' '),
  );

  const turnstile = await page.evaluate(() => window.__turnstile);
  check(
    `${label}: Turnstile rendered explicitly with the API's key`,
    turnstile &&
      turnstile.renders === 1 &&
      turnstile.options.language === 'pt-BR' &&
      turnstile.options.sitekey === TURNSTILE_SITE_KEY,
    JSON.stringify(turnstile),
  );

  // the GET's tracked link: the mock's, or the one the real API was seeded with
  const getWhatsapp = LIVE_API ? EXPECT_WHATSAPP : GET_WHATSAPP;
  const wa = await page.$$eval('[data-wa]', (links) =>
    links
      .filter((a) => !a.closest('#thanks'))
      .map((a) => [a.getAttribute('href'), a.target, a.rel]),
  );
  check(
    `${label}: WhatsApp buttons open the GET's tracked link`,
    wa.length === 2 &&
      wa.every(
        ([h, t, r]) =>
          (getWhatsapp ? h === getWhatsapp : /^https:\/\/wa\.me\//.test(h ?? '')) &&
          t === '_blank' &&
          r === 'noopener',
      ),
    JSON.stringify(wa),
  );
  // before the form there is no lead yet: the text is the code alone, no ref
  const getParts = waParts(wa[0]?.[0] ?? '');
  check(
    `${label}: the GET's link text is the tracking code only`,
    getParts !== null && getParts.words.length === 1 && CODE_RE.test(getParts.words[0]),
    JSON.stringify(getParts?.words),
  );
  consentShown = await page.$eval('label.consent', (el) =>
    el.textContent.replace(/\s+/g, ' ').trim(),
  );
  // the line the lead keeps (the spec's consentText); against the real API, api-server.ts checks it
  check(
    `${label}: consent label is the spec's consentText`,
    consentShown === CONSENT_TEXT,
    consentShown,
  );

  await fillForm(page, person, label);
  await page
    .waitForFunction(() => !document.getElementById('f-send').disabled, null, { timeout: 5000 })
    .catch(() => {});
  const ready = await page.evaluate(() => ({
    disabled: document.getElementById('f-send').disabled,
    missing: document.getElementById('f-missing').textContent,
    instagram: document.getElementById('f-ig').value,
    phone: document.getElementById('f-tel').value,
  }));
  check(
    `${label}: everything filled turns the button on`,
    !ready.disabled && ready.missing === 'Tudo certo. Pode enviar.',
    `${ready.missing} | tel ${ready.phone} | ig ${ready.instagram}`,
  );
  check(
    `${label}: Instagram keeps only the username`,
    ready.instagram === 'marca.teste',
    ready.instagram,
  );

  // the error answers keep the data and say why (mock only)
  for (const expected of errorReplies) {
    await page.click('#f-send');
    await page
      .waitForFunction(
        (text) => document.getElementById('f-error').textContent === text,
        expected,
        {
          timeout: 5000,
        },
      )
      .catch(() => {});
    const after = await page.evaluate(() => ({
      error: document.getElementById('f-error').textContent,
      formHidden: document.getElementById('lead-form').hidden,
      name: document.getElementById('f-nome').value,
    }));
    check(
      `${label}: error answer shown, data kept (${expected})`,
      after.error === expected && !after.formHidden && after.name === person.name,
      after.error,
    );
    await page
      .waitForFunction(() => !document.getElementById('f-send').disabled, null, { timeout: 5000 })
      .catch(() => {});
  }

  await page.click('#f-send');
  await page
    .waitForFunction(() => !document.getElementById('thanks').hidden, null, { timeout: 10000 })
    .catch(() => {});
  const answerText = await page.$eval('#f-int', (select) =>
    (select.selectedOptions[0]?.textContent ?? '').trim(),
  );
  const done = await page.evaluate(() => {
    const thanks = document.getElementById('thanks');
    const button = thanks.querySelector('[data-wa]');
    return {
      thanksShown: !thanks.hidden && thanks.getBoundingClientRect().height > 0,
      formHidden: document.getElementById('lead-form').hidden,
      href: button?.getAttribute('href') ?? null,
      buttonHidden: button?.hidden ?? null,
      previewNote: Boolean(thanks.querySelector('.pvn')),
      events: (window.dataLayer || []).filter((e) => e && e.event === 'lead_submit'),
    };
  });
  check(
    `${label}: thank-you shown, form hidden`,
    done.thanksShown && done.formHidden && !done.previewNote,
  );
  // the POST's link: the same number and code as the GET's, then the ref the lead got (`<code> <ref>`)
  const postParts = waParts(done.href ?? '');
  const [postCode, postRef] = postParts?.words ?? [];
  check(
    `${label}: thank-you link text is "<code> <ref>", the GET's code and a 6-character ref`,
    !done.buttonHidden &&
      postParts !== null &&
      getParts !== null &&
      postParts.path === getParts.path &&
      postParts.words.length === 2 &&
      CODE_RE.test(postCode ?? '') &&
      CODE_RE.test(postRef ?? '') &&
      postCode === getParts.words[0],
    JSON.stringify(postParts?.words),
  );
  if (LIVE_API) {
    submissions.push({
      label,
      answer: person.answer,
      answerText,
      instagramTyped: person.instagram,
      email: person.email,
      phone: person.phone,
      sent: done.thanksShown,
      ref: postRef ?? null,
    });
    check(
      `${label}: thank-you button opens the POST's link (the GET's plus the ref)`,
      EXPECT_WHATSAPP
        ? done.href === `${EXPECT_WHATSAPP}%20${postRef}` && !done.buttonHidden
        : done.buttonHidden || /^https:\/\/wa\.me\//.test(done.href ?? ''),
      done.href ?? 'hidden',
    );
    // the form's own calls; the event beacons (`/events`) are checked apart
    const fromApi = (method) =>
      apiAnswers.filter((answer) => answer.method === method && !answer.path.endsWith('/events'));
    const beacons = apiAnswers.filter((answer) => answer.path.endsWith('/events'));
    check(
      `${label}: event beacons answered 204 by the API across origins (five or more)`,
      beacons.length >= 5 &&
        beacons.every(
          (answer) =>
            answer.method === 'POST' &&
            answer.status === 204 &&
            answer.allowOrigin === pageOrigin &&
            answer.credentials === null,
        ),
      `${beacons.length} beacons: ${[...new Set(beacons.map((answer) => answer.status))].join(' ')}`,
    );
    const crossed = (answers) =>
      answers.length > 0 &&
      answers.every(
        (answer) =>
          answer.status === 200 && answer.allowOrigin === pageOrigin && answer.credentials === null,
      );
    check(
      `${label}: GET answered by the API across origins (CORS for this origin, no credentials)`,
      crossed(fromApi('GET')),
      JSON.stringify(fromApi('GET')),
    );
    check(
      `${label}: POST answered by the API across origins (after the browser's preflight)`,
      crossed(fromApi('POST')) && fromApi('POST').length === 1,
      JSON.stringify(fromApi('POST')),
    );
  } else {
    check(
      `${label}: thank-you button opens the POST's link`,
      done.href === POST_WHATSAPP && !done.buttonHidden,
      done.href ?? 'none',
    );
    const last = posts.at(-1);
    const problems = contractProblems(last, href);
    check(
      `${label}: POST body follows the contract`,
      problems.length === 0,
      problems.join('; ') || JSON.stringify(Object.keys(last ?? {})),
    );
    check(
      `${label}: POST carries the cleaned answers and the first touch`,
      last &&
        last.instagram === 'marca.teste' &&
        last.siteUrl === 'https://www.exemplo.com.br' &&
        last.qualifierAnswer === person.answer &&
        last.phone === person.phone &&
        last.tracking?.utm_source === 'e2e' &&
        last.tracking?.gclid === 'TESTE123' &&
        !('utm_id' in (last.tracking ?? {})),
      JSON.stringify(last?.tracking),
    );
    check(`${label}: POSTs sent`, posts.length === errorReplies.length + 1, `${posts.length}`);
  }
  check(
    `${label}: dataLayer lead_submit with the interest and origin`,
    done.events.length === 1 &&
      done.events[0].interesse === person.answer &&
      done.events[0].origem?.utm_source === 'e2e',
    JSON.stringify(done.events),
  );

  if (!LIVE_API) await checkServerEvents(page, { label, events, errorSteps, person });

  check(`${label}: no console error or page error`, errors.length === 0, errors.join(' | '));
  check(`${label}: no request left the machine`, outside.length === 0, outside.join(' '));
  await context.close();
}

/**
 * The server events (sendBeacon to `/events`, mock only): the funnel of the run
 * in order, each refused send with why, the thank-you's WhatsApp click (its
 * navigation held back: wa.me is outside), one visit id, the UTMs and nothing
 * of the person.
 */
async function checkServerEvents(page, { label, events, errorSteps: expectedSteps, person }) {
  await page.evaluate(() => {
    document.addEventListener('click', (e) => e.preventDefault(), { capture: true, once: true });
    document.querySelector('#thanks [data-wa]')?.click();
  });
  // beacons are queued by the browser and reach the mock a moment later
  for (let i = 0; i < 30 && !events.some((e) => e.event?.event === 'whatsapp_click'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const names = events.map((e) => e.event?.event);
  const count = (name) => names.filter((n) => n === name).length;
  const inOrder = (...expected) => {
    let at = 0;
    for (const name of names) if (name === expected[at]) at++;
    return at === expected.length;
  };
  check(
    `${label}: server events in order: page_view, form_start, submit_attempt, submit_ok, whatsapp_click; form_view once before the send`,
    inOrder('page_view', 'form_start', 'submit_attempt', 'submit_ok', 'whatsapp_click') &&
      count('page_view') === 1 &&
      count('form_start') === 1 &&
      count('form_view') === 1 &&
      names.indexOf('form_view') < names.indexOf('submit_attempt'),
    names.join(' '),
  );
  const errorSteps = events
    .filter((e) => e.event?.event === 'submit_error')
    .map((e) => e.event.step);
  check(
    `${label}: each refused send counted with why (${expectedSteps.join(', ') || 'none'}), one attempt per click`,
    JSON.stringify(errorSteps) === JSON.stringify(expectedSteps) &&
      count('submit_attempt') === expectedSteps.length + 1 &&
      count('submit_ok') === 1,
    `${errorSteps.join(' ')} | ${count('submit_attempt')} attempts`,
  );
  const thanksClick = events.find((e) => e.event?.event === 'whatsapp_click');
  const dataLayerClicks = await page.evaluate(
    () => (window.dataLayer || []).filter((e) => e && e.event === 'whatsapp_click').length,
  );
  check(
    `${label}: the thank-you's WhatsApp click counted on the server (step thanks) and in the dataLayer`,
    thanksClick?.event.step === 'thanks' && dataLayerClicks === 1,
    `${JSON.stringify(thanksClick?.event)} | dataLayer ${dataLayerClicks}`,
  );
  const visits = [...new Set(events.map((e) => e.event?.visit))];
  const text = JSON.stringify(events);
  check(
    `${label}: server events are text/plain POST beacons with one visit id, the UTMs and nothing of the person`,
    events.length > 0 &&
      events.every((e) => e.method === 'POST' && e.contentType.startsWith('text/plain')) &&
      visits.length === 1 &&
      /^[a-z0-9]{8,32}$/.test(visits[0] ?? '') &&
      events.every(
        (e) =>
          e.event.utm_source === 'e2e' &&
          e.event.utm_campaign === 'lancamento' &&
          e.event.utm_id === '9' &&
          !('gclid' in e.event),
      ) &&
      !text.includes(person.name) &&
      !text.includes(person.phone) &&
      !text.includes(person.email),
    `${events.length} events, visit ${visits.join(',')}`,
  );
}

// ---------------------------------------------------------------- static checks of dist

function distFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? distFiles(path) : [path];
  });
}

function staticChecks() {
  const files = distFiles(DIST);
  const text = files
    .filter((file) => /\.(html|js|css)$/.test(file))
    .map((file) => [file, readFileSync(file, 'utf8')]);
  const phones = text.filter(([, body]) =>
    /wa\.me\/\d|api\.whatsapp\.com\/send\?phone=|\b55\d{10,11}\b/.test(body),
  );
  check(
    'dist: no phone number or WhatsApp number in HTML/JS/CSS',
    phones.length === 0,
    phones.map(([f]) => f).join(' '),
  );
  const zod = text.filter(([file, body]) => file.endsWith('.js') && /\bZodError\b|zod/.test(body));
  check(
    'dist: the page bundles no zod (only @wings/shared/instagram)',
    zod.length === 0,
    zod.map(([f]) => f).join(' '),
  );
  // the style sheets are split (the embed's own, the one the page and the embed share): all of them
  const css = text
    .filter(([file]) => file.endsWith('.css'))
    .map(([, body]) => body)
    .join('\n');
  check(
    'dist: licence comment kept in the CSS',
    /\/\*![^*]*CC BY 4\.0[^*]*SIL OFL 1\.1 \*\//.test(css),
  );
  check(
    'dist: OG image present',
    files.some((file) => file.endsWith(`og/${SLUG}.png`)),
  );
  const html = readFileSync(join(DIST, SLUG, 'index.html'), 'utf8');
  const preload = (html.match(/<link\b[^>]*>/g) ?? []).find((tag) => /rel="preload"/.test(tag));
  check(
    'dist: page has the preload for the icon font',
    Boolean(preload) &&
      /href="\/assets\/fa-brands-400-[^"]+\.woff2"/.test(preload) &&
      /as="font"/.test(preload) &&
      /type="font\/woff2"/.test(preload) &&
      /\bcrossorigin\b/.test(preload),
    preload?.replace(/\s+/g, ' '),
  );
  check(
    'dist: no preview leftovers',
    !/data-fundo|class="pv"|class="toast"|class="pvn"|Prévia/.test(html),
  );
}

// ---------------------------------------------------------------- the real API's CORS, over plain HTTP

function rawRequest(url, { method, headers, body }) {
  return new Promise((ok, fail) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      response.resume();
      response.on('end', () => ok({ status: response.statusCode, headers: response.headers }));
    });
    request.on('error', fail);
    request.end(body);
  });
}

/** What the browser cannot show: the preflight's own answer, and what an unlisted origin gets. */
async function liveCorsChecks(pageOrigin) {
  const formUrl = `${LIVE_API}/public/site-forms/${SLUG}`;
  const FOREIGN = 'https://outro-site.example';
  const preflight = (url, origin) =>
    rawRequest(url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
  const brief = (answer) =>
    JSON.stringify({
      status: answer.status,
      ...Object.fromEntries(
        Object.entries(answer.headers).filter(([name]) => /^access-control-|^vary$/.test(name)),
      ),
    });
  const listed = await preflight(formUrl, pageOrigin);
  check(
    'api: preflight from the page origin answers 204 with the CORS headers',
    listed.status === 204 &&
      listed.headers['access-control-allow-origin'] === pageOrigin &&
      listed.headers['access-control-allow-methods'] === 'GET, POST' &&
      listed.headers['access-control-allow-headers'] === 'content-type' &&
      listed.headers['access-control-max-age'] === '600' &&
      /\borigin\b/i.test(listed.headers.vary ?? '') &&
      !('access-control-allow-credentials' in listed.headers),
    brief(listed),
  );
  const foreign = await preflight(formUrl, FOREIGN);
  check(
    'api: preflight from an unlisted origin is refused',
    foreign.status === 403 && !('access-control-allow-origin' in foreign.headers),
    brief(foreign),
  );
  const foreignPost = await rawRequest(formUrl, {
    method: 'POST',
    headers: { origin: FOREIGN, 'content-type': 'application/json' },
    body: '{}',
  });
  check(
    'api: POST from an unlisted origin is refused (CSRF), nothing opened',
    foreignPost.status === 403 && !('access-control-allow-origin' in foreignPost.headers),
    brief(foreignPost),
  );
  const outsidePublic = await preflight(`${LIVE_API}/auth/login`, pageOrigin);
  check(
    'api: the page origin gets no CORS outside /public/',
    !('access-control-allow-origin' in outsidePublic.headers),
    brief(outsidePublic),
  );
}

// ---------------------------------------------------------------- main

mkdirSync(SHOTS, { recursive: true });
staticChecks();
const port = Number(process.env.E2E_PORT) || 20000 + Math.floor(Math.random() * 20000);
// The mock API lives on another local origin, so the page calls it across origins (CORS) as in production.
const apiBase = LIVE_API ?? `http://localhost:${port}/api`;
const server = await startServer({
  port,
  hosts: ['127.0.0.1'],
  rootSlugs: { '127.0.0.1': SLUG },
  apiBase,
});
const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    // nothing but this machine resolves; the two outside scripts are answered before any lookup
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
  ],
});
const DESKTOP = { viewport: { width: 1440, height: 900 }, mobile: false };
const PHONE = { viewport: { width: 390, height: 844 }, mobile: true };
try {
  if (LIVE_API) {
    await liveCorsChecks(`http://127.0.0.1:${port}`);
    for (const [label, size] of [
      ['desktop-1440', DESKTOP],
      ['phone-390', PHONE],
      ['nao-sei-1440', DESKTOP],
    ]) {
      await runViewport(browser, { label, ...size, port, apiBase, person: LIVE_PEOPLE[label] });
    }
  } else {
    await runViewport(browser, { label: 'desktop-1440', ...DESKTOP, port, apiBase });
    await runViewport(browser, { label: 'phone-390', ...PHONE, port, apiBase });
    await runViewport(browser, {
      label: 'errors-1440',
      ...DESKTOP,
      port,
      apiBase,
      replies: [
        {
          status: 400,
          json: { error: 'invalid_request', message: 'Informe o seu e-mail.' },
          expect: 'Informe o seu e-mail.',
        },
        {
          status: 403,
          json: { error: 'captcha_refused' },
          expect: 'A verificação antirrobô não passou. Faça a verificação de novo e envie.',
        },
        {
          status: 429,
          json: { error: 'rate_limited' },
          expect: 'Muitas tentativas. Tente de novo em alguns minutos.',
        },
        {
          status: 503,
          json: { error: 'captcha_unavailable' },
          expect: 'Não foi possível enviar agora. Tente de novo em instantes.',
        },
      ],
    });
  }
} catch (error) {
  check('run finished', false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close();
  server.close();
}

if (REPORT) {
  const planned = Object.keys(LIVE_PEOPLE).length;
  writeFileSync(REPORT, JSON.stringify({ planned, consentShown, submissions }, null, 2));
}

const failed = results.filter((result) => !result.ok);
const groups = new Map();
for (const result of results) {
  const group = result.name.split(':')[0];
  const counts = groups.get(group) ?? { passed: 0, total: 0 };
  counts.total += 1;
  if (result.ok) counts.passed += 1;
  groups.set(group, counts);
}
console.warn(
  `\n${[...groups].map(([group, c]) => `${group} ${c.passed}/${c.total}`).join(' · ')}` +
    `\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${SHOTS}`,
);
if (failed.length) {
  console.warn(
    `FAILED:\n${failed.map((f) => `  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`).join('\n')}`,
  );
  process.exit(1);
}
