import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../db/client.js';
import { roadmapDeliverables, roadmapModules, roadmapReportRecipients, roadmapReportRuns } from '../../db/schema/index.js';
import { loadEnv } from '../../env.js';
import { createTestDatabase, type TestDatabase } from '../../test/db.js';
import { TEST_CPF_KEY, TEST_INDEX_KEY } from '../../test/factories.js';
import type { RoadmapNotifier } from './notifiers/factory.js';
import { runPreviewJob, runSendJob } from './report-jobs.js';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness?.drop();
});

function fakeEnv(overrides: Partial<{ ROADMAP_REPORT_SEND_ENABLED: boolean }> = {}) {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: harness.url,
    SESSION_SECRET: 'x'.repeat(48),
    CPF_ENCRYPTION_KEY: TEST_CPF_KEY,
    CPF_INDEX_KEY: TEST_INDEX_KEY,
    APP_BASE_URL: 'http://localhost:5173',
    ROADMAP_REPORT_SEND_ENABLED: overrides.ROADMAP_REPORT_SEND_ENABLED ? 'true' : 'false',
  });
}

class RecordingNotifier implements RoadmapNotifier {
  sent: { phone: string; message: string }[] = [];
  async sendText(phone: string, message: string) {
    this.sent.push({ phone, message });
  }
}

async function seedModuleWithDeliverable(label: string) {
  const [module] = await db
    .insert(roadmapModules)
    .values({ key: `jobs-test-${Date.now()}-${Math.random()}`, label: 'Módulo', position: 0 })
    .returning();
  if (!module) throw new Error('seed failed');
  await db.insert(roadmapDeliverables).values({ moduleId: module.id, label, weight: 'M', status: 'pendente' });
}

describe('runPreviewJob', () => {
  it('skips on a weekend (America/Sao_Paulo), sending nothing', async () => {
    const saturday = new Date('2026-09-26T15:00:00Z');
    const notifier = new RecordingNotifier();
    const result = await runPreviewJob(db, fakeEnv(), { llm: null, notifier, log: () => {} }, saturday);
    expect(result.skipped).toBe('weekend');
    expect(result.runId).toBeNull();
    expect(notifier.sent).toHaveLength(0);
  });

  it('creates a draft run and notifies preview recipients on a weekday', async () => {
    await seedModuleWithDeliverable('Entregável A');
    await db.insert(roadmapReportRecipients).values({
      role: 'preview',
      name: 'Eric',
      phone: '11999998888',
      active: true,
    });
    const thursday = new Date('2026-10-01T15:00:00Z'); // a weekday
    const notifier = new RecordingNotifier();
    const result = await runPreviewJob(db, fakeEnv(), { llm: null, notifier, log: () => {} }, thursday);
    expect(result.skipped).toBeNull();
    expect(result.runId).not.toBeNull();
    expect(notifier.sent.length).toBeGreaterThan(0);
    expect(notifier.sent[0]?.message).toContain('administracao/roadmap/relatorios');
  });
});

describe('runSendJob', () => {
  it('never sends an unapproved (rascunho) run', async () => {
    const reportDate = '2026-10-02';
    await db.insert(roadmapReportRuns).values({
      reportDate,
      status: 'rascunho',
      computed: { reportDate, modules: [], weightedTotalPercent: null, velocity: { last4WeeksPerWeek: null, sinceStartPerWeek: null }, forecast: null, scopeChangePercent: null },
      messageText: 'rascunho de teste',
    });
    await db.insert(roadmapReportRecipients).values({ role: 'ceo', name: 'Umberto', phone: '11988887777', active: true });

    const notifier = new RecordingNotifier();
    const result = await runSendJob(
      db,
      fakeEnv({ ROADMAP_REPORT_SEND_ENABLED: true }),
      { notifier, log: () => {} },
      new Date(`${reportDate}T21:00:00Z`),
    );
    expect(result.outcome).toBe('not_approved');
    expect(notifier.sent).toHaveLength(0);
  });

  it('marks enviado_simulado and calls no notifier when ROADMAP_REPORT_SEND_ENABLED is false', async () => {
    const reportDate = '2026-10-03';
    const [run] = await db
      .insert(roadmapReportRuns)
      .values({
        reportDate,
        status: 'aprovado',
        computed: { reportDate, modules: [], weightedTotalPercent: null, velocity: { last4WeeksPerWeek: null, sinceStartPerWeek: null }, forecast: null, scopeChangePercent: null },
        messageText: 'relatório aprovado de teste',
      })
      .returning();
    if (!run) throw new Error('seed failed');
    await db.insert(roadmapReportRecipients).values({ role: 'ceo', name: 'Thais', phone: '11977776666', active: true });

    const notifier = new RecordingNotifier();
    const result = await runSendJob(
      db,
      fakeEnv({ ROADMAP_REPORT_SEND_ENABLED: false }),
      { notifier, log: () => {} },
      new Date(`${reportDate}T21:00:00Z`),
    );
    expect(result.outcome).toBe('simulated');
    expect(notifier.sent).toHaveLength(0);

    const [updated] = await db.select().from(roadmapReportRuns).where(eq(roadmapReportRuns.id, run.id));
    expect(updated?.status).toBe('enviado_simulado');
    expect(updated?.sentAt).not.toBeNull();
  });

  it('sends to every active ceo recipient and marks enviado when the flag is on', async () => {
    // Earlier tests in this file leave their own recipients behind; start clean.
    await db.delete(roadmapReportRecipients);
    const reportDate = '2026-10-04';
    const [run] = await db
      .insert(roadmapReportRuns)
      .values({
        reportDate,
        status: 'aprovado',
        computed: { reportDate, modules: [], weightedTotalPercent: null, velocity: { last4WeeksPerWeek: null, sinceStartPerWeek: null }, forecast: null, scopeChangePercent: null },
        messageText: 'relatório final de teste',
      })
      .returning();
    if (!run) throw new Error('seed failed');
    await db.insert(roadmapReportRecipients).values([
      { role: 'ceo', name: 'Umberto', phone: '11988887777', active: true },
      { role: 'ceo', name: 'Thais (inativa)', phone: '11900000000', active: false },
    ]);

    const notifier = new RecordingNotifier();
    const result = await runSendJob(
      db,
      fakeEnv({ ROADMAP_REPORT_SEND_ENABLED: true }),
      { notifier, log: () => {} },
      new Date(`${reportDate}T21:00:00Z`),
    );
    expect(result.outcome).toBe('sent');
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.message).toBe('relatório final de teste');

    const [updated] = await db.select().from(roadmapReportRuns).where(eq(roadmapReportRuns.id, run.id));
    expect(updated?.status).toBe('enviado');
  });

  it('logs and exits when there is no run for today', async () => {
    const notifier = new RecordingNotifier();
    const result = await runSendJob(
      db,
      fakeEnv({ ROADMAP_REPORT_SEND_ENABLED: true }),
      { notifier, log: () => {} },
      new Date('2026-12-25T21:00:00Z'),
    );
    expect(result.outcome).toBe('no_run');
    expect(notifier.sent).toHaveLength(0);
  });
});
