// Helpers shared by the E2E flows: HTTP calls against the API that run.mjs starts, the
// PASS/FAIL log and the list of every credential seen (scanned later by flows/segredos.mjs).
// Synthetic data only; no secret is ever printed.
import { readFileSync, readdirSync } from 'node:fs';

export const BASE = 'http://127.0.0.1:53000';

export const results = [];
export const secrets = [];

export function check(flow, name, ok, detail = '') {
  results.push({ flow, name, ok });
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  [${flow}] ${name}${detail ? ` — ${detail}` : ''}\n`,
  );
}

export async function call(cookie, method, path, body, origin = BASE) {
  const headers = { origin };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: status is enough
  }
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] };
}

export async function login(email, password) {
  const res = await call(null, 'POST', '/auth/login', { email, password });
  const pairs = res.setCookie.map((c) => c.split(';')[0]);
  secrets.push(...pairs.map((p) => p.split('=').slice(1).join('=')));
  return { status: res.status, cookie: pairs.join('; ') };
}

export const mails = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.eml'))
    .sort();

/** The invite or reset token of the newest e-mail in the fake SMTP's folder. */
export function lastMailToken(dir) {
  const files = mails(dir);
  if (!files.length) return undefined;
  const text = readFileSync(`${dir}/${files.at(-1)}`, 'utf8')
    .replace(/=\r?\n/g, '')
    .replace(/=3D/g, '=');
  const token = text.match(/token=([A-Za-z0-9_-]{20,})/)?.[1];
  if (token) secrets.push(token);
  return token;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
