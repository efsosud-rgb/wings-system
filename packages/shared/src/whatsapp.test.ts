import { describe, expect, it } from 'vitest';
import {
  brazilianPhoneVariants,
  canonicalWhatsAppPhone,
  templateParamCount,
  waSendKindOf,
  waSendMediaSchema,
  waStatusAdvances,
} from './whatsapp.js';

describe('WhatsApp helpers', () => {
  it('moves a status only forward, and a failure only before delivery', () => {
    expect(waStatusAdvances('pending', 'sent')).toBe(true);
    expect(waStatusAdvances('sent', 'read')).toBe(true);
    expect(waStatusAdvances('read', 'delivered')).toBe(false);
    expect(waStatusAdvances('sent', 'failed')).toBe(true);
    expect(waStatusAdvances('delivered', 'failed')).toBe(false);
    expect(waStatusAdvances('failed', 'read')).toBe(false);
    expect(waStatusAdvances('read', 'played')).toBe(true);
  });

  it('knows both forms of a Brazilian mobile, and only one of a landline', () => {
    expect(brazilianPhoneVariants('5521999990001')).toEqual(['5521999990001', '552199990001']);
    expect(brazilianPhoneVariants('552199990001')).toEqual(['5521999990001', '552199990001']);
    expect(brazilianPhoneVariants('552133330001')).toEqual(['552133330001']);
    expect(canonicalWhatsAppPhone('552199990001')).toBe('5521999990001');
    expect(canonicalWhatsAppPhone('15556696643')).toBe('15556696643');
  });

  it('counts the fields of a template body', () => {
    expect(templateParamCount('Olá {{1}}, aqui é {{2}}.')).toBe(2);
    expect(templateParamCount('Sem campos')).toBe(0);
    expect(templateParamCount(null)).toBe(0);
  });
});

describe('how a file of the deal goes on WhatsApp', () => {
  const kind = (mimeType: string, byteSize: number) => waSendKindOf({ mimeType, byteSize });

  it('sends a JPG or PNG up to 5 MB as a photo, and a bigger one or another image as a document', () => {
    expect(kind('image/jpeg', 5_000_000)).toEqual({ kind: 'image', type: 'image/jpeg' });
    expect(kind('image/png', 100)).toEqual({ kind: 'image', type: 'image/png' });
    expect(kind('image/jpeg', 5_000_001)).toEqual({ kind: 'document', type: 'image/jpeg' });
    expect(kind('image/webp', 100)).toEqual({ kind: 'document', type: 'image/webp' });
    expect(kind('image/heic', 100)?.kind).toBe('document');
  });

  it('sends an MP4 or 3GP up to 16 MB as a video', () => {
    expect(kind('video/mp4', 16_000_000)).toEqual({ kind: 'video', type: 'video/mp4' });
    expect(kind('video/3gpp', 10)).toEqual({ kind: 'video', type: 'video/3gpp' });
    expect(kind('video/mp4', 16_000_001)?.kind).toBe('document');
    expect(kind('video/quicktime', 10)?.kind).toBe('document');
  });

  it("sends Meta's audio types as audio, an M4A under Meta's name for it", () => {
    for (const type of ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'])
      expect(kind(type, 1_000)).toEqual({ kind: 'audio', type });
    expect(kind('audio/x-m4a', 1_000)).toEqual({ kind: 'audio', type: 'audio/mp4' });
    expect(kind('audio/ogg; codecs=opus', 1_000)).toEqual({ kind: 'audio', type: 'audio/ogg' });
    expect(kind('audio/wav', 1_000)?.kind).toBe('document');
    expect(kind('audio/mpeg', 16_000_001)?.kind).toBe('document');
  });

  it('sends anything else as a document up to 100 MB, and nothing above', () => {
    expect(kind('application/pdf', 100_000_000)).toEqual({
      kind: 'document',
      type: 'application/pdf',
    });
    expect(kind('', 10)).toEqual({ kind: 'document', type: 'application/octet-stream' });
    expect(kind('application/pdf', 100_000_001)).toBeNull();
    expect(kind('video/mp4', 100_000_001)).toBeNull();
  });

  it('takes a file id and a caption of up to 1024 characters', () => {
    const fileId = '00000000-0000-4000-8000-000000000001';
    expect(waSendMediaSchema.safeParse({ fileId }).success).toBe(true);
    expect(waSendMediaSchema.parse({ fileId, caption: '  oi  ' }).caption).toBe('oi');
    expect(waSendMediaSchema.safeParse({ fileId, caption: 'x'.repeat(1025) }).success).toBe(false);
    expect(waSendMediaSchema.safeParse({ fileId: 'nope' }).success).toBe(false);
  });
});
