import { describe, expect, it } from 'vitest';
import {
  contactsInText,
  instagramWebhookEventsOf,
  parseInstagramComment,
  parseInstagramMessage,
} from './payload.js';

/**
 * The webhook read tolerantly (docs/prospeccao/instagram.md §5.1). The payloads follow Meta's
 * published examples, NOT verified live; every id, @ and text is made up.
 */

const comment = (value: Record<string, unknown>) => ({
  object: 'instagram',
  entry: [{ id: '17841400000000001', time: 1793530800, changes: [{ field: 'comments', value }] }],
});

describe('instagramWebhookEventsOf', () => {
  it('reads a comment by comment_id (unified login) or id (Instagram login)', () => {
    const [a] = instagramWebhookEventsOf(
      comment({ comment_id: '900001', text: 'oi', from: { id: '5001' } }),
    );
    const [b] = instagramWebhookEventsOf(
      comment({ id: '900002', text: 'oi', from: { id: '5001' } }),
    );
    expect(a).toMatchObject({ eventKey: 'comment:900001', kind: 'comment' });
    expect(a!.occurredAt?.toISOString()).toBe('2026-11-01T11:00:00.000Z');
    expect(b?.eventKey).toBe('comment:900002');
  });

  it('splits several entries and messaging items; leaves other fields and objects out', () => {
    const events = instagramWebhookEventsOf({
      object: 'instagram',
      entry: [
        {
          id: '17841400000000001',
          time: 1793530800,
          changes: [
            { field: 'comments', value: { id: '1', from: { id: '9' } } },
            { field: 'live_comments', value: { id: '2', from: { id: '9' } } },
            { field: 'mentions', value: { comment_id: '3' } },
          ],
        },
        {
          id: '17841400000000001',
          messaging: [
            {
              sender: { id: '9' },
              recipient: { id: '17841400000000001' },
              timestamp: 1793530900000,
              message: { mid: 'mid.a', text: 'oi' },
            },
            {
              sender: { id: '17841400000000001' },
              recipient: { id: '9' },
              message: { mid: 'mid.b', text: 'olá', is_echo: true },
            },
            { sender: { id: '9' }, recipient: { id: '1' }, read: { mid: 'mid.a' } },
          ],
        },
      ],
    });
    expect(events.map((e) => e.eventKey)).toEqual(['comment:1', 'message:mid.a', 'echo:mid.b']);
    expect(instagramWebhookEventsOf({ object: 'page', entry: [] })).toEqual([]);
    expect(instagramWebhookEventsOf('nada')).toEqual([]);
  });

  it('keeps a comment without id under a key of its own, for the loop to fail it', () => {
    const [event] = instagramWebhookEventsOf(comment({ text: 'sem id' }));
    expect(event?.eventKey).toMatch(/^comment:sem-id:/);
    expect(parseInstagramComment(event!.payload)).toBeNull();
  });
});

describe('parseInstagramComment', () => {
  it('reads the person, the media and the ad; an unknown field does not break it', () => {
    expect(
      parseInstagramComment({
        comment_id: '900003',
        text: 'quanto custa?',
        from: { id: '5002', username: '@Pessoa.Teste' },
        media: { id: '7001', media_product_type: 'AD', ad_id: '6001', ad_title: 'x' },
        campo_novo: 1,
      }),
    ).toEqual({
      commentId: '900003',
      text: 'quanto custa?',
      fromId: '5002',
      fromUsername: 'pessoa.teste',
      parentId: null,
      mediaId: '7001',
      mediaProductType: 'AD',
      adId: '6001',
    });
  });

  it('a dynamic ad (no ad_id) is a post comment; a boosted post points to the original media', () => {
    const parsed = parseInstagramComment({
      id: '900004',
      from: { id: '5003' },
      media: { id: '7002', original_media_id: '7000' },
    });
    expect(parsed).toMatchObject({ adId: null, mediaId: '7000', text: '' });
  });

  it('without the commenter id it is invalid', () => {
    expect(parseInstagramComment({ id: '900005', text: 'oi' })).toBeNull();
  });
});

describe('parseInstagramMessage', () => {
  it('reads text, echo and the millisecond timestamp; a sticker has no text', () => {
    expect(
      parseInstagramMessage({
        sender: { id: '9' },
        recipient: { id: '1' },
        timestamp: 1793530900000,
        message: { mid: 'mid.c', attachments: [{ type: 'image' }] },
      }),
    ).toMatchObject({ text: null, isEcho: false, at: new Date(1793530900000) });
    expect(parseInstagramMessage({ sender: { id: '9' }, message: { mid: 'x' } })).toBeNull();
  });
});

describe('contactsInText', () => {
  it('takes the phone and the e-mail the person wrote', () => {
    expect(contactsInText('pode ser (11) 98888-7777 ou contato.teste@exemplo.com.br')).toEqual({
      phone: '5511988887777',
      email: 'contato.teste@exemplo.com.br',
    });
    expect(contactsInText('me chama aqui mesmo')).toEqual({ phone: null, email: null });
    expect(contactsInText('tenho 12345678 seguidores')).toEqual({ phone: null, email: null });
  });
});
