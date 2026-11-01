// Flow 9 of the 27/10 audit: an integration without credentials is shown as not configured,
// never as "ok". Flows 4–8 (Google Places, WhatsApp, Sofia, Marketing, Dashboard) need a live
// platform or an AI model to run as a server, so they stay as integration tests with fakes
// inside `pnpm test` (see docs/invariantes.md).
import { call, check } from '../lib.mjs';

export async function run({ sessions: s }) {
  const meta = await call(s.admin, 'GET', '/crm/meta-leads/status');
  const body = JSON.stringify(meta.json);
  // Each switch by name: a loose match on the whole body passed on any null (lastReceivedAt).
  check(
    '9-falha',
    'status do Meta Lead Ads sem credencial não diz "ok"',
    meta.status === 200 &&
      meta.json?.tokenConfigured === false &&
      meta.json?.webhookConfigured === false &&
      meta.json?.polling?.enabled === false,
    `HTTP ${meta.status} ${body.slice(0, 160)}`,
  );
}
