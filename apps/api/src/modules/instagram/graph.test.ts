import { describe, expect, it } from 'vitest';
import { mediaPermalink, sendPrivateReply } from './graph.js';

/** The private reply's call against a fake Graph (no network). The token is made up. */

const config = { token: 'token-falso-do-teste', accountId: '17841400000000001' };
const answer =
  (status: number, body: unknown, seen: { url: string; init: RequestInit }[] = []) =>
  async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  };

describe('sendPrivateReply', () => {
  it('posts recipient.comment_id once, with the token in the header and never in the URL', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const outcome = await sendPrivateReply(
      answer(200, { recipient_id: '5001', message_id: 'm.1' }, seen) as typeof fetch,
      config,
      '900001',
      'texto',
    );
    expect(outcome).toEqual({ kind: 'sent', messageId: 'm.1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://graph.facebook.com/v23.0/17841400000000001/messages');
    expect(seen[0]!.url).not.toContain(config.token);
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${config.token}`,
    );
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      recipient: { comment_id: '900001' },
      message: { text: 'texto' },
    });
  });

  it.each([
    [429, { error: { code: 4 } }],
    [400, { error: { code: 4 } }],
    [400, { error: { code: 17 } }],
    [400, { error: { code: 32 } }],
    [400, { error: { code: 613 } }],
    [400, { error: { code: 80002 } }],
    [400, { error: { code: 80006 } }],
  ])('HTTP %i %j is a limit: the message did not go', async (status, body) => {
    const outcome = await sendPrivateReply(answer(status, body) as typeof fetch, config, '1', 't');
    expect(outcome.kind).toBe('rate_limited');
  });

  it.each([
    [403, { error: { code: 10 } }],
    [403, { error: { code: 200 } }],
    [401, { error: { code: 190 } }],
    [400, { error: { code: 100 } }],
  ])('HTTP %i %j is refused, not tried again', async (status, body) => {
    const outcome = await sendPrivateReply(answer(status, body) as typeof fetch, config, '1', 't');
    expect(outcome.kind).toBe('failed');
  });

  it('a timeout, a 5xx or an answer without message_id may have arrived: unknown', async () => {
    const cut = (async () => {
      throw new DOMException('timeout', 'TimeoutError');
    }) as typeof fetch;
    expect((await sendPrivateReply(cut, config, '1', 't')).kind).toBe('unknown');
    expect((await sendPrivateReply(answer(502, {}) as typeof fetch, config, '1', 't')).kind).toBe(
      'unknown',
    );
    expect(
      (await sendPrivateReply(answer(200, { recipient_id: '1' }) as typeof fetch, config, '1', 't'))
        .kind,
    ).toBe('unknown');
  });
});

describe('mediaPermalink', () => {
  it('only an instagram.com link, only for a numeric id', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = answer(200, { permalink: 'https://www.instagram.com/p/AbC/' }, seen);
    expect(await mediaPermalink(fake as typeof fetch, 'tk', '7001')).toBe(
      'https://www.instagram.com/p/AbC/',
    );
    expect(await mediaPermalink(fake as typeof fetch, 'tk', '../me')).toBeNull();
    expect(seen).toHaveLength(1);
    const other = answer(200, { permalink: 'https://exemplo.com/x' });
    expect(await mediaPermalink(other as typeof fetch, 'tk', '7001')).toBeNull();
  });
});
