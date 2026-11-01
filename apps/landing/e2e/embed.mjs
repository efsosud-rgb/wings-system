// E2E of the form embedded in the Wings site (/embed/formulario), in headless Chromium:
//
//   pnpm --filter @wings/landing build && pnpm --filter @wings/landing test:embed
//
// Nothing leaves the machine: the Wings site (https://wingscompany.com.br), the landing host, the API,
// Google Tag Manager and Turnstile are all answered locally by route (mock API, made-up person).
// The landing host answers with the headers of docker/landing-nginx.conf (the real file is checked by
// test:nginx), so the browser itself decides whether the page may be framed. The site's page is
// e2e/site-snippet.html, the very snippet handed to the site.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const DIST = resolve(root, 'dist');
const CHROME =
  process.env.CHROME_PATH ||
  resolve(
    homedir(),
    '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  );
const SITE = 'https://wingscompany.com.br';
const FORM = 'https://fale.wingscompany.com.br';
const API = 'https://api.exemplo.test/api';
const FORM_URL = `${API}/public/site-forms/fale-com-a-wings`;
const GTM_ID = 'GTM-MXJLC5HH';
const WA = 'https://wa.me/550000000000?text=E2EGET%20REF234';
const BG = process.env.E2E_BG || '#123456';
// E2E_SHOTS=<dir> also saves the site page before sending and on the thank-you (E2E_BG=#000000 for the site's black)
const SHOTS = process.env.E2E_SHOTS || null;
const STRICT_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";
const EMBED_CSP = `frame-ancestors ${SITE} https://www.wingscompany.com.br; base-uri 'self'; object-src 'none'; form-action 'self'`;
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.warn(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

const snippet = readFileSync(resolve(root, 'e2e/site-snippet.html'), 'utf8');
/** The Wings site's page: the snippet, in a column of `width` px when given (the site pads its container). */
const sitePage = (
  width,
) => `<!doctype html><meta charset="utf-8"><body style="margin:0;background:${BG}"><div id="pad" style="height:40px"></div><div style="${width ? `width:${width}px` : ''}">${snippet}</div><script>
  window.__messages = [];
  addEventListener('message', (e) => __messages.push({ origin: e.origin, data: e.data, at: performance.now() }));
</script>`;
const framerPage = (src) =>
  `<!doctype html><meta charset="utf-8"><body style="background:${BG}"><iframe id="f" src="${src}" style="width:600px;height:300px;border:0"></iframe>`;

const FAKE_GTM = `window.__fakeGtm = (window.__fakeGtm || 0) + 1;`;
const FAKE_TURNSTILE = `(() => {
  window.__ts = { theme: null };
  window.turnstile = {
    render(el, opts) {
      window.__ts.theme = opts.theme;
      const box = document.createElement('div');
      box.style.cssText = 'width:100%;min-width:300px;height:65px;box-sizing:border-box;border:1px solid #888';
      el.appendChild(box);
      setTimeout(() => opts.callback('XXXX.DUMMY.TOKEN.XXXX'), 150);
      return 'fake-1';
    },
    reset() {},
    remove() {},
    getResponse() { return 'XXXX.DUMMY.TOKEN.XXXX'; },
  };
})();`;

const FORM_SPEC = {
  slug: 'fale-com-a-wings',
  brand: 'Wings Company',
  turnstileSiteKey: '1x00000000000000000000AA',
  instagram: '@wings.companybr',
  pipeline: 'formatacao',
  tracking: { metaPixelId: null, googleAdsConversion: null },
  whatsappUrl: 'https://wa.me/550000000000?text=E2EGET',
  form: {
    qualifier: {
      question: 'O que você procura?',
      options: ['Transformar meu negócio em franquia', 'Ainda não sei'],
    },
    qualifierValues: [
      { value: 'formatacao', option: 'Transformar meu negócio em franquia' },
      { value: 'nao-sei', option: 'Ainda não sei' },
    ],
    requiredFields: ['email', 'companyName', 'instagram', 'qualifierAnswer'],
    consentText: 'Li a Política de Privacidade e autorizo a Wings a falar comigo.',
    privacyPolicyUrl: 'https://wingscompany.com.br/politica-de-privacidade/',
    thankYou: {
      title: 'Obrigado! A Wings vai falar com você.',
      body: 'Um consultor entra em contato.',
      buttonText: 'Chamar no WhatsApp',
      buttonUrl: 'https://wingscompany.com.br/',
    },
  },
};
const PERSON = {
  name: 'Pessoa de Teste',
  phone: '21900000000',
  email: 'pessoa.teste@exemplo.com.br',
  company: 'Empresa Exemplo',
  instagram: '@Marca.Teste',
  site: 'www.exemplo.com.br',
};

/** The page's answers: the Wings site, the landing host with nginx's framing headers, the API, the fakes. */
async function wire(context, { posts, outside }) {
  await context.route('**/*', async (route, request) => {
    const url = new URL(request.url());
    const html = (body, csp, extra = {}) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'content-security-policy': csp, ...extra },
        body,
      });
    if (url.origin === SITE) return html(sitePage(url.searchParams.get('w')), STRICT_CSP);
    if (url.origin === 'https://evil.example') {
      return html(framerPage(url.searchParams.get('src') ?? ''), STRICT_CSP);
    }
    if (url.origin === 'https://wa.me') return route.fulfill({ status: 200, body: 'whatsapp' });
    if (url.hostname === 'www.googletagmanager.com') {
      outside.gtm.push(url.searchParams.get('id'));
      return route.fulfill({ contentType: 'application/javascript', body: FAKE_GTM });
    }
    if (url.hostname === 'challenges.cloudflare.com') {
      return route.fulfill({ contentType: 'application/javascript', body: FAKE_TURNSTILE });
    }
    if (url.origin === 'https://api.exemplo.test') {
      const cors = { 'access-control-allow-origin': FORM, vary: 'Origin' };
      if (request.method() === 'OPTIONS') {
        return route.fulfill({
          status: 204,
          headers: {
            ...cors,
            'access-control-allow-methods': 'GET, POST',
            'access-control-allow-headers': 'content-type',
          },
        });
      }
      if (url.href !== FORM_URL) return route.fulfill({ status: 404, headers: cors, json: {} });
      if (request.method() === 'GET') return route.fulfill({ headers: cors, json: FORM_SPEC });
      posts.push(JSON.parse(request.postData() ?? 'null'));
      return route.fulfill({ headers: cors, json: { ok: true, whatsappUrl: WA } });
    }
    if (url.origin === FORM) {
      const embed = url.pathname === '/embed/formulario';
      if (embed || url.pathname === '/') {
        const file = embed ? 'embed/formulario/index.html' : 'fale-com-a-wings/index.html';
        const body = readFileSync(join(DIST, file), 'utf8')
          .replaceAll('__LANDING_API_BASE__', API)
          .replaceAll('__LANDING_GTM_ID__', GTM_ID)
          .replaceAll('__LANDING_ROBOTS__', 'noindex, nofollow')
          .replaceAll('__LANDING_ORIGIN__', FORM)
          .replaceAll('__LANDING_PAGE_URL__', `${FORM}${url.pathname}`);
        // what docker/landing-nginx.conf sends: framed by the site on the embed alone
        return html(
          body,
          embed ? EMBED_CSP : STRICT_CSP,
          embed ? {} : { 'x-frame-options': 'DENY' },
        );
      }
      if (url.pathname.startsWith('/assets/')) {
        return route.fulfill({
          contentType: TYPES[extname(url.pathname)] ?? 'application/octet-stream',
          body: readFileSync(join(DIST, url.pathname)),
        });
      }
    }
    outside.other.push(url.href);
    return route.abort();
  });
}

async function fill(page, frame, person, answer) {
  await frame.fill('#f-nome', person.name);
  await frame.click('#f-tel');
  await page.keyboard.type(person.phone);
  // the optional block (e-mail, company, Instagram, site) opens before it is filled
  await frame.click('#f-more summary');
  await frame.fill('#f-email', person.email);
  await frame.fill('#f-empresa', person.company);
  await frame.fill('#f-ig', person.instagram);
  await frame.focus('#f-site');
  await frame.fill('#f-site', person.site);
  await frame.selectOption('#f-int', answer);
  await frame.selectOption('#f-fat', '300k-1mi');
  await frame.check('#f-consent');
}

const colour = (page, selector, prop = 'color') =>
  page.$eval(selector, (el, p) => window.getComputedStyle(el)[p], prop);

async function runSite(browser, { label, viewport, mobile, query, utm }) {
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'pt-BR',
  });
  const posts = [];
  const outside = { gtm: [], other: [] };
  await wire(context, { posts, outside });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${SITE}/${query}`);
  const handle = await page.waitForSelector('#wings-form');
  const frame = (await await handle.contentFrame()) ?? null;
  await frame.waitForSelector('#f-nome');
  const iframeSrc = new URL(await handle.getAttribute('src'));
  const messages = () => page.evaluate(() => window.__messages);
  const heights = async () =>
    (await messages())
      .filter((m) => m.data?.tipo === 'wings-form-altura')
      .map((m) => m.data.altura);

  check(
    `${label}: the site's snippet points the iframe to the form with the visit's origin and page`,
    iframeSrc.origin === FORM &&
      iframeSrc.pathname === '/embed/formulario' &&
      iframeSrc.searchParams.get('pagina') === `${SITE}/${query}` &&
      (!utm || iframeSrc.searchParams.get('gclid') === 'G123'),
    iframeSrc.href,
  );
  // iframe sized by the form's own height messages
  await page.waitForFunction(
    () => Math.abs(document.getElementById('wings-form').offsetHeight - 640) > 2,
  );
  const first = (await heights()).at(-1);
  const boxHeight = await handle.evaluate((el) => el.offsetHeight);
  const formHeight = await frame.$eval('body', (el) =>
    Math.ceil(el.getBoundingClientRect().height),
  );
  check(
    `${label}: height messages size the iframe to the form`,
    first === formHeight && boxHeight === formHeight && formHeight > 300,
    `message ${first}, iframe ${boxHeight}, form ${formHeight}`,
  );
  check(
    `${label}: every message the site hears comes from the form's origin`,
    (await messages()).every((m) => m.origin === FORM),
  );

  // transparent over the site's colour, white letters, title hidden, Turnstile dark
  const bg = await frame.evaluate(() => [
    window.getComputedStyle(document.documentElement).backgroundColor,
    window.getComputedStyle(document.body).backgroundColor,
  ]);
  const pixel = async (x, y) =>
    (await page.screenshot({ clip: { x, y, width: 1, height: 1 } })).toString('base64');
  const box = await handle.boundingBox();
  check(
    `${label}: transparent background (the site's colour shows through the iframe)`,
    bg.every((c) => c === 'rgba(0, 0, 0, 0)') &&
      (await pixel(box.x + 2, box.y + 2)) ===
        (await pixel(box.x - 6 < 0 ? 1 : box.x - 6, box.y + 2)) &&
      (await pixel(box.x + 2, box.y + 2)) === (await pixel(box.x + 2, 1)),
    JSON.stringify(bg),
  );
  check(
    `${label}: white letters, no title or subtitle by default`,
    (await colour(frame, 'label[for="f-nome"]')) === 'rgb(255, 255, 255)' &&
      !(await frame.$eval('.ft', (el) => el.checkVisibility())) &&
      !(await frame.$eval('.sub', (el) => el.checkVisibility())),
  );

  await fill(page, frame, PERSON, 'formatacao');
  await frame.waitForFunction(() => !document.getElementById('f-send').disabled);
  check(
    `${label}: robot check drawn in the dark theme`,
    (await frame.evaluate(() => window.__ts?.theme)) === 'dark',
  );
  await page.waitForTimeout(700); // the button's colour transition
  const send = await frame.$eval('#f-send', (el) => {
    const style = window.getComputedStyle(el);
    return [style.backgroundColor, style.color];
  });
  check(
    `${label}: orange send button with black letters once the form is complete`,
    send[0] === 'rgb(233, 82, 40)' && send[1] === 'rgb(0, 0, 0)',
    JSON.stringify(send),
  );
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${label}-formulario.png`) });
  await frame.click('#f-send');
  await frame.waitForSelector('#thanks:not([hidden])');
  await page.waitForFunction(() => window.__messages.some((m) => m.data?.tipo === 'wings-lead'));
  const sent = (await messages()).filter((m) => m.data?.tipo === 'wings-lead');
  check(
    `${label}: one wings-lead message, origin site-home, to the site only`,
    sent.length === 1 && sent[0].data.origem === 'site-home' && sent[0].origin === FORM,
    JSON.stringify(sent),
  );
  const last = posts.at(-1) ?? {};
  check(
    `${label}: POST goes to the lead API with the visit's origin, the site's page, never on its own`,
    posts.length === 1 &&
      last.page === `${SITE}/${query}` &&
      last.qualifierAnswer === 'formatacao' &&
      last.monthlyRevenue === '300k-1mi' &&
      (utm
        ? last.tracking?.utm_source === 'google' &&
          last.tracking?.utm_campaign === 'c1' &&
          last.tracking?.gclid === 'G123'
        : last.tracking?.utm_source === 'site' && last.tracking?.utm_medium === 'formulario-home'),
    JSON.stringify([last.page, last.tracking]),
  );
  const events = await frame.evaluate(() =>
    (window.dataLayer || []).filter((e) => e && e.event === 'lead_submit'),
  );
  check(
    `${label}: same tag container as the page, dataLayer lead_submit once`,
    outside.gtm.length === 1 &&
      outside.gtm[0] === GTM_ID &&
      events.length === 1 &&
      events[0].interesse === 'formatacao',
    JSON.stringify([outside.gtm, events]),
  );
  await page.waitForFunction(
    (before) => document.getElementById('wings-form').offsetHeight !== before,
    boxHeight,
  );
  check(
    `${label}: the iframe follows the thank-you screen`,
    (await handle.evaluate((el) => el.offsetHeight)) === (await heights()).at(-1),
  );
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${label}-obrigado.png`) });
  const wa = await frame.$eval('#thanks [data-wa]', (a) => [a.href, a.target, a.rel]);
  const popup = context.waitForEvent('page', { timeout: 5000 });
  await frame.click('#thanks [data-wa]');
  const opened = await popup.catch(() => null);
  check(
    `${label}: WhatsApp opens outside the iframe, the site stays where it was`,
    wa[0] === WA &&
      wa[1] === '_blank' &&
      wa[2].includes('noopener') &&
      opened !== null &&
      opened.url().startsWith('https://wa.me/') &&
      page.url() === `${SITE}/${query}`,
    JSON.stringify(wa),
  );
  check(`${label}: no console error or page error`, errors.length === 0, errors.join(' | '));
  check(`${label}: nothing left the machine`, outside.other.length === 0, outside.other.join(' '));
  await context.close();
}

/** The first height message is not lost for good: the form repeats it for 10 s and answers the site's ping. */
async function runHeight(browser) {
  const context = await browser.newContext({
    viewport: { width: 400, height: 800 },
    locale: 'pt-BR',
  });
  await wire(context, { posts: [], outside: { gtm: [], other: [] } });
  const page = await context.newPage();
  await page.goto(`${SITE}/`);
  const handle = await page.waitForSelector('#wings-form');
  await page.waitForFunction(() =>
    window.__messages.some((m) => m.data?.tipo === 'wings-form-altura'),
  );
  const heights = () =>
    page.evaluate(() =>
      window.__messages.filter((m) => m.data?.tipo === 'wings-form-altura').map((m) => m.at),
    );
  await page.waitForTimeout(3200);
  const early = await heights();
  check(
    'height: repeated every second while the page is new (a listener that came late still hears it)',
    early.length >= 3,
    `${early.length} messages in ~3 s`,
  );
  // the site missed it: iframe at a wrong height, nothing but the repeat brings the right one back
  await handle.evaluate((el) => (el.style.height = '100px'));
  await page.waitForFunction(() => document.getElementById('wings-form').offsetHeight > 300, null, {
    timeout: 3000,
  });
  check('height: a wrong iframe height is corrected by the repeat, without a resize', true);
  await page.waitForTimeout(8500); // past the 10 s
  const settled = (await heights()).length;
  await page.waitForTimeout(2200);
  check(
    'height: the repeat stops after 10 s',
    (await heights()).length === settled,
    `${settled} then ${(await heights()).length}`,
  );
  await handle.evaluate((el) => (el.style.height = '100px'));
  const bad = await handle.evaluate((el) => el.offsetHeight);
  await page.evaluate(() =>
    document
      .getElementById('wings-form')
      .contentWindow.postMessage({ tipo: 'wings-form-ping' }, 'https://fale.wingscompany.com.br'),
  );
  await page
    .waitForFunction(() => document.getElementById('wings-form').offsetHeight > 300, null, {
      timeout: 2000,
    })
    .catch(() => {});
  check(
    "height: the site's wings-form-ping brings the height back at once, after the repeat has stopped",
    bad === 100 && (await handle.evaluate((el) => el.offsetHeight)) > 300,
  );
  await context.close();
}

/** From 280 px up nothing leaves the iframe's width: fields, select, consent text, robot check and button. */
async function runWidths(browser) {
  for (const width of [280, 302, 320, 360, 390]) {
    const context = await browser.newContext({
      viewport: { width: 400, height: 800 },
      isMobile: true,
      hasTouch: true,
      locale: 'pt-BR',
    });
    await wire(context, { posts: [], outside: { gtm: [], other: [] } });
    const page = await context.newPage();
    await page.goto(`${SITE}/?w=${width}`);
    const handle = await page.waitForSelector('#wings-form');
    const frame = await handle.contentFrame();
    await frame.waitForSelector('#f-bot-widget > *');
    await page.waitForTimeout(500);
    const found = await frame.evaluate(() => {
      const room = document.documentElement.clientWidth;
      const outside = [];
      const probe = (name, rect) => {
        if (rect.width > 0 && (rect.left < -0.5 || rect.right > room + 0.5)) {
          outside.push(`${name} ${Math.round(rect.left)}..${Math.round(rect.right)}`);
        }
      };
      const selector =
        '#lead-form input, #lead-form select, .consent, #f-send, #f-bot-widget, #f-bot-widget > *, .bot-slot';
      for (const el of document.querySelectorAll(selector)) {
        if (!el.closest('.hp'))
          probe(el.id || el.className || el.tagName, el.getBoundingClientRect());
      }
      const text = document.createRange();
      text.selectNodeContents(document.querySelector('.consent'));
      for (const rect of text.getClientRects()) probe('consent text', rect);
      return { room, scroll: document.documentElement.scrollWidth, outside };
    });
    check(
      `width ${width}: nothing leaves the iframe (no sideways scroll, fields, select, consent, robot check, button)`,
      found.room === width && found.scroll <= found.room && found.outside.length === 0,
      JSON.stringify(found),
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `largura-${width}.png`) });
    await context.close();
  }
}

/** Opened on its own: black page, the title and subtitle with titulo=1, and no message to anyone. */
async function runDirect(browser) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await wire(context, { posts: [], outside: { gtm: [], other: [] } });
  const page = await context.newPage();
  await page.goto(`${FORM}/embed/formulario?titulo=1`);
  await page.waitForSelector('#f-nome');
  check(
    'direct: black background when not framed, title and subtitle with titulo=1',
    (await colour(page, 'html', 'backgroundColor')) === 'rgb(0, 0, 0)' &&
      (await page.$eval('.ft', (el) => el.checkVisibility() && el.textContent.trim())) ===
        'Peça seu diagnóstico gratuito' &&
      (await page.$eval('.sub', (el) => el.checkVisibility())),
  );
  await context.close();
}

/** The browser, not the config, refuses a frame: another site cannot frame the form, nobody frames the page. */
async function runFraming(browser) {
  for (const [label, parent, target, allowed] of [
    ['the Wings site frames the form', SITE, `${FORM}/embed/formulario`, true],
    [
      'another site cannot frame the form',
      'https://evil.example',
      `${FORM}/embed/formulario`,
      false,
    ],
    ['the Wings site cannot frame the page', 'https://evil.example', `${FORM}/`, false],
  ]) {
    const context = await browser.newContext({ locale: 'pt-BR' });
    await wire(context, { posts: [], outside: { gtm: [], other: [] } });
    const page = await context.newPage();
    // the Wings site's own page holds the snippet; this one frames `target` alone
    await page.goto(parent === SITE ? `${SITE}/` : `${parent}/?src=${encodeURIComponent(target)}`);
    if (parent === SITE) {
      await page.evaluate((src) => {
        const frame = document.createElement('iframe');
        frame.id = 'probe';
        frame.src = src;
        document.body.append(frame);
      }, target);
    }
    await page.waitForTimeout(1500);
    const frame =
      page
        .frames()
        .find((f) => f !== page.mainFrame() && f.url().startsWith(target.slice(0, 20))) ?? null;
    const loaded = frame ? await frame.$('.form, #lead-form, .hero') : null;
    const blocked = !frame || frame.url().startsWith('chrome-error:') || !loaded;
    check(`framing: ${label}`, allowed ? !blocked : blocked);
    await context.close();
  }
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--host-resolver-rules=MAP * ~NOTFOUND'],
});
try {
  await runSite(browser, {
    label: 'desktop-1440',
    viewport: { width: 1440, height: 900 },
    mobile: false,
    query: '?utm_source=google&utm_medium=cpc&utm_campaign=c1&gclid=G123',
    utm: true,
  });
  await runSite(browser, {
    label: 'phone-390',
    viewport: { width: 390, height: 844 },
    mobile: true,
    query: '',
    utm: false,
  });
  await runWidths(browser);
  await runHeight(browser);
  await runDirect(browser);
  await runFraming(browser);
} catch (error) {
  check('run finished', false, error instanceof Error ? error.stack : String(error));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.warn(`\n${results.length - failed.length}/${results.length} embed checks passed`);
process.exit(failed.length ? 1 : 0);
