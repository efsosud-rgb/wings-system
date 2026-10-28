// Flows 0–2 of the 27/10 audit: logins; an authorized seller creates, moves and notes a lead;
// someone without scope is blocked (other seller, other pipeline, Diretoria read-only, no session, CSRF).
import { call, check, login } from '../lib.mjs';

export async function run({ acc, sessions }) {
  for (const key of ['admin', 'diretor', 'gerente', 'mktGestor', 'vendA', 'vendB', 'vendF']) {
    const r = await login(acc[key].email, acc[key].password);
    sessions[key] = r.cookie;
    check('0-login', `login ${key}`, r.status === 200 && Boolean(r.cookie), `HTTP ${r.status}`);
  }
  const s = sessions;

  // Flow 1: authorized user creates and updates a lead
  const created = await call(s.vendA, 'POST', '/leads', {
    name: 'Lead Sintético E2E',
    phone: '11 90000-0001',
    email: 'lead-e2e-1@e2e.invalid',
    pipeline: 'expansao',
    ownerEmployeeId: 'me',
  });
  const leadId = created.json?.lead?.id ?? created.json?.id;
  check(
    '1-lead',
    'vendedor A cria lead',
    [200, 201].includes(created.status) && Boolean(leadId),
    `HTTP ${created.status}`,
  );
  // A fresh base has only the entry stage: the manager adds one (crm.manage), the seller moves into it.
  const madeStage = await call(s.gerente, 'POST', '/crm/stages', {
    pipeline: 'expansao',
    name: `Etapa E2E ${Date.now()}`,
  });
  check(
    '1-lead',
    'Gerente cria uma etapa (crm.manage)',
    [200, 201].includes(madeStage.status),
    `HTTP ${madeStage.status}`,
  );
  const sellerStage = await call(s.vendA, 'POST', '/crm/stages', {
    pipeline: 'expansao',
    name: 'Etapa do vendedor',
  });
  check(
    '1-lead',
    'vendedor não cria etapa (sem crm.manage)',
    sellerStage.status === 403,
    `HTTP ${sellerStage.status}`,
  );
  const stages = await call(s.vendA, 'GET', '/crm/stages?pipeline=expansao');
  const target = stages.json?.stages?.find((st) => st.id !== created.json?.lead?.work?.stageId)?.id;
  check('1-lead', 'há uma etapa de destino', Boolean(target));
  const moved = await call(s.vendA, 'PATCH', `/leads/${leadId}`, { stageId: target });
  check(
    '1-lead',
    'vendedor A muda a etapa do próprio lead',
    moved.status === 200,
    `HTTP ${moved.status}`,
  );
  const note = await call(s.vendA, 'POST', `/leads/${leadId}/notes`, {
    body: 'Anotação sintética E2E',
  });
  check(
    '1-lead',
    'vendedor A anota no próprio lead',
    [200, 201].includes(note.status),
    `HTTP ${note.status}`,
  );
  const reread = await call(s.vendA, 'GET', `/leads/${leadId}`);
  const stageNow = reread.json?.lead?.work?.stageId;
  check(
    '1-lead',
    'a releitura mostra a etapa nova',
    reread.status === 200 && Boolean(target) && stageNow === target,
    `stage ok=${stageNow === target}`,
  );

  // Flow 2: no scope -> blocked
  for (const [who, method, path, body] of [
    ['vendB', 'GET', `/leads/${leadId}`],
    ['vendB', 'PATCH', `/leads/${leadId}`, { stageId: target }],
    ['vendB', 'POST', `/leads/${leadId}/notes`, { body: 'tentativa' }],
    ['vendB', 'PATCH', `/leads/${leadId}`, { ownerEmployeeId: acc.vendB.id }],
    ['vendF', 'GET', `/leads/${leadId}`],
  ]) {
    const r = await call(s[who], method, path, body);
    check(
      '2-escopo',
      `${who} ${method} ${path.replace(leadId, ':id')} no lead de A`,
      [403, 404].includes(r.status),
      `HTTP ${r.status}`,
    );
  }
  const listB = await call(s.vendB, 'GET', '/leads?limit=200');
  const leakB = JSON.stringify(listB.json ?? {}).includes(leadId);
  check(
    '2-escopo',
    'lista do vendedor B não traz o lead de A',
    listB.status === 200 && !leakB,
    `HTTP ${listB.status}`,
  );
  const dirRead = await call(s.diretor, 'GET', `/leads/${leadId}`);
  check('2-escopo', 'Diretoria lê (escopo all)', dirRead.status === 200, `HTTP ${dirRead.status}`);
  const dirWrite = await call(s.diretor, 'PATCH', `/leads/${leadId}`, {
    stageId: stages.json?.stages?.[0]?.id,
  });
  check(
    '2-escopo',
    'Diretoria não edita (sem leads.write)',
    dirWrite.status === 403,
    `HTTP ${dirWrite.status}`,
  );
  const noSession = await call(null, 'GET', `/leads/${leadId}`);
  check('2-escopo', 'sem sessão → 401', noSession.status === 401, `HTTP ${noSession.status}`);
  const foreign = await call(
    s.vendA,
    'POST',
    `/leads/${leadId}/notes`,
    { body: 'csrf' },
    'http://site-malicioso.invalid',
  );
  check(
    '2-escopo',
    'POST com Origin estranha → 403 (CSRF)',
    foreign.status === 403,
    `HTTP ${foreign.status}`,
  );
}
