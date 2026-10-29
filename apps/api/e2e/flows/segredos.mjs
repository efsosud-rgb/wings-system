// Flow 10 of the 27/10 audit: no password, invite token or session cookie of this run in the
// server log or in audit_log, no person's e-mail in the server log, and the sensitive actions
// audited. Prints counts only, never a value.
import pg from 'pg';
import { check, secrets } from '../lib.mjs';

export async function run({ acc, serverLog, databaseUrl }) {
  for (const a of Object.values(acc)) if (a.password) secrets.push(a.password);
  const scanned = secrets.filter((value) => value && value.length >= 12);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const audit = (await client.query('select row_to_json(a)::text as row from audit_log a')).rows
      .map((r) => r.row)
      .join('\n');
    const actions = new Set(
      (await client.query('select distinct action from audit_log')).rows.map((r) => r.action),
    );
    const inLog = scanned.filter((value) => serverLog.includes(value)).length;
    const inAudit = scanned.filter((value) => audit.includes(value)).length;
    const emailsInLog = Object.values(acc).filter((a) => serverLog.includes(a.email)).length;
    check(
      '10-segredos',
      `nenhum segredo da rodada no log do servidor (${scanned.length} verificados)`,
      scanned.length > 0 && inLog === 0,
      `encontrados=${inLog}`,
    );
    check(
      '10-segredos',
      'nenhum segredo da rodada na audit_log',
      inAudit === 0,
      `encontrados=${inAudit}`,
    );
    check(
      '10-segredos',
      'nenhum e-mail de pessoa no log do servidor',
      emailsInLog === 0,
      `encontrados=${emailsInLog}`,
    );
    for (const action of [
      'session.login',
      'credentials.invite_sent',
      'credentials.password_set',
      'lead.created',
      'lead.updated',
      'crm_stage.created',
    ])
      check('10-segredos', `auditoria tem "${action}"`, actions.has(action));
  } finally {
    await client.end();
  }
}
