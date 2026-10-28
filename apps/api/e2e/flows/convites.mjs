// Flow 3 of the 27/10 audit: invites follow the sector. Outside it both invite routes refuse;
// inside it the e-mail reaches the fake SMTP, the link sets a password once, and the login works.
import { call, check, lastMailToken, login, mails, secrets, sleep } from '../lib.mjs';

export async function run({ acc, sessions: s, mailDir }) {
  for (const [who, alvo] of [
    ['mktGestor', 'alvoTI'],
    ['mktGestor', 'alvoCom'],
    ['gerente', 'alvoMkt'],
    ['gerente', 'alvoTI'],
  ]) {
    const a = await call(s[who], 'POST', '/auth/invite', { employeeId: acc[alvo].id });
    check(
      '3-convite',
      `${who} → /auth/invite para ${alvo} (fora do setor)`,
      a.status === 403 || a.status === 404,
      `HTTP ${a.status}`,
    );
    const b = await call(s[who], 'POST', `/employees/${acc[alvo].id}/invite`);
    check(
      '3-convite',
      `${who} → /employees/:id/invite para ${alvo} (fora do setor)`,
      b.status === 403 || b.status === 404,
      `HTTP ${b.status}`,
    );
  }
  const before = mails(mailDir).length;
  const okMkt = await call(s.mktGestor, 'POST', '/auth/invite', { employeeId: acc.alvoMkt.id });
  check(
    '3-convite',
    'gestor de Marketing convida alguém do próprio setor',
    [200, 201, 202].includes(okMkt.status),
    `HTTP ${okMkt.status}`,
  );
  const okCom = await call(s.gerente, 'POST', `/employees/${acc.alvoCom.id}/invite`);
  check(
    '3-convite',
    'Gerente Comercial convida alguém do Comercial',
    [200, 201, 202].includes(okCom.status),
    `HTTP ${okCom.status}`,
  );
  const okAdm = await call(s.admin, 'POST', '/auth/invite', { employeeId: acc.alvoTI.id });
  check(
    '3-convite',
    'Admin Master convida qualquer setor',
    [200, 201, 202].includes(okAdm.status),
    `HTTP ${okAdm.status}`,
  );
  await sleep(500);
  const arrived = mails(mailDir).length - before;
  check(
    '3-convite',
    'três e-mails de convite chegaram ao SMTP falso',
    arrived === 3,
    `novos=${arrived}`,
  );

  // Accept the admin's invite (last mail), reuse it, log in.
  const token = lastMailToken(mailDir);
  check('3-convite', 'o e-mail traz o link com token', Boolean(token));
  const newPassword = `Senha-E2E-${Date.now()}-x`;
  secrets.push(newPassword);
  const set1 = await call(null, 'POST', '/auth/set-password', { token, password: newPassword });
  check(
    '3-convite',
    'aceite do convite define a senha',
    [200, 204].includes(set1.status),
    `HTTP ${set1.status}`,
  );
  const set2 = await call(null, 'POST', '/auth/set-password', {
    token,
    password: `${newPassword}-2`,
  });
  check('3-convite', 'o mesmo link não serve de novo', set2.status >= 400, `HTTP ${set2.status}`);
  const invited = await login(acc.alvoTI.email, newPassword);
  check(
    '3-convite',
    'quem foi convidado entra com a senha escolhida',
    invited.status === 200,
    `HTTP ${invited.status}`,
  );
}
