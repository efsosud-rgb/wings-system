import { describe, expect, it } from 'vitest';
import { rdConversionsOf } from './webhooks.js';

// The body the RD Station Marketing screen sends for "Lead convertido": a CONTACT event whose
// contact has no last_conversion and no page address. Every value here is made up.
const contactEvent = (overrides: Record<string, unknown> = {}) => ({
  event_type: 'WEBHOOK.CONVERTED',
  entity_type: 'CONTACT',
  event_timestamp: '2026-10-07T09:26:40.000-03:00',
  event_identifier: 'lp-formatacao-contato',
  timestamp: '2026-10-07T12:26:41.000Z',
  contact: {
    uuid: 'rd-uuid-contact-1',
    email: 'Eva@Example.com',
    name: 'Eva Lima',
    personal_phone: '(11) 98888-7777',
    tags: ['lp'],
    legal_bases: [{ category: 'communications', type: 'consent', status: 'granted' }],
    cf_cargo: 'Dona',
    company: { name: 'Padaria Exemplo' },
    funnel: { name: 'Default', lifecycle_stage: 'Lead', opportunity: false },
  },
  ...overrides,
});

describe('rdConversionsOf — the CONTACT event of the RD screen webhook', () => {
  it('reads the contact, and takes the form identifier from event_identifier', () => {
    const [conversion, ...rest] = rdConversionsOf(contactEvent());
    expect(rest).toHaveLength(0);
    expect(conversion).toMatchObject({
      externalId: 'rd-uuid-contact-1',
      name: 'Eva Lima',
      email: 'Eva@Example.com',
      phone: '(11) 98888-7777',
      identifier: 'lp-formatacao-contato',
      url: null,
      legalBasis: 'consent',
    });
    expect(conversion?.at?.toISOString()).toBe('2026-10-07T12:26:40.000Z');
  });

  it('reads the event name in either case (the RD API lists it in lower case)', () => {
    expect(rdConversionsOf(contactEvent({ event_type: 'webhook.converted' }))).toHaveLength(1);
    expect(rdConversionsOf(contactEvent({ event_type: 'webhook.marked_opportunity' }))).toEqual([]);
  });

  it('reads a contact event with no event_type as a conversion', () => {
    const body = contactEvent();
    delete (body as Record<string, unknown>).event_type;
    expect(rdConversionsOf(body)).toHaveLength(1);
  });

  it('ignores a contact event that is not a conversion', () => {
    expect(rdConversionsOf(contactEvent({ event_type: 'WEBHOOK.MARKED_OPPORTUNITY' }))).toEqual([]);
  });

  it('ignores a contact that is not an object', () => {
    expect(rdConversionsOf(contactEvent({ contact: 'Eva' }))).toEqual([]);
    expect(rdConversionsOf(contactEvent({ contact: ['Eva'] }))).toEqual([]);
    expect(rdConversionsOf(contactEvent({ contact: null }))).toEqual([]);
  });

  it('keeps the legitimate-interest basis the contact carries', () => {
    const [conversion] = rdConversionsOf(
      contactEvent({
        contact: {
          uuid: 'rd-uuid-contact-2',
          email: 'bia@example.com',
          legal_bases: [{ category: 'communications', type: 'legitimate_interest' }],
        },
      }),
    );
    expect(conversion?.legalBasis).toBe('legitimate_interest');
  });

  it('keeps reading the classic shapes: the conversion inside the lead wins over event_identifier', () => {
    const [classic] = rdConversionsOf({
      event_identifier: 'outro-nome',
      leads: [
        {
          uuid: 'rd-uuid-3',
          email: 'caio@example.com',
          last_conversion: {
            content: { conversion_identifier: 'lp-classico', url: 'https://lp.exemplo.com.br/x' },
          },
        },
      ],
    });
    expect(classic).toMatchObject({
      identifier: 'lp-classico',
      url: 'https://lp.exemplo.com.br/x',
    });

    const [flat] = rdConversionsOf({ uuid: 'rd-uuid-4', email: 'duda@example.com' });
    expect(flat).toMatchObject({ externalId: 'rd-uuid-4', identifier: null });
  });

  it('reads nothing from an empty or foreign body', () => {
    expect(rdConversionsOf(null)).toEqual([]);
    expect(rdConversionsOf({})).toEqual([]);
    expect(rdConversionsOf('texto')).toEqual([]);
    expect(rdConversionsOf({ event_type: 'WEBHOOK.CONVERTED', entity_type: 'CONTACT' })).toEqual(
      [],
    );
  });
});
