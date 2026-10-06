import { z } from 'zod';

/**
 * Reuniões (docs/crm/reunioes-api.md): the contract between the API and the
 * deal page. A meeting belongs to one deal and one owner, and moves along
 * independent tracks: agenda, recording, transcript, AI analysis and, in
 * Expansão, the summary sent to the franchisor's owner after approval.
 */

export const MEETING_STATUSES = ['agendada', 'em_andamento', 'encerrada', 'cancelada'] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const MEETING_CALENDARS = ['vendedor', 'wings'] as const;
export type MeetingCalendar = (typeof MEETING_CALENDARS)[number];

export const RECORDING_STATES = ['nenhuma', 'enviando', 'guardada', 'falhou'] as const;
export type RecordingState = (typeof RECORDING_STATES)[number];

export const TRANSCRIPT_STATES = [
  'nenhuma',
  'na_fila',
  'transcrevendo',
  'pronta',
  'falhou',
] as const;
export type TranscriptState = (typeof TRANSCRIPT_STATES)[number];

export const ANALYSIS_STATES = [
  'nenhuma',
  'na_fila',
  'analisando',
  'pronta',
  'falhou',
  'sem_verba',
] as const;
export type AnalysisState = (typeof ANALYSIS_STATES)[number];

export const SUMMARY_SEND_STATES = [
  'nenhum',
  'rascunho',
  'aprovado',
  /** The one attempt is under way (claimed so a double click never sends twice). */
  'enviando',
  'enviado',
  'recusado',
  'falhou',
] as const;
export type SummarySendState = (typeof SUMMARY_SEND_STATES)[number];

export const SUMMARY_SEND_CHANNELS = ['email', 'whatsapp'] as const;
export type SummarySendChannel = (typeof SUMMARY_SEND_CHANNELS)[number];

export const MEETING_STATUS_LABELS: Record<MeetingStatus, string> = {
  agendada: 'Agendada',
  em_andamento: 'Em andamento',
  encerrada: 'Encerrada',
  cancelada: 'Cancelada',
};

/** Recording types the upload accepts, and its ceiling (about 3 h of Meet video). */
export const MEETING_RECORDING_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'video/webm',
  'video/mp4',
] as const;
export const MEETING_RECORDING_MAX_BYTES = 1.5 * 1024 ** 3;
export const MEETING_MAX_HOURS = 8;
export const MEETING_MAX_ATTENDEES = 20;

/** A Meet (or Zoom/Teams) link, as `lead_activities` already accepts. */
const meetUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) =>
      /^https:\/\/(meet\.google\.com|([a-z0-9-]+\.)?zoom\.us|teams\.microsoft\.com)\//i.test(value),
    'Link de reunião do Google Meet, Zoom ou Teams',
  );

const attendeeSchema = z.object({
  email: z.email('E-mail inválido').trim().max(200),
  name: z.string().trim().max(120).nullish(),
});

const meetingWindow = <T extends { startsAt?: string; endsAt?: string }>(value: T) =>
  !value.startsAt ||
  !value.endsAt ||
  (Date.parse(value.startsAt) < Date.parse(value.endsAt) &&
    Date.parse(value.endsAt) - Date.parse(value.startsAt) <= MEETING_MAX_HOURS * 3_600_000);

export const meetingCreateSchema = z
  .object({
    title: z.string().trim().min(2, 'Dê um título').max(160),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
    calendar: z.enum(MEETING_CALENDARS).default('vendedor'),
    attendees: z.array(attendeeSchema).max(MEETING_MAX_ATTENDEES).default([]),
    /** Pasted link, when the meeting is not created on Google. */
    meetUrl: meetUrlSchema.nullish(),
    /** Create the event (and its Meet) on Google; 503 google_not_connected until authorised. */
    createMeet: z.boolean().default(false),
  })
  .refine(meetingWindow, {
    message: 'O fim vem depois do início, em até 8 horas',
    path: ['endsAt'],
  })
  .refine((value) => value.createMeet || Boolean(value.meetUrl), {
    message: 'Cole o link da reunião ou crie o Meet pelo Google',
    path: ['meetUrl'],
  });
export type MeetingCreateInput = z.infer<typeof meetingCreateSchema>;

export const meetingUpdateSchema = z
  .object({
    title: z.string().trim().min(2).max(160).optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).optional(),
    attendees: z.array(attendeeSchema).max(MEETING_MAX_ATTENDEES).optional(),
    meetUrl: meetUrlSchema.nullish(),
    status: z.literal('cancelada').optional(),
  })
  .refine(meetingWindow, {
    message: 'O fim vem depois do início, em até 8 horas',
    path: ['endsAt'],
  });
export type MeetingUpdateInput = z.infer<typeof meetingUpdateSchema>;

export const meetingUploadUrlSchema = z.object({
  contentType: z.enum(MEETING_RECORDING_TYPES),
  sizeBytes: z.number().int().positive().max(MEETING_RECORDING_MAX_BYTES),
});
export type MeetingUploadUrlInput = z.infer<typeof meetingUploadUrlSchema>;

export const meetingRecordingCompleteSchema = z.object({ fileId: z.uuid() });

export const meetingSpeakersSchema = z.record(
  z.string().regex(/^S\d{1,2}$/),
  z
    .object({
      employeeId: z.uuid().nullish(),
      attendeeEmail: z.email().nullish(),
      label: z.string().trim().max(60).nullish(),
    })
    .refine((v) => Boolean(v.employeeId || v.attendeeEmail || v.label), 'Diga quem é'),
);
export type MeetingSpeakersInput = z.infer<typeof meetingSpeakersSchema>;

export const summarySendCreateSchema = z.object({
  channel: z.enum(SUMMARY_SEND_CHANNELS).default('email'),
});
export const summarySendUpdateSchema = z.object({
  text: z.string().trim().min(20).max(4000),
});

// --- answers ---------------------------------------------------------------------------------

export interface MeetingAttendee {
  email: string;
  name: string | null;
  /** As Google reports it; null for a pasted-link meeting. */
  responseStatus: 'aceitou' | 'recusou' | 'talvez' | 'sem_resposta' | null;
}

export interface MeetingSummary {
  id: string;
  leadId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: MeetingStatus;
  calendar: MeetingCalendar;
  meetUrl: string | null;
  ownerEmployeeId: string;
  recordingState: RecordingState;
  transcriptState: TranscriptState;
  analysisState: AnalysisState;
  summarySendState: SummarySendState;
}

export interface MeetingSpeaker {
  key: string;
  label: string | null;
  employeeId: string | null;
  attendeeEmail: string | null;
}

export interface MeetingSegment {
  start: number;
  end: number;
  /** "S1", "S2"…; null while speaker separation is not on (see speakersReason). */
  speaker: string | null;
  text: string;
}

export interface MeetingTranscript {
  state: TranscriptState;
  language: string | null;
  durationSeconds: number | null;
  speakers: MeetingSpeaker[];
  speakersReason: string | null;
  segments: MeetingSegment[];
  error: string | null;
}

export interface MeetingNextStep {
  what: string;
  owner: 'vendedor' | 'cliente' | 'wings' | 'outro';
  dueAt: string | null;
  /** Set once a person turned it into a task. */
  taskId: string | null;
}

export interface MeetingAnalysis {
  state: AnalysisState;
  summary: string | null;
  topics: string[];
  participants: { speaker: string | null; role: string; suggestedName: string | null }[];
  nextSteps: MeetingNextStep[];
  leadEvaluation: {
    score: number;
    fit: 'bom' | 'medio' | 'fraco';
    reasons: string[];
    risks: string[];
  } | null;
  model: string | null;
  costUsd: number | null;
  analyzedAt: string | null;
  /** Why there is none, when state is not "pronta". */
  reason: string | null;
}

export interface MeetingSummarySend {
  state: SummarySendState;
  channel: SummarySendChannel | null;
  /** Masked: "p•••@exemplo.com.br" or "+55 21 •••• 7777". */
  to: string | null;
  text: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  error: string | null;
}

export interface Meeting extends MeetingSummary {
  attendees: MeetingAttendee[];
  googleEventId: string | null;
  recording: {
    state: RecordingState;
    fileId: string | null;
    durationSeconds: number | null;
    sizeBytes: number | null;
  };
  transcript: { state: TranscriptState; segments: number; error: string | null };
  analysis: MeetingAnalysis;
  summarySend: MeetingSummarySend | null;
  createdAt: string;
  updatedAt: string;
}
