// End-to-end flows of the 27/10 audit against the real API server, on a throwaway database:
//
//   pnpm build && DATABASE_URL=postgresql://...@127.0.0.1:5433/... pnpm e2e
//
// DATABASE_URL must point at a local PostgreSQL (127.0.0.1 or localhost; a Unix socket via
// ?host=/dir works too): this script drops and recreates the database `wings_e2e` on that
// server, runs migrate and seed (twice) from dist/, adds 13 synthetic people (seed.mjs), starts
// a fake SMTP on 127.0.0.1:2525 and the API on :53000, and runs the flows in flows/. The API
// gets a clean environment with random keys and no platform credential, and runs with the
// test network kill switch (src/test/no-network.ts) preloaded, so it cannot reach Meta,
// Google, AI providers or anyone else. Everything is removed at the end.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import * as convites from './flows/convites.mjs';
import * as escalada from './flows/escalada.mjs';
import * as integracoes from './flows/integracoes.mjs';
import * as leads from './flows/leads.mjs';
import * as segredos from './flows/segredos.mjs';
import { BASE, results, sleep } from './lib.mjs';
import { startSmtpSink } from './smtp-sink.mjs';

const api = resolve(import.meta.dirname, '..');
const source = new URL(process.env.DATABASE_URL ?? 'invalid:');
if (!['127.0.0.1', 'localhost'].includes(source.hostname)) {
  throw new Error(
    'pnpm e2e drops and recreates wings_e2e: DATABASE_URL must be a local PostgreSQL',
  );
}
const adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const databaseUrl = new URL(source);
databaseUrl.pathname = '/wings_e2e';

const work = mkdtempSync(join(tmpdir(), 'wings-e2e-'));
const mailDir = join(work, 'mails');
mkdirSync(mailDir);
const key = () => randomBytes(32).toString('base64');
const env = {
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  API_PORT: '53000',
  DATABASE_URL: databaseUrl.href,
  SESSION_SECRET: randomBytes(48).toString('hex'),
  CPF_ENCRYPTION_KEY: key(),
  CPF_INDEX_KEY: key(),
  INTEGRATIONS_ENCRYPTION_KEY: key(),
  APP_BASE_URL: BASE,
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '2525',
  SMTP_USER: 'fake-user',
  SMTP_PASSWORD: 'fake-pass-e2e',
  SMTP_FROM: 'sistema@e2e.invalid',
};

async function admin(sql) {
  const client = new pg.Client({ connectionString: adminUrl.href });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function node(args) {
  const r = spawnSync(process.execPath, args, {
    cwd: api,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`node ${args.join(' ')} exited ${r.status}`);
}

/** One API process per group of flows: the login rate limit (10 per IP) lives in its memory. */
async function withServer(label, flows, ctx) {
  const logPath = join(work, `server-${label}.log`);
  const log = openSync(logPath, 'w');
  const server = spawn(
    process.execPath,
    ['--import', './src/test/no-network.ts', 'dist/server.js'],
    { cwd: api, env, stdio: ['ignore', log, log] },
  );
  try {
    let up = false;
    for (let i = 0; i < 60 && !up && server.exitCode === null; i++) {
      up = await fetch(`${BASE}/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (!up) await sleep(1000);
    }
    if (!up) throw new Error(`API did not start:\n${readFileSync(logPath, 'utf8').slice(-2000)}`);
    for (const flow of flows) await flow.run(ctx);
  } finally {
    server.kill();
    if (server.exitCode === null) await new Promise((r) => server.once('exit', r));
  }
  return readFileSync(logPath, 'utf8');
}

const sink = await startSmtpSink(mailDir, 2525);
try {
  await admin('drop database if exists wings_e2e with (force)');
  await admin('create database wings_e2e');
  node(['dist/db/migrate.js']);
  node(['dist/db/seed.js']);
  node(['dist/db/seed.js']);
  const accountsPath = join(work, 'accounts.json');
  node(['e2e/seed.mjs', accountsPath]);
  const acc = JSON.parse(readFileSync(accountsPath, 'utf8'));

  const ctx = { acc, mailDir, sessions: {} };
  const logs = [
    await withServer('fluxos', [leads, convites, integracoes], ctx),
    await withServer('escalada', [escalada], ctx),
  ];
  await segredos.run({ acc, serverLog: logs.join('\n'), databaseUrl: databaseUrl.href });
} finally {
  sink.close();
  await admin('drop database if exists wings_e2e with (force)').catch(() => {});
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
const audit = results.filter((r) => /^[01239]-/.test(r.flow));
process.stdout.write(
  `\n${results.length - failed}/${results.length} verificações passaram ` +
    `(fluxos 0–3 e 9 da auditoria: ${audit.filter((r) => r.ok).length}/${audit.length})\n`,
);
process.exit(failed ? 1 : 0);
