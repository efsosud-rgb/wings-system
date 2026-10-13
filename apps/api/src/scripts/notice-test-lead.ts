import { WINGS_CLIENT_ID } from '@wings/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { loadDotEnv } from '../db/load-env.js';
import { crmNotifications, employees, leadTasks, leads } from '../db/schema/index.js';
import { loadEnv } from '../env.js';
import { createMailer } from '../lib/mailer.js';
import { sendPendingNoticeMails } from '../modules/leads/crm-notice-mail.js';
import { upsertLead } from '../modules/leads/service.js';

/**
 * The test of the new-lead notice (pop-up, bell and e-mail), made on purpose: one made-up lead owned by
 * a chosen person, born through the same door as a real arrival but without the rotation, then closed
 * as a test. Never on production: it refuses unless the app address is staging or local.
 *
 *   node dist/scripts/notice-test-lead.js estado --owner-email=<e-mail of the owner>
 *   node dist/scripts/notice-test-lead.js criar  --owner-email=<e-mail of the owner>
 *   node dist/scripts/notice-test-lead.js marcar --lead=<lead id>
 *
 * Runs inside the API container (it needs the API's own configuration). The output is ids, states and
 * the owner's first name — never an address.
 */
const TEST_NAME = 'Teste Aviso';
const CLOSED_NAME = 'TESTE — aviso de lead novo (ignorar)';
const flag = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const when = (date: Date | null) =>
  date?.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) ?? '-';

async function main() {
  loadDotEnv();
  const config = loadEnv(process.env);
  const mode = process.argv[2];
  if (!/staging\.|localhost|127\.0\.0\.1/.test(config.APP_BASE_URL)) {
    console.error('recusado: este teste só roda no staging ou no ambiente local');
    process.exit(2);
  }
  const ownerEmail = flag('owner-email');
  const leadId = flag('lead');
  if (!(mode === 'estado' || mode === 'criar' ? ownerEmail : mode === 'marcar' && leadId)) {
    console.error('uso: notice-test-lead estado|criar --owner-email=<e-mail> | marcar --lead=<id>');
    process.exit(2);
  }
  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    const switchOn = config.CRM_NOTICE_EMAIL_ENABLED === 'true';
    if (mode === 'marcar') {
      const closed = await db
        .update(leads)
        .set({ name: CLOSED_NAME, won: false, closedAt: new Date(), lostReason: 'Teste do aviso' })
        .where(and(eq(leads.id, leadId!), eq(leads.name, TEST_NAME), isNull(leads.won)))
        .returning({ id: leads.id });
      if (closed.length === 0) return console.error('nada marcado: não é um lead de teste aberto');
      await db
        .update(leadTasks)
        .set({ doneAt: new Date() })
        .where(and(eq(leadTasks.leadId, leadId!), isNull(leadTasks.doneAt)));
      return console.warn(`lead ${leadId} marcado como teste e encerrado`);
    }
    const [owner] = await db
      .select({ id: employees.id, name: employees.fullName, status: employees.status })
      .from(employees)
      .where(eq(employees.email, ownerEmail!.trim().toLowerCase()));
    const first = (owner?.name ?? '').trim().split(/\s+/)[0] ?? '';
    console.warn(
      `e-mail de aviso ${switchOn ? 'LIGADO' : 'desligado'}; SMTP ${createMailer(config).enabled ? 'configurado' : 'NÃO configurado'}; dono ${owner ? `${first} (${owner.status})` : 'não encontrado'}`,
    );
    if (mode === 'estado') return;
    if (!owner || owner.status !== 'active') {
      console.error('dono não encontrado ou inativo: nada criado');
      process.exit(1);
    }
    const stamp = String(Date.now()).slice(-6);
    const born = await upsertLead(db, {
      source: 'site_form',
      name: TEST_NAME,
      phone: `5511900${stamp}`,
      clientId: WINGS_CLIENT_ID,
      clientMapped: true,
      pipeline: 'formatacao',
      ownerEmployeeId: owner.id,
      campaignName: 'Teste do aviso de lead novo',
      skipResearch: true,
      event: { kind: 'lead.received.site_form' },
    });
    const pass = await sendPendingNoticeMails(db, {
      mailer: createMailer(config),
      enabled: switchOn,
      escalationEnabled: config.CRM_ESCALATION_EMAIL_ENABLED === 'true',
      baseUrl: config.APP_BASE_URL,
    });
    const [notice] = await db
      .select({
        id: crmNotifications.id,
        state: crmNotifications.emailState,
        at: crmNotifications.emailedAt,
        error: crmNotifications.emailError,
        created: crmNotifications.createdAt,
      })
      .from(crmNotifications)
      .where(and(eq(crmNotifications.leadId, born.lead.id), eq(crmNotifications.kind, 'new_lead')));
    console.warn(
      `lead ${born.lead.id} criado para ${first}; aviso ${notice?.id ?? '(nenhum)'} escrito ${when(notice?.created ?? null)}; e-mail ${notice?.state ?? '-'}${notice?.error ? ` (${notice.error})` : ''} ${when(notice?.at ?? null)}; passada: ${pass.sent} enviado(s), ${pass.skipped} pulado(s), ${pass.failed} falha(s)`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : 'erro');
  process.exit(1);
});
