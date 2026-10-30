import { WA_VOICE_MAX_BYTES, WA_VOICE_MAX_SECONDS } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import { fakeRecording } from './voice-fixtures.js';
import { oggOpusSeconds, toVoiceNote, voiceFileName } from './voice.js';

/**
 * The recording turned into a WhatsApp voice note with the real ffmpeg: OGG/OPUS mono from what
 * each browser records, its length read from the file itself, and the limits.
 */

describe('turning a recording into a voice note', () => {
  it.each(['webm', 'ogg', 'mp4'] as const)(
    'turns a %s recording into OGG/OPUS mono of the same length',
    async (container) => {
      const note = await toVoiceNote(await fakeRecording(3, container));
      expect(note.ok).toBe(true);
      if (!note.ok) return;
      expect(note.bytes.subarray(0, 4).toString()).toBe('OggS');
      const head = note.bytes.indexOf('OpusHead');
      expect(head).toBeGreaterThan(0);
      // OpusHead: version (1 byte), then the channel count.
      expect(note.bytes[head + 9]).toBe(1);
      expect(note.seconds).toBe(3);
      expect(note.bytes.length).toBeLessThan(WA_VOICE_MAX_BYTES);
    },
  );

  it('keeps the longest one allowed under the 512 KB Meta plays inline', async () => {
    const note = await toVoiceNote(await fakeRecording(WA_VOICE_MAX_SECONDS));
    expect(note).toMatchObject({ ok: true, seconds: WA_VOICE_MAX_SECONDS });
    if (note.ok) expect(note.bytes.length).toBeLessThanOrEqual(WA_VOICE_MAX_BYTES);
  }, 30_000);

  it('refuses one past the limit, and bytes that are not audio', async () => {
    expect(await toVoiceNote(await fakeRecording(WA_VOICE_MAX_SECONDS + 5))).toEqual({
      ok: false,
      why: 'too_long',
    });
    expect(await toVoiceNote(Buffer.from('isto não é um áudio'))).toEqual({
      ok: false,
      why: 'unreadable',
    });
  }, 30_000);

  it('reads the length only from an OGG/OPUS file', async () => {
    expect(oggOpusSeconds(Buffer.from('OggS but nothing else'))).toBeNull();
    expect(oggOpusSeconds(await fakeRecording(1, 'mp4'))).toBeNull();
    const note = await toVoiceNote(await fakeRecording(2, 'ogg'));
    if (note.ok) expect(oggOpusSeconds(note.bytes)).toBeCloseTo(2, 1);
  });

  it('names the file by the São Paulo time it was recorded', () => {
    expect(voiceFileName(new Date('2026-10-30T18:30:12Z'))).toBe(
      'audio-whatsapp-2026-10-30-153012.ogg',
    );
  });
});
