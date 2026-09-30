#!/usr/bin/env node
// Google OAuth (installed-app flow, PKCE) for the Tag Manager API v2.
//   node oauth.mjs link                 prints the consent link; keeps verifier+state in PENDING (0600)
//   node oauth.mjs exchange <url|code>  trades the code for tokens; writes GTM_REFRESH_TOKEN to OUT (0600)
//   node oauth.mjs token                exits 0 when a fresh access token can be minted (prints no token)
// Client id/secret come from /etc/wings-crm/google-ads.env (same Google Cloud project, openclaw-traffic-508320).
// The redirect is the loopback address: the browser lands on a page that does not load, and the
// person pastes that address back. No token value is ever printed.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const CLIENT_ENV = '/etc/wings-crm/google-ads.env';
const PENDING = '/etc/wings-crm/gtm-oauth-pending.env';
const OUT = '/etc/wings-crm/gtm.env';
const REDIRECT = 'http://127.0.0.1:8085';
const SCOPES = [
  'https://www.googleapis.com/auth/tagmanager.edit.containers',
  'https://www.googleapis.com/auth/tagmanager.readonly',
  // GTM_EXTRA_SCOPES, comma-separated, adds e.g. tagmanager.edit.containerversions (quick_preview, create_version)
  ...(process.env.GTM_EXTRA_SCOPES ? process.env.GTM_EXTRA_SCOPES.split(',').map((s) => s.trim()).filter(Boolean) : []),
];

function dotenv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}
function writeSecret(path, lines) {
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const client = dotenv(CLIENT_ENV);
if (!client.GOOGLE_ADS_CLIENT_ID || !client.GOOGLE_ADS_CLIENT_SECRET) {
  console.error('client id/secret missing in ' + CLIENT_ENV);
  process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'link') {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  writeSecret(PENDING, [
    `GTM_PKCE_VERIFIER=${verifier}`,
    `GTM_OAUTH_STATE=${state}`,
    `CREATED_AT=${new Date().toISOString()}`,
  ]);
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', client.GOOGLE_ADS_CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'false');
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  console.log(u.toString());
} else if (cmd === 'exchange') {
  const arg = process.argv[3] || '';
  let code = arg;
  let state = null;
  if (/^https?:\/\//.test(arg)) {
    const u = new URL(arg);
    code = u.searchParams.get('code') || '';
    state = u.searchParams.get('state');
  }
  const pending = dotenv(PENDING);
  if (!pending.GTM_PKCE_VERIFIER) {
    console.error('no pending link; run `link` first');
    process.exit(1);
  }
  if (state && state !== pending.GTM_OAUTH_STATE) {
    console.error('state mismatch');
    process.exit(1);
  }
  if (!code) {
    console.error('no code');
    process.exit(1);
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.GOOGLE_ADS_CLIENT_ID,
      client_secret: client.GOOGLE_ADS_CLIENT_SECRET,
      redirect_uri: REDIRECT,
      code_verifier: pending.GTM_PKCE_VERIFIER,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.refresh_token) {
    console.error(
      'exchange failed: status ' + res.status + ' error=' + (body.error || '?') + ' ' + (body.error_description || ''),
    );
    process.exit(1);
  }
  writeSecret(OUT, [
    `GTM_REFRESH_TOKEN=${body.refresh_token}`,
    `GTM_SCOPE=${body.scope || ''}`,
    `GRANTED_AT=${new Date().toISOString()}`,
  ]);
  writeSecret(PENDING, ['# used']);
  console.log('ok: refresh token stored in ' + OUT + ' (0600); scopes granted: ' + (body.scope || '?'));
} else if (cmd === 'token') {
  const t = dotenv(OUT);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.GTM_REFRESH_TOKEN || '',
      client_id: client.GOOGLE_ADS_CLIENT_ID,
      client_secret: client.GOOGLE_ADS_CLIENT_SECRET,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    console.error('refresh failed: ' + res.status + ' ' + (body.error || ''));
    process.exit(1);
  }
  console.log('ok: access token minted (expires_in ' + body.expires_in + 's), scope: ' + (body.scope || '?'));
} else {
  console.error('usage: oauth.mjs link | exchange <url|code> | token');
  process.exit(2);
}
