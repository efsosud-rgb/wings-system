import { describe, expect, it } from 'vitest';
import {
  approximateAgoText,
  commentOccurredAt,
  instagramExcerpt,
  maskCommentText,
  normalizeInstagramPostUrl,
  parseInstagramPaste,
  type InstagramPasteReading,
} from './instagram-paste.js';

/** The three made-up examples of docs/prospeccao/instagram.md §4.1 (no @ is a real person's). */
const EXAMPLE_1 = `marca.concorrente.exemplo
Verificado
Quer ter a sua própria rede? Comente QUERO 👇
2 sem
usuario.teste01
quanto custa pra abrir uma unidade?
2 sem
3 curtidas
Responder
Ver respostas (1)
marca.concorrente.exemplo
Autor
@usuario.teste01 te chamamos no direct!
2 sem
Responder
loja_ficticia_02
👏👏👏
1 sem
Responder
Ver tradução
Carregar mais comentários`;

const EXAMPLE_2 = `usuario.teste03 Tenho 2 lojas e quero franquear, como funciona? 5 d Responder
usuario_teste04 top demais 4 d 1 curtida Responder
Ver todas as 12 respostas
usuario.teste05 vcs atendem fora de SP? 3 d Responder`;

const EXAMPLE_3 = `@usuario.teste06: qual o investimento pra formatar minha marca?
@usuario.teste07 - sigo vocês faz tempo, parabéns
@usuario.teste08 quero saber mais, me chama`;

const read = (text: string, options: { postOwner?: string; wingsUsername?: string } = {}) => {
  const parsed = parseInstagramPaste(text, { maxChars: 50_000, ...options });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.reading;
};
const users = (reading: InstagramPasteReading) => reading.comments.map((c) => c.username);

describe('parseInstagramPaste: the three formats of §4.1', () => {
  it('example 1 (computer browser): 2 comments, 9 interface lines, 0 unrecognized', () => {
    const reading = read(EXAMPLE_1);
    expect(reading.comments).toEqual([
      {
        username: 'usuario.teste01',
        text: 'quanto custa pra abrir uma unidade?',
        when: '2 sem',
        format: 'web_computador',
      },
      { username: 'loja_ficticia_02', text: '👏👏👏', when: '1 sem', format: 'web_computador' },
    ]);
    expect(reading.linesIgnored).toBe(9);
    expect(reading.linesUnrecognized).toBe(0);
    // The caption and the owner's reply are the post owner's, found without being typed.
    expect(reading.discarded.dono_do_post).toBe(2);
    expect(reading.postOwner).toBe('marca.concorrente.exemplo');
    expect(reading.format).toBe('web_computador');
    expect(reading.ignored).toMatchObject({ responder: 3, rotulo: 2, curtidas: 1, tempo: 0 });
  });

  it('example 2 (phone browser): 3 comments, 1 ignored line', () => {
    const reading = read(EXAMPLE_2);
    expect(reading.comments.map((c) => [c.username, c.text, c.when])).toEqual([
      ['usuario.teste03', 'Tenho 2 lojas e quero franquear, como funciona?', '5 d'],
      ['usuario_teste04', 'top demais', '4 d'],
      ['usuario.teste05', 'vcs atendem fora de SP?', '3 d'],
    ]);
    expect(reading.linesIgnored).toBe(1);
    expect(reading.linesUnrecognized).toBe(0);
    expect(reading.format).toBe('web_celular');
  });

  it('example 3 (typed from the app): 3 comments, 0 ignored', () => {
    const reading = read(EXAMPLE_3);
    expect(reading.comments.map((c) => [c.username, c.text])).toEqual([
      ['usuario.teste06', 'qual o investimento pra formatar minha marca?'],
      ['usuario.teste07', 'sigo vocês faz tempo, parabéns'],
      ['usuario.teste08', 'quero saber mais, me chama'],
    ]);
    expect(reading.linesIgnored).toBe(0);
    expect(reading.linesUnrecognized).toBe(0);
    expect(reading.format).toBe('manual');
  });

  it('the first block without "Responder" is the caption, even with no "Autor" reply', () => {
    const reading = read(
      'marca.outra.exemplo\nVenha ser franqueado!\n3 d\nusuario.teste12\nquero\n2 d\nResponder',
    );
    expect(users(reading)).toEqual(['usuario.teste12']);
    expect(reading.discarded.dono_do_post).toBe(1);
    expect(reading.postOwner).toBe('marca.outra.exemplo');
  });

  it('two formats in one paste are "misto"', () => {
    expect(read(`${EXAMPLE_2}\n${EXAMPLE_3}`).format).toBe('misto');
  });
});

describe('parseInstagramPaste: edges', () => {
  it('a one-word text after the @ stays the text, never a new @', () => {
    const reading = read('usuario.teste09\nvalor\n2 d\nResponder');
    expect(reading.comments).toEqual([
      { username: 'usuario.teste09', text: 'valor', when: '2 d', format: 'web_computador' },
    ]);
  });

  it('an invalid @ is not a comment: the line is unrecognized and shown', () => {
    const reading = read(
      '@nome.invalido.: oi\n@' + 'a'.repeat(31) + ': quero\nfrase solta qualquer',
    );
    expect(reading.comments).toEqual([]);
    expect(reading.linesUnrecognized).toBe(3);
    expect(reading.unrecognized).toHaveLength(3);
  });

  it('only the first 20 unrecognized lines are shown, all are counted', () => {
    const reading = read(Array.from({ length: 25 }, (_, i) => `frase solta ${i}`).join('\n'));
    expect(reading.unrecognized).toHaveLength(20);
    expect(reading.linesUnrecognized).toBe(25);
  });

  it("the typed post owner's comments are discarded, in any format", () => {
    const reading = read(`${EXAMPLE_3}\n@Marca.Exemplo: chama no direct`, {
      postOwner: '@marca.exemplo',
    });
    expect(users(reading)).not.toContain('marca.exemplo');
    expect(reading.discarded.dono_do_post).toBe(1);
    expect(reading.postOwner).toBe('marca.exemplo');
  });

  it("Wings' own comments are discarded", () => {
    const reading = read(`${EXAMPLE_3}\n@wings.teste: obrigado!`, { wingsUsername: 'wings.teste' });
    expect(users(reading)).toHaveLength(3);
    expect(reading.discarded.wings).toBe(1);
  });

  it('the same @ and text twice count once', () => {
    const reading = read(`${EXAMPLE_3}\n@usuario.teste08 Quero saber mais,  me chama`);
    expect(reading.comments).toHaveLength(3);
    expect(reading.discarded.repetido).toBe(1);
  });

  it('a block without text is discarded as empty', () => {
    const reading = read('usuario.teste10\n2 d\nResponder\n' + EXAMPLE_3);
    expect(reading.discarded.vazio).toBe(1);
    expect(reading.comments).toHaveLength(3);
  });

  it('301 comments are all read (the API refuses past the limit)', () => {
    const text = Array.from({ length: 301 }, (_, i) => `@usuario.n${i}: quero`).join('\n');
    expect(read(text).comments).toHaveLength(301);
  });

  it('refuses a text over the size limit before reading anything', () => {
    expect(parseInstagramPaste('a'.repeat(50_001), { maxChars: 50_000 })).toEqual({
      ok: false,
      error: 'colagem_grande',
    });
    expect(parseInstagramPaste('a'.repeat(50_000), { maxChars: 50_000 }).ok).toBe(true);
  });

  it('English interface lines are ignored too', () => {
    const reading = read('usuario.teste11\nhow much?\n3w\n2 likes\nReply\nSee translation');
    expect(reading.comments).toHaveLength(1);
    expect(reading.comments[0]!.when).toBe('3w');
    expect(reading.linesIgnored).toBe(3);
  });
});

describe('commentOccurredAt (§4.3)', () => {
  const pasted = new Date('2026-10-31T15:00:00Z');
  const daysBefore = (date: Date) => (pasted.getTime() - date.getTime()) / 86_400_000;

  it('turns the relative markers into paste time minus the interval', () => {
    expect(daysBefore(commentOccurredAt('2 sem', pasted))).toBe(14);
    expect(daysBefore(commentOccurredAt('5 d', pasted))).toBe(5);
    expect(daysBefore(commentOccurredAt('há 2 dias', pasted))).toBe(2);
    expect(daysBefore(commentOccurredAt('3w', pasted))).toBe(21);
    expect(pasted.getTime() - commentOccurredAt('3 h', pasted).getTime()).toBe(3 * 3_600_000);
    expect(pasted.getTime() - commentOccurredAt('há 4 semanas', pasted).getTime()).toBe(
      28 * 86_400_000,
    );
  });

  it('reads written dates, last year when the day is still ahead', () => {
    expect(commentOccurredAt('12 de outubro', pasted).toISOString()).toBe(
      '2026-10-12T15:00:00.000Z',
    );
    expect(commentOccurredAt('12/10/2026', pasted).toISOString()).toBe('2026-10-12T15:00:00.000Z');
    expect(commentOccurredAt('25 de dezembro', pasted).toISOString()).toBe(
      '2025-12-25T15:00:00.000Z',
    );
  });

  it('falls back to the paste time with no marker or an impossible one', () => {
    expect(commentOccurredAt(null, pasted)).toEqual(pasted);
    expect(commentOccurredAt('31/02', pasted)).toEqual(pasted);
    expect(commentOccurredAt('01/01/2030', pasted)).toEqual(pasted);
  });

  it('the screen says "há cerca de"', () => {
    expect(approximateAgoText(commentOccurredAt('2 sem', pasted), pasted)).toBe(
      'há cerca de 2 semanas',
    );
    expect(approximateAgoText(commentOccurredAt('3 d', pasted), pasted)).toBe('há cerca de 3 dias');
  });
});

describe('maskCommentText (§4.4)', () => {
  it('masks phone, e-mail, link and @ (made-up data)', () => {
    const masked = maskCommentText(
      'meu zap é (11) 98888-0000, email teste@exemplo.com, site www.loja-teste.com.br e @amiga.teste',
    );
    expect(masked).toBe('meu zap é [número], email [e-mail], site [link] e [@]');
    expect(masked).not.toMatch(/\d{4}/);
  });

  it('keeps short numbers that are not phones', () => {
    expect(maskCommentText('tenho 3 lojas e 300 mil pra investir')).toBe(
      'tenho 3 lojas e 300 mil pra investir',
    );
  });

  it('the excerpt is cut at 280 characters', () => {
    expect(instagramExcerpt('a'.repeat(400))).toHaveLength(280);
  });
});

describe('normalizeInstagramPostUrl', () => {
  it('keeps one form, without the query string', () => {
    expect(normalizeInstagramPostUrl('https://www.instagram.com/p/AbC123xyz/?igsh=xx')).toBe(
      'https://www.instagram.com/p/AbC123xyz/',
    );
    expect(normalizeInstagramPostUrl('instagram.com/reel/AbC123xyz')).toBe(
      'https://www.instagram.com/reel/AbC123xyz/',
    );
    expect(normalizeInstagramPostUrl('https://www.instagram.com/marca.exemplo/p/AbC123xyz/')).toBe(
      'https://www.instagram.com/p/AbC123xyz/',
    );
  });

  it('refuses what is not a post', () => {
    expect(normalizeInstagramPostUrl('https://www.instagram.com/marca.exemplo/')).toBeNull();
    expect(normalizeInstagramPostUrl('https://exemplo.com/p/AbC123xyz/')).toBeNull();
    expect(normalizeInstagramPostUrl('javascript:alert(1)')).toBeNull();
  });
});
