import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { employees } from './employees.js';
import { leads } from './leads.js';

/**
 * Reuniões (docs/crm/reunioes-api.md): one row per meeting of a deal, with its
 * independent tracks (agenda, recording, transcript, AI analysis, and the
 * summary sent to a franchisor after approval). Attendees, transcript and
 * analysis are personal data: shown on the deal page only, never logged.
 */
export const crmMeetings = pgTable(
  'crm_meetings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadId: uuid('lead_id')
      .notNull()
      .references(() => leads.id),
    ownerEmployeeId: uuid('owner_employee_id')
      .notNull()
      .references(() => employees.id),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** MeetingCalendar: 'vendedor' | 'wings'. */
    calendar: text('calendar').notNull().default('vendedor'),
    /** MeetingStatus: 'agendada' | 'em_andamento' | 'encerrada' | 'cancelada'. */
    status: text('status').notNull().default('agendada'),
    meetUrl: text('meet_url'),
    googleEventId: text('google_event_id'),
    /** MeetingAttendee[] (e-mails: personal data). */
    attendees: jsonb('attendees').notNull().default([]),

    recordingState: text('recording_state').notNull().default('nenhuma'),
    /** Storage key chosen by the server; never part of an answer. */
    recordingKey: text('recording_key'),
    recordingFileId: uuid('recording_file_id'),
    recordingContentType: text('recording_content_type'),
    recordingSizeBytes: bigint('recording_size_bytes', { mode: 'number' }),
    recordingDurationSeconds: integer('recording_duration_seconds'),

    transcriptState: text('transcript_state').notNull().default('nenhuma'),
    /** { language, durationSeconds, segments: MeetingSegment[] }. */
    transcript: jsonb('transcript'),
    speakers: jsonb('speakers').notNull().default([]),
    speakersReason: text('speakers_reason'),
    transcriptError: text('transcript_error'),
    transcriptJobId: uuid('transcript_job_id'),

    analysisState: text('analysis_state').notNull().default('nenhuma'),
    analysis: jsonb('analysis'),
    analysisCostMicroUsd: bigint('analysis_cost_micro_usd', { mode: 'number' }),
    analysisReason: text('analysis_reason'),
    analyzedAt: timestamp('analyzed_at', { withTimezone: true }),

    /** SummarySendState; 'nenhum' outside Expansão. */
    sendState: text('send_state').notNull().default('nenhum'),
    sendChannel: text('send_channel'),
    /** The franchisor contact the summary goes to: its role on the client record ('principal'). */
    sendContactRole: text('send_contact_role'),
    sendText: text('send_text'),
    sendApprovedBy: uuid('send_approved_by').references(() => employees.id),
    sendApprovedAt: timestamp('send_approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    sendError: text('send_error'),

    createdBy: uuid('created_by').references(() => employees.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('crm_meetings_lead_idx').on(table.leadId, table.startsAt),
    index('crm_meetings_analysis_idx').on(table.analysisState),
  ],
);
