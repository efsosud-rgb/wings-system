// Checks the REAL nginx config (docker/landing-nginx.conf) in a throwaway container bound to
// 127.0.0.1 on a high port (never 80/443), against the built dist/:
//
//   pnpm --filter @wings/landing build && pnpm --filter @wings/landing test:nginx
//
// The page "Fale com a Wings" can never be framed; the form embedded in the Wings site
// (/embed/formulario) can be framed by the site's two origins and by nothing else, and every
// other header stays the same on both. /robots.txt and /sitemap.xml follow LANDING_INDEXABLE (a
// second container runs with it off). Needs docker and the nginx:alpine image (no pull).
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const port = 30000 + Math.floor(Math.random() * 20000);
const name = `wings-landing-nginx-check-${process.pid}`;
// the same image with LANDING_INDEXABLE off, as in staging
const quietPort = port + 1;
const quietName = `${name}-noindex`;
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

function get(path, host = HOST, onPort = port) {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: onPort, path, headers: { host } }, (res) => {
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

async function startNginx(containerName, onPort, indexable) {
  docker(
    'run',
    '--rm',
    '-d',
    '--name',
    containerName,
    '-p',
    `127.0.0.1:${onPort}:80`,
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
    `LANDING_INDEXABLE=${indexable}`,
    '-e',
    'NGINX_ENVSUBST_FILTER=^LANDING_',
    'nginx:alpine',
  );
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await get('/healthz', HOST, onPort)).status === 200) break;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 200));
  }
}

try {
  await startNginx(name, port, 'true');
  await startNginx(quietName, quietPort, 'false');

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

  const robots = await get('/robots.txt');
  check(
    '/robots.txt (indexable): allows and names the sitemap of the host',
    robots.status === 200 &&
      robots.headers['content-type']?.startsWith('text/plain') &&
      robots.body === `User-agent: *\nAllow: /\n\nSitemap: https://${HOST}/sitemap.xml\n`,
    JSON.stringify([robots.status, robots.body]),
  );
  const sitemap = await get('/sitemap.xml');
  check(
    "/sitemap.xml (indexable): the host's page, as XML",
    sitemap.status === 200 &&
      sitemap.headers['content-type']?.startsWith('text/xml') &&
      sitemap.body.includes(`<loc>https://${HOST}/</loc>`),
    JSON.stringify([sitemap.status, sitemap.headers['content-type'], sitemap.body]),
  );
  for (const path of ['/robots.txt', '/sitemap.xml']) {
    const res = await get(path, 'outro-host.exemplo.test');
    check(`outro-host${path}: 404`, res.status === 404, String(res.status));
  }
  const quietRobots = await get('/robots.txt', HOST, quietPort);
  check(
    '/robots.txt (LANDING_INDEXABLE off): disallows everything, no sitemap',
    quietRobots.status === 200 && quietRobots.body === 'User-agent: *\nDisallow: /\n',
    JSON.stringify([quietRobots.status, quietRobots.body]),
  );
  const quietSitemap = await get('/sitemap.xml', HOST, quietPort);
  check('/sitemap.xml (LANDING_INDEXABLE off): 404', quietSitemap.status === 404);
  const quietPage = await get('/', HOST, quietPort);
  check(
    '/ (LANDING_INDEXABLE off): noindex in the meta and the header',
    quietPage.headers['x-robots-tag'] === 'noindex, nofollow' &&
      quietPage.body.includes('<meta name="robots" content="noindex, nofollow"'),
    JSON.stringify(quietPage.headers['x-robots-tag']),
  );
} catch (error) {
  failed += 1;
  console.warn(`FAIL  nginx check did not run — ${error instanceof Error ? error.message : error}`);
} finally {
  for (const containerName of [name, quietName]) {
    try {
      docker('rm', '-f', containerName);
    } catch {
      // already gone
    }
  }
}
console.warn(failed ? `\n${failed} check(s) failed` : '\nall nginx header checks passed');
process.exit(failed ? 1 : 0);
