// Minimal Tag Manager API v2 client. Access token minted from /etc/wings-crm/gtm.env; never printed.
import { existsSync, readFileSync } from 'node:fs';

const CLIENT_ENV = '/etc/wings-crm/google-ads.env';
const TOKEN_ENV = '/etc/wings-crm/gtm.env';
export const BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';

export const ACCOUNT = process.env.GTM_ACCOUNT || '6326149608';
export const CONTAINER = process.env.GTM_CONTAINER || '236411221';
export const WORKSPACE = process.env.GTM_WORKSPACE || '15';
export const WS_PATH = `accounts/${ACCOUNT}/containers/${CONTAINER}/workspaces/${WORKSPACE}`;

function dotenv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

let cached = null;
export async function accessToken() {
  if (cached && cached.exp - 60_000 > Date.now()) return cached.value;
  const c = dotenv(CLIENT_ENV);
  const t = dotenv(TOKEN_ENV);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.GTM_REFRESH_TOKEN || '',
      client_id: c.GOOGLE_ADS_CLIENT_ID || '',
      client_secret: c.GOOGLE_ADS_CLIENT_SECRET || '',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error('token refresh failed: ' + res.status + ' ' + (body.error || ''));
  cached = { value: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 };
  return cached.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function call(method, path, body, { retries = 4 } = {}) {
  const token = await accessToken();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path.startsWith('http') ? path : `${BASE}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status === 429 && attempt < retries) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) {
      const msg = (json && json.error && json.error.message) || text.slice(0, 300);
      throw new Error(`${method} ${path} -> ${res.status}: ${msg}`);
    }
    return json;
  }
}

export async function listAll(path, key) {
  const out = [];
  let pageToken = null;
  do {
    const q = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
    const page = await call('GET', `${path}${q}`);
    out.push(...((page && page[key]) || []));
    pageToken = page && page.nextPageToken;
    await sleep(300);
  } while (pageToken);
  return out;
}

export function paramMap(entity) {
  const out = {};
  for (const p of entity.parameter || []) {
    out[p.key] = p.type === 'template' || p.type === 'boolean' || p.type === 'integer' ? p.value : p;
  }
  return out;
}
