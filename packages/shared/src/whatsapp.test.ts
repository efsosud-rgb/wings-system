import { describe, expect, it } from 'vitest';
import {
  brazilianPhoneVariants,
  canonicalWhatsAppPhone,
  templateParamCount,
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
