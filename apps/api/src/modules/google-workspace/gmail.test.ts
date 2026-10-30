import { describe, expect, it } from 'vitest';
import { buildRawMessage, GMAIL_SEND_URL, GMAIL_UPLOAD_URL, sendGmail } from './gmail.js';

const base = {
  from: { email: 'vendedora@wingscompany.com.br', name: 'Vendedora Teste' },
  to: 'contato@exemplo.com.br',
  subject: 'Proposta',
  text: 'Segue a proposta.',
  html: '<p>Segue a proposta.</p>',
  messageId: '<abc@wingssystem.online>',
};
const pdf = Buffer.from('%PDF-1.4 proposta');

/** The RFC 5322 message, with and without attachments, and which Gmail endpoint takes it. */
describe('buildRawMessage', () => {
  it('without attachments stays a plain multipart/alternative', () => {
    const raw = buildRawMessage(base);
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).not.toContain('multipart/mixed');
  });

  it('with attachments wraps the text in multipart/mixed, each file base64 with its name', () => {
    const raw = buildRawMessage({
      ...base,
      attachments: [
        { filename: 'Proposta Ação.pdf', contentType: 'application/pdf', content: pdf },
      ],
    });
    expect(raw).toMatch(/^Content-Type: multipart\/mixed; boundary="wings-[0-9a-f]+"$/m);
    expect(raw).toContain('Content-Type: multipart/alternative');
    expect(raw).toContain('Content-Type: application/pdf');
    expect(raw).toContain(`filename*=UTF-8''${encodeURIComponent('Proposta Ação.pdf')}`);
    expect(raw).toContain(pdf.toString('base64'));
    // Every boundary opened is closed.
    const mixed = /boundary="(wings-[0-9a-f]+)"/.exec(raw)![1]!;
    expect(raw).toContain(`--${mixed}--`);
  });
});

describe('sendGmail', () => {
  const answer = () => new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200 });

  it('sends a message with attachments through the media upload, as message/rfc822', async () => {
    const calls: { url: string; type: string; body: string }[] = [];
    const transport = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, type: headers['content-type']!, body: String(init.body) });
      return answer();
    }) as typeof fetch;
    await sendGmail(transport, 'token', {
      ...base,
      attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', content: pdf }],
    });
    expect(calls[0]).toMatchObject({ url: GMAIL_UPLOAD_URL, type: 'message/rfc822' });
    expect(calls[0]!.body).toContain('From: Vendedora Teste <vendedora@wingscompany.com.br>');
    await sendGmail(transport, 'token', base);
    expect(calls[1]).toMatchObject({ url: GMAIL_SEND_URL, type: 'application/json' });
  });
});
