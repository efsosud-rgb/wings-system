// Checks the REAL nginx config (docker/landing-nginx.conf) in a throwaway container bound to
// 127.0.0.1 on a high port (never 80/443), against the built dist/:
//
//   pnpm --filter @wings/landing build && pnpm --filter @wings/landing test:nginx
//
// The page "Fale com a Wings" can never be framed; the form embedded in the Wings site
// (/embed/formulario) can be framed by the site's two origins and by nothing else, and every
// other header stays the same on both. Needs docker and the nginx:alpine image (no pull).
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const port = 30000 + Math.floor(Math.random() * 20000);
const name = `wings-landing-nginx-check-${process.pid}`;
const HOST = 'fale.wingscompany.com.br';

const STRICT_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";
const EMBED_CSP =
  "frame-ancestors https://wingscompany.com.br https://www.wingscompany.com.br; base-uri 'self'; object-src 'none'; form-action 'self'";
const SHARED = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy':
    'accelerometer=(self), gyroscope=(self), camera=(), microphone=(), geolocation=()',
  'cache-control': 'no-cache',
};

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) failed += 1;
  console.warn(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? ` — ${detail}` : ''}`);
}

function get(path, host = HOST) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

const docker = (...args) => execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });

try {
  docker(
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:80`,
    '-v',
    `${resolve(repo, 'docker/landing-nginx.conf')}:/etc/nginx/templates/default.conf.template:ro`,
    '-v',
    `${resolve(root, 'dist')}:/usr/share/nginx/html:ro`,
    '-e',
    `LANDING_HOSTS=${HOST}`,
    '-e',
    `LANDING_ROOT_SLUGS=${HOST}=fale-com-a-wings`,
    '-e',
    'LANDING_API_BASE=https://api.exemplo.test/api',
    '-e',
    'LANDING_GTM_ID=GTM-TESTE',
    '-e',
    'LANDING_INDEXABLE=true',
    '-e',
    'NGINX_ENVSUBST_FILTER=^LANDING_',
    'nginx:alpine',
  );
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await get('/healthz')).status === 200) break;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 200));
  }

  const headersOf = (res) => ({
    csp: res.headers['content-security-policy'],
    xfo: res.headers['x-frame-options'],
  });
  const same = (res, extra = {}) =>
    Object.entries({ ...SHARED, ...extra }).every(([key, value]) => res.headers[key] === value);

  for (const path of ['/', '/fale-com-a-wings', '/fale-com-a-wings/']) {
    const res = await get(path);
    check(
      `${path}: 200, frame-ancestors 'none' and X-Frame-Options DENY, other headers intact`,
      res.status === 200 &&
        headersOf(res).csp === STRICT_CSP &&
        headersOf(res).xfo === 'DENY' &&
        same(res),
      JSON.stringify([res.status, headersOf(res)]),
    );
  }
  for (const path of ['/embed/formulario', '/embed/formulario/']) {
    const res = await get(path);
    check(
      `${path}: 200, framed only by the Wings site, no X-Frame-Options, other headers intact`,
      res.status === 200 &&
        headersOf(res).csp === EMBED_CSP &&
        headersOf(res).xfo === undefined &&
        same(res),
      JSON.stringify([res.status, headersOf(res)]),
    );
  }
  const embed = await get('/embed/formulario');
  check(
    '/embed/formulario: runtime config written (API, tag container), noindex',
    !embed.body.includes('__LANDING_') &&
      embed.body.includes('content="https://api.exemplo.test/api"') &&
      embed.body.includes('content="GTM-TESTE"') &&
      embed.body.includes('content="noindex, nofollow"'),
  );
  for (const [path, host, status] of [
    ['/embed/formulario', 'outro-host.exemplo.test', 404],
    ['/embed/outra-coisa', HOST, 404],
    ['/embed/formulario/x', HOST, 404],
  ]) {
    const res = await get(path, host);
    check(
      `${host}${path}: ${status} with the strict headers`,
      res.status === status && headersOf(res).csp === STRICT_CSP && headersOf(res).xfo === 'DENY',
      JSON.stringify([res.status, headersOf(res)]),
    );
  }
  const asset = /\/assets\/[^"']+\.js/.exec(embed.body)?.[0] ?? '/assets/nao-existe.js';
  const js = await get(asset);
  check(
    `${asset}: 200 and the strict headers`,
    js.status === 200 && headersOf(js).csp === STRICT_CSP && headersOf(js).xfo === 'DENY',
    JSON.stringify([js.status, headersOf(js)]),
  );
} catch (error) {
  failed += 1;
  console.warn(`FAIL  nginx check did not run — ${error instanceof Error ? error.message : error}`);
} finally {
  try {
    docker('rm', '-f', name);
  } catch {
    // already gone
  }
}
console.warn(failed ? `\n${failed} check(s) failed` : '\nall nginx header checks passed');
process.exit(failed ? 1 : 0);
