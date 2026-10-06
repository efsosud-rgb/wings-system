import {
  type AgentModel,
  type Meeting,
  type MeetingAnalysis,
  type MeetingAttendee,
  type MeetingSegment,
  type MeetingSpeaker,
  type MeetingSummary,
  type MeetingSummarySend,
  type MeetingTranscript,
} from '@wings/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db/client.js';
import { crmMeetings, leads } from '../../db/schema/index.js';
import type { AgentLlm } from '../agent/llm.js';
import { analyzeMeeting } from './analysis.js';

export type MeetingRow = typeof crmMeetings.$inferSelect;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function toMeetingSummary(row: MeetingRow): MeetingSummary {
  return {
    id: row.id,
    leadId: row.leadId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status as MeetingSummary['status'],
    calendar: row.calendar as MeetingSummary['calendar'],
    meetUrl: row.meetUrl,
    ownerEmployeeId: row.ownerEmployeeId,
    recordingState: row.recordingState as MeetingSummary['recordingState'],
    transcriptState: row.transcriptState as MeetingSummary['transcriptState'],
    analysisState: row.analysisState as MeetingSummary['analysisState'],
    summarySendState: row.sendState as MeetingSummary['summarySendState'],
  };
}

type StoredTranscript = {
  language?: string;
  durationSeconds?: number;
  segments?: MeetingSegment[];
};

const segmentsOf = (row: MeetingRow): MeetingSegment[] =>
  Array.isArray((row.transcript as StoredTranscript | null)?.segments)
    ? ((row.transcript as StoredTranscript).segments as MeetingSegment[])
    : [];

export function toAnalysis(row: MeetingRow): MeetingAnalysis {
  const stored = (row.analysis ?? null) as Partial<MeetingAnalysis> | null;
  return {
    state: row.analysisState as MeetingAnalysis['state'],
    summary: stored?.summary ?? null,
    topics: stored?.topics ?? [],
    participants: stored?.participants ?? [],
    nextSteps: stored?.nextSteps ?? [],
    leadEvaluation: stored?.leadEvaluation ?? null,
    model: stored?.model ?? null,
    costUsd: row.analysisCostMicroUsd === null ? null : row.analysisCostMicroUsd / 1e6,
    analyzedAt: iso(row.analyzedAt),
    reason: row.analysisReason,
  };
}

/** "p•••@exemplo.com.br", "+55 21 •••• 7777": who gets the summary, without showing all of it. */
export function maskContact(channel: string | null, value: string | null): string | null {
  if (!value) return null;
  if (channel === 'whatsapp') {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 8
      ? `+${digits.slice(0, 2)} ${digits.slice(2, 4)} •••• ${digits.slice(-4)}`
      : '••••';
  }
  const [user = '', domain = ''] = value.split('@');
  return `${user.slice(0, 1)}•••@${domain}`;
}

export function toSummarySend(row: MeetingRow, to: string | null): MeetingSummarySend | null {
  if (row.sendState === 'nenhum') return null;
  return {
    state: row.sendState as MeetingSummarySend['state'],
    channel: row.sendChannel as MeetingSummarySend['channel'],
    to,
    text: row.sendText,
    approvedBy: row.sendApprovedBy,
    approvedAt: iso(row.sendApprovedAt),
    sentAt: iso(row.sentAt),
    error: row.sendError,
  };
}

export function toMeeting(row: MeetingRow, sendTo: string | null = null): Meeting {
  return {
    ...toMeetingSummary(row),
    attendees: Array.isArray(row.attendees) ? (row.attendees as MeetingAttendee[]) : [],
    googleEventId: row.googleEventId,
    recording: {
      state: row.recordingState as Meeting['recording']['state'],
      fileId: row.recordingFileId,
      durationSeconds: row.recordingDurationSeconds,
      sizeBytes: row.recordingSizeBytes,
    },
    transcript: {
      state: row.transcriptState as Meeting['transcript']['state'],
      segments: segmentsOf(row).length,
      error: row.transcriptError,
    },
    analysis: toAnalysis(row),
    summarySend: toSummarySend(row, sendTo),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toTranscript(row: MeetingRow): MeetingTranscript {
  const stored = (row.transcript ?? null) as StoredTranscript | null;
  return {
    state: row.transcriptState as MeetingTranscript['state'],
    language: stored?.language ?? null,
    durationSeconds: stored?.durationSeconds ?? null,
    speakers: Array.isArray(row.speakers) ? (row.speakers as MeetingSpeaker[]) : [],
    speakersReason: row.speakersReason,
    segments: segmentsOf(row),
    error: row.transcriptError,
  };
}

// --- AI analysis -----------------------------------------------------------------------------

export interface MeetingAnalysisDeps {
  db: Database;
  llm: AgentLlm | null;
  model: AgentModel;
  /** MEETINGS_DAILY_USD: the company's daily ceiling for meeting analyses. */
  dailyUsd: number;
  now: () => Date;
  log: FastifyBaseLogger;
}

/** Spent today (UTC day) on meeting analyses, in micro-USD, failed runs included. */
async function spentToday(db: Database, now: Date): Promise<number> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db
    .select({ total: sql<string | null>`sum(${crmMeetings.analysisCostMicroUsd})` })
    .from(crmMeetings)
    .where(gte(crmMeetings.analyzedAt, day));
  return Number(row?.total ?? 0);
}

/** Runs one queued analysis; never throws (a failure is a state with a reason). */
export async function runMeetingAnalysis(
  deps: MeetingAnalysisDeps,
  meetingId: string,
): Promise<void> {
  // Claim the row: only a queued one moves to "analisando", so two runners never both pay.
  const [claimed] = await deps.db
    .update(crmMeetings)
    .set({ analysisState: 'analisando', analysisReason: null, updatedAt: deps.now() })
    .where(and(eq(crmMeetings.id, meetingId), eq(crmMeetings.analysisState, 'na_fila')))
    .returning();
  if (!claimed) return;
  const finish = (patch: Partial<typeof crmMeetings.$inferInsert>) =>
    deps.db
      .update(crmMeetings)
      .set({ ...patch, updatedAt: deps.now() })
      .where(eq(crmMeetings.id, meetingId));

  if (!deps.llm) {
    await finish({
      analysisState: 'falhou',
      analysisReason: 'Modelo de IA não configurado neste ambiente',
    });
    return;
  }
  if ((await spentToday(deps.db, deps.now())) >= deps.dailyUsd * 1e6) {
    await finish({
      analysisState: 'sem_verba',
      analysisReason: `Teto diário de análise de reuniões (US$ ${deps.dailyUsd}) atingido; tente amanhã`,
    });
    return;
  }
  const segments = segmentsOf(claimed);
  if (!segments.length) {
    await finish({ analysisState: 'falhou', analysisReason: 'A transcrição está vazia' });
    return;
  }
  const [lead] = await deps.db
    .select({ pipeline: leads.pipeline, stage: leads.stage })
    .from(leads)
    .where(eq(leads.id, claimed.leadId));
  try {
    const outcome = await analyzeMeeting(deps.llm, deps.model, {
      segments,
      pipeline: lead?.pipeline ?? null,
      stage: lead?.stage ?? null,
      now: deps.now(),
    });
    const cost = Math.round(outcome.costUsd * 1e6);
    if (!outcome.ok) {
      await finish({
        analysisState: 'falhou',
        analysisReason: outcome.reason,
        analysisCostMicroUsd: cost,
        analyzedAt: deps.now(),
      });
      return;
    }
    await finish({
      analysisState: 'pronta',
      analysis: outcome.analysis,
      analysisCostMicroUsd: cost,
      analyzedAt: deps.now(),
    });
    deps.log.info({ meetingId, costMicroUsd: cost }, 'meeting analysed');
  } catch {
    await finish({
      analysisState: 'falhou',
      analysisReason: 'O modelo não respondeu; tente de novo',
      analyzedAt: deps.now(),
    });
  }
}

/** Every queued analysis (the worker queues one when a transcript is ready), a few at a time. */
export async function runQueuedAnalyses(deps: MeetingAnalysisDeps, limit = 3): Promise<number> {
  const queued = await deps.db
    .select({ id: crmMeetings.id })
    .from(crmMeetings)
    .where(eq(crmMeetings.analysisState, 'na_fila'))
    .limit(limit);
  for (const { id } of queued) await runMeetingAnalysis(deps, id);
  return queued.length;
}
