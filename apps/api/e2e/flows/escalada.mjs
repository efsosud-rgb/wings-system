// Privilege escalation A1, M1, A2 and A3 of the 27/10 audit, end to end. Each one must be refused;
// when one is not, the flow carries the attack through to say what was gained. No secret is printed.
// Still open (docs/invariantes.md, review of 27/10 P1–P3): sector-labelled Drive powers and the
// login e-mail of someone already above the manager. They are not here because they still pass.
import { call, check, lastMailToken, login, mails, sleep } from '../lib.mjs';

function makeCpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  for (const pos of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < pos; i++) sum += d[i] * (pos + 1 - i);
    const r = (sum * 10) % 11;
    d.push(r === 10 ? 0 : r);
  }
  return d.join('');
}

/** Takes over an account through a password link sent to an address the attacker controls. */
async function takeOver(mailDir, mailsBefore, address) {
  await sleep(800);
  const token = mails(mailDir).length > mailsBefore ? lastMailToken(mailDir) : undefined;
  if (!token) return { status: 0 };
  const password = `Tomada-${Date.now()}-x`;
  await call(null, 'POST', '/auth/set-password', { token, password });
  return login(address, password);
}

export async function run({ acc, mailDir }) {
  const rh = await login(acc.rh.email, acc.rh.password);
  const gerente = await login(acc.gerente.email, acc.gerente.password);
  const vendGestor = await login(acc.vendGestor.email, acc.vendGestor.password);
  check(
    'A-login',
    'login rh, gerente e vendedor gestor',
    [rh, gerente, vendGestor].every((r) => r.status === 200),
  );

  // A1: RH/DP changes a Diretoria member's login e-mail and resets the password there.
  const hijacked = 'e2e-tomada@e2e.invalid';
  const change = await call(rh.cookie, 'PATCH', `/employees/${acc.diretor.id}`, {
    email: hijacked,
  });
  let a1 = 'PROTEGIDO';
  if (change.status === 200) {
    const before = mails(mailDir).length;
    await call(null, 'POST', '/auth/forgot-password', { email: hijacked });
    if ((await takeOver(mailDir, before, hijacked)).status === 200) a1 = 'VULNERÁVEL';
  }
  check(
    'A1',
    'RH/DP não toma a conta da Diretoria trocando o e-mail de login',
    a1 === 'PROTEGIDO',
    `HTTP ${change.status} ${a1}`,
  );

  // M1: Gerente Comercial (no employees.deactivate) inactivates a seller.
  const off = await call(gerente.cookie, 'PATCH', `/employees/${acc.vendB.id}`, {
    status: 'inactive',
  });
  check(
    'M1',
    'Gerente Comercial não inativa sem employees.deactivate',
    off.status !== 200,
    `HTTP ${off.status}`,
  );

  // A2: Gerente Comercial creates a Marketing account (powers it lacks) at an address it controls.
  const gerentePerms =
    (await call(gerente.cookie, 'GET', '/auth/me')).json?.user?.permissions ?? {};
  const address = `e2e-a2-${Date.now()}@e2e.invalid`;
  const before = mails(mailDir).length;
  const created = await call(gerente.cookie, 'POST', '/employees', {
    fullName: 'Pessoa Sintética A2',
    cpf: makeCpf(),
    birthDate: '1990-01-01',
    phone: '11900000000',
    email: address,
    cargo: 'Analista',
    sector: 'comercial',
    role: 'marketing',
    admissionDate: '2026-10-01',
    status: 'active',
    isSectorManager: false,
  });
  let gained = [];
  if (created.status === 201) {
    const taken = await takeOver(mailDir, before, address);
    if (taken.status === 200) {
      const perms = (await call(taken.cookie, 'GET', '/auth/me')).json?.user?.permissions ?? {};
      gained = Object.keys(perms).filter((p) => !(p in gerentePerms));
    }
  }
  check(
    'A2',
    'Gerente Comercial não cria conta com poderes que ele não tem',
    created.status !== 201 || gained.length === 0,
    `HTTP ${created.status}, permissões ganhas=${gained.length}`,
  );

  // A3: a seller with the sector-manager flag switches off the Gerente Comercial.
  const off3 = await call(vendGestor.cookie, 'PATCH', `/employees/${acc.gerente.id}`, {
    status: 'inactive',
  });
  check(
    'A3',
    'vendedor com marca de gestor não inativa o Gerente',
    off3.status !== 200,
    `HTTP ${off3.status}`,
  );
}
