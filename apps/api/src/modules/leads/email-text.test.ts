import { describe, expect, it } from 'vitest';
import { parseFrom, textOfHtml, withoutQuotes } from './email-text.js';

/** The lead's own words, without the older messages each mail client quotes in its own way. */
describe('withoutQuotes', () => {
  it('cuts at Gmail’s attribution, in one line or wrapped in two', () => {
    expect(
      withoutQuotes('Pode ser.\n\nOn Thu, Oct 30, 2026 at 10:00 AM Ana <a@b.com> wrote:\n> antes'),
    ).toBe('Pode ser.');
    expect(
      withoutQuotes(
        'Pode ser.\n\nEm qui., 30 de out. de 2026 às 10:00, Ana <\na@b.com> escreveu:\n> antes',
      ),
    ).toBe('Pode ser.');
  });

  it('cuts at Outlook’s header block and at "Original Message"', () => {
    expect(withoutQuotes('Ok.\r\n\r\nDe: Ana\r\nEnviado: quinta\r\nPara: Bia\r\n\r\nantes')).toBe(
      'Ok.',
    );
    expect(withoutQuotes('Ok.\n-----Original Message-----\nantes')).toBe('Ok.');
  });

  it('keeps everything when there is no quote, or when the quote is all there is', () => {
    expect(withoutQuotes('Só isto.\nDe nada: obrigado.')).toBe('Só isto.\nDe nada: obrigado.');
    expect(withoutQuotes('> só a citação')).toBe('> só a citação');
  });
});

describe('textOfHtml and parseFrom', () => {
  it('turns HTML into lines and drops Gmail’s quote block', () => {
    expect(textOfHtml('<p>Oi &amp; até</p><div class="gmail_quote">velho</div>').trim()).toBe(
      'Oi & até',
    );
  });

  it('reads the name and the address of the From header', () => {
    expect(parseFrom('"Ana Lima" <Ana@Exemplo.com.br>')).toEqual({
      name: 'Ana Lima',
      email: 'ana@exemplo.com.br',
    });
    expect(parseFrom('ana@exemplo.com.br')).toEqual({ name: null, email: 'ana@exemplo.com.br' });
    expect(parseFrom('sem endereço')).toBeNull();
  });
});
