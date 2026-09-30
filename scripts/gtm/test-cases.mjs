// Runs the four RD conversion cases on wingscompany.com.br in headless Chromium.
//   node test-cases.mjs [--container live|env:<id>] [--inject] [--case 1,2,3,4] [--out report.json]
// --container env:<id>  serves the draft container of that GTM environment (auth code read via the API, never printed)
// --inject              injects docs/gtm/rd-conversao-observada.html at page init (to exercise the observer on the live container)
// The RD Station conversion request is intercepted and answered locally (200 or 422): no personal data reaches RD.
// Records, per case: RD requests seen (kind, identifier, status), rd_* dataLayer events, and the tag hits observed on
// the network (Meta Pixel ev/eid, Google Ads label/oid, GA4 event names). The result is also pushed to the dataLayer.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '/opt/wings-system/node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : [])).filter((x) => x.length));
const container = args.container || 'live';
const inject = !!args.inject;
const cases = String(args.case || '1,2,3,4').split(',').map(Number);
const out = args.out || '/root/wings-gtm/report.json';

const SITE = 'https://wingscompany.com.br/';
const GTM_ID = 'GTM-MXJLC5HH';
const FAKE = { name: 'Teste Wings System', email: 'teste-gtm@example.com', phone: '21999999999', text: 'Teste Wings System GTM preview' };

let draftJs = null;
if (container.startsWith('env:')) {
  const { call, WS_PATH } = await import('./api.mjs');
  const base = WS_PATH.replace(/\/workspaces\/\d+$/, '');
  const e = await call('GET', `${base}/environments/${container.slice(4)}`);
  const u = `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}&gtm_auth=${encodeURIComponent(e.authorizationCode)}&gtm_preview=env-${e.environmentId}&gtm_cookies_win=x`;
  const r = await fetch(u);
  draftJs = await r.text();
  if (r.status !== 200 || !draftJs.includes('rd_conversion_accepted')) throw new Error(`environment ${container} does not serve the draft (status ${r.status})`);
  console.log(`container: draft from environment ${e.environmentId} (${draftJs.length} bytes)`);
} else console.log('container: live');

const injectCode = inject
  ? readFileSync(new URL('../../docs/gtm/rd-conversao-observada.html', import.meta.url), 'utf8').replace(/^[\s\S]*?<script>/, '').replace(/<\/script>\s*$/, '')
  : null;

const browser = await chromium.launch({ headless: true });
const results = [];

async function runCase(n) {
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'pt-BR',
  });
  const rec = { case: n, rdRequests: [], tags: { meta: [], gads: [], ga4: [] }, dl: [], notes: [] };
  const rdStatus = n === 2 ? 422 : 200;

  await ctx.route(/googletagmanager\.com\/gtm\.js\?id=GTM-MXJLC5HH/, async (route) => {
    if (draftJs) return route.fulfill({ status: 200, contentType: 'application/javascript', body: draftJs });
    return route.continue();
  });
  // RD Station conversion endpoints: answered locally, never forwarded.
  await ctx.route(/(rdstation\.com(\.br)?|rd\.services)\/.*conversions/i, async (route) => {
    const req = route.request();
    let identifier = '?';
    try {
      const body = req.postData() || '';
      const m = body.match(/conversion_identifier["']?\s*[:=]\s*["']?([A-Za-z0-9._\-]+)/) || req.url().match(/conversion_identifier=([A-Za-z0-9._\-]+)/);
      if (m) identifier = decodeURIComponent(m[1]);
      else {
        try {
          const j = JSON.parse(body);
          identifier = j.conversion_identifier || (j.payload && j.payload.conversion_identifier) || '?';
        } catch {}
      }
    } catch {}
    rec.rdRequests.push({ kind: req.resourceType(), method: req.method(), host: new URL(req.url()).host, identifier, answered: rdStatus });
    await route.fulfill({
      status: rdStatus,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: rdStatus === 200 ? JSON.stringify({ result: 'ok', message: 'ok' }) : JSON.stringify({ errors: [{ error_type: 'INVALID', error_message: 'simulated' }] }),
    });
  });
  // WhatsApp never opens.
  await ctx.route(/(wa\.me|whatsapp\.com)/i, (route) => route.abort());

  const onRequest = (req) => {
    const u = req.url();
    try {
      const url = new URL(u);
      const q = url.searchParams;
      if (/facebook\.com\/tr/.test(u)) rec.tags.meta.push({ ev: q.get('ev'), eid: q.get('eid') });
      else if (/doubleclick\.net\/pagead\/viewthroughconversion\/|google\.com\/pagead\/1p-conversion\/|googleadservices\.com\/pagead\/conversion\//.test(u) && q.get('label'))
        rec.tags.gads.push({ label: q.get('label'), oid: q.get('oid'), en: q.get('en') });
      else if (/\/g\/collect/.test(u) && q.get('en') && q.get('tid') === 'G-C10F4NPBF0') {
        const ep = {};
        for (const [k, v] of q) if (k.startsWith('ep.')) ep[k.slice(3)] = v;
        rec.tags.ga4.push({ en: q.get('en'), ...ep });
      }
    } catch {}
    // the pixel may send with POST body
    if (/facebook\.com\/tr/.test(u) && req.method() === 'POST') {
      const body = req.postData() || '';
      const p = new URLSearchParams(body);
      if (p.get('ev')) rec.tags.meta.push({ ev: p.get('ev'), eid: p.get('eid') });
    }
  };
  ctx.on('request', onRequest);
  await ctx.exposeBinding('__wingsRecord', (_src, entry) => {
    try {
      const e = JSON.parse(entry);
      if (e && typeof e.event === 'string' && /^rd_conversion_|conversao_rd_station/.test(e.event))
        rec.dl.push({ event: e.event, rd_identifier: e.rd_identifier, rd_status: e.rd_status, rd_event_id: e.rd_event_id, at: Date.now() });
    } catch {}
  });
  await ctx.addInitScript(() => {
    let seen = 0;
    setInterval(() => {
      try {
        const dl = window.dataLayer || [];
        for (; seen < dl.length; seen++) {
          const e = dl[seen];
          if (e && typeof e.event === 'string') window.__wingsRecord(JSON.stringify({ event: e.event, rd_identifier: e.rd_identifier, rd_status: e.rd_status, rd_event_id: e.rd_event_id }));
        }
      } catch {}
    }, 100);
  });
  const page = await ctx.newPage();
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) rec.notes.push('navigated ' + f.url().slice(0, 100)); });
  ctx.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });
  if (injectCode) await page.addInitScript(injectCode);
  await page.goto(SITE, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForTimeout(2500);

  const fillForm = async (formSel) => {
    return page.evaluate(
      ({ formSel, FAKE }) => {
        const form = document.querySelector(formSel);
        if (!form) return { error: 'form not found' };
        const filled = [];
        const set = (el, v) => {
          const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        for (const el of form.querySelectorAll('input, select, textarea')) {
          const type = (el.type || '').toLowerCase();
          if (type === 'hidden' || type === 'submit' || type === 'button') continue;
          if (/rd-choices__input--cloned/.test(el.className)) continue;
          const key = (el.name + ' ' + el.className + ' ' + (el.placeholder || '')).toLowerCase();
          if (el.tagName === 'SELECT') {
            const opt = [...el.options].find((o) => o.value && !o.disabled);
            if (opt) {
              set(el, opt.value);
              filled.push(`${el.name}=<option>`);
            }
          } else if (type === 'checkbox' || type === 'radio') {
            if (!form.querySelector(`input[name="${el.name}"]:checked`)) {
              el.click();
              filled.push(`${el.name}=<checked>`);
            }
          } else if (type === 'email' || /email/.test(key)) {
            set(el, FAKE.email);
            filled.push(`${el.name}=<email>`);
          } else if (type === 'tel' || /phone|telefone|celular|whats/.test(key)) {
            set(el, el.getAttribute('data-input-mask') === 'INTERNATIONAL_MASK' ? '+55 (21) 99999-9999' : FAKE.phone);
            filled.push(`${el.name}=<phone>`);
          } else if (/name|nome/.test(key)) {
            set(el, FAKE.name);
            filled.push(`${el.name}=<name>`);
          } else {
            set(el, FAKE.text);
            filled.push(`${el.name}=<text>`);
          }
        }
        return { filled };
      },
      { formSel, FAKE },
    );
  };


  const submitForm = async (sel) => {
    return page.evaluate((sel) => {
      const form = document.querySelector(sel);
      if (!form) return 'form not found';
      const btn = form.querySelector('button[type=submit], input[type=submit], button, .rd-button, .bricks-form__submit__button');
      if (btn) {
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return 'clicked ' + btn.tagName + '.' + String(btn.className).slice(0, 60);
      }
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return 'requestSubmit';
      }
      return 'no submit element';
    }, sel);
  };

  try {
    if (n === 1 || n === 2) {
      const sel = 'form#conversion-form-wings-company-form-site';
      await page.locator(sel).first().scrollIntoViewIfNeeded();
      rec.notes.push(JSON.stringify(await fillForm(sel)));
      rec.notes.push(await submitForm(sel));
    } else if (n === 3) {
      rec.notes.push(await page.evaluate(() => { const b = document.querySelector('.rdstation-popup-js-floating-button'); if (!b) return 'no floating button'; b.click(); return 'floating clicked'; }));
      const sel = 'form.rdstation-popup-js-form-identifier';
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: 10000 });
      rec.notes.push(JSON.stringify(await fillForm(sel)));
      await page.waitForTimeout(500);
      rec.notes.push(await submitForm(sel));
      await page.waitForTimeout(2500);
      rec.notes.push(await page.evaluate((sel) => {
        const form = document.querySelector(sel);
        if (!form) return 'popup form gone (navigated?)';
        const invalid = [...form.querySelectorAll(':invalid')].map((e) => e.name || e.className.slice(0, 40));
        const errors = [...form.querySelectorAll('[class*="error" i], [class*="invalid" i]')].filter((e) => e.offsetParent !== null).map((e) => e.className.slice(0, 50) + ':' + (e.textContent || '').trim().slice(0, 60));
        const btn = form.querySelector('button, input[type=submit]');
        return 'popup after submit: invalid=' + JSON.stringify(invalid) + ' errors=' + JSON.stringify(errors.slice(0, 6)) + ' visible=' + (form.offsetParent !== null) + ' btn=' + (btn ? btn.className.slice(0, 80) + ' disabled=' + btn.disabled : 'none');
      }, sel));
    } else if (n === 4) {
      const link = page.locator('a[href*="wa.me"]').first();
      await link.scrollIntoViewIfNeeded();
      rec.notes.push('clicked ' + (await link.getAttribute('href')) + ' text=' + (await link.textContent()).trim());
      await link.click({ timeout: 10000, noWaitAfter: true });
    }
  } catch (e) {
    rec.notes.push('action error: ' + e.message.split('\n')[0]);
  }
  await page.waitForTimeout(6000);

  await page.evaluate((r) => {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: 'wings_test_result', case: r.case, tags_fired: r.tags, rd_events: r.dl });
  }, rec);
  rec.dataLayerTail = await page.evaluate(() => window.dataLayer.slice(-1)[0]);
  await ctx.close();
  return rec;
}

const NAMES = { 1: 'formulário aceito (RD 200)', 2: 'envio recusado (RD 422)', 3: 'pop-up do WhatsApp aceito (RD 200)', 4: 'clique solto no WhatsApp' };
for (const n of cases) {
  console.log(`\n=== caso ${n}: ${NAMES[n]}`);
  const r = await runCase(n);
  results.push(r);
  console.log('RD requests:', JSON.stringify(r.rdRequests));
  console.log('dataLayer rd events:', JSON.stringify(r.dl));
  console.log('tags -> meta:', JSON.stringify(r.tags.meta), '| gads:', JSON.stringify(r.tags.gads), '| ga4:', JSON.stringify(r.tags.ga4));
  console.log('notes:', r.notes.join(' | '));
}
writeFileSync(out, JSON.stringify({ container, inject, at: new Date().toISOString(), results }, null, 2));
console.log('\nreport:', out);
await browser.close();
