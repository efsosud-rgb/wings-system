import { describe, expect, it } from 'vitest';
import { meetingCreateSchema, meetingSpeakersSchema, meetingUploadUrlSchema } from './meetings.js';

const base = {
  title: 'Diagnóstico',
  startsAt: '2026-10-08T14:00:00-03:00',
  endsAt: '2026-10-08T15:00:00-03:00',
};

describe('meeting contract', () => {
  it('needs a pasted link unless the Meet is created on Google', () => {
    expect(meetingCreateSchema.safeParse(base).success).toBe(false);
    expect(meetingCreateSchema.safeParse({ ...base, createMeet: true }).success).toBe(true);
    expect(
      meetingCreateSchema.safeParse({ ...base, meetUrl: 'https://meet.google.com/abc-defg-hij' })
        .success,
    ).toBe(true);
    expect(
      meetingCreateSchema.safeParse({ ...base, meetUrl: 'https://exemplo.com/x' }).success,
    ).toBe(false);
  });

  it('refuses an end before the start or longer than 8 hours', () => {
    expect(
      meetingCreateSchema.safeParse({ ...base, createMeet: true, endsAt: base.startsAt }).success,
    ).toBe(false);
    expect(
      meetingCreateSchema.safeParse({
        ...base,
        createMeet: true,
        endsAt: '2026-10-09T14:00:00-03:00',
      }).success,
    ).toBe(false);
  });

  it('accepts only recordings of the listed types and size', () => {
    expect(
      meetingUploadUrlSchema.safeParse({ contentType: 'audio/webm', sizeBytes: 1000 }).success,
    ).toBe(true);
    expect(
      meetingUploadUrlSchema.safeParse({ contentType: 'image/png', sizeBytes: 1000 }).success,
    ).toBe(false);
    expect(
      meetingUploadUrlSchema.safeParse({ contentType: 'video/mp4', sizeBytes: 2 * 1024 ** 3 })
        .success,
    ).toBe(false);
  });

  it('names speakers only by S1, S2…, and only when told who', () => {
    expect(meetingSpeakersSchema.safeParse({ S1: { label: 'Cliente' } }).success).toBe(true);
    expect(meetingSpeakersSchema.safeParse({ S1: {} }).success).toBe(false);
    expect(meetingSpeakersSchema.safeParse({ Joao: { label: 'x' } }).success).toBe(false);
  });
});
