import { describe, expect, it } from 'vitest';
import { waArticleBefore, withArticle, withoutArticle } from './whatsapp-art.js';
import { sofiaVoice, sofiaWords } from './sofia.js';

describe('withArticle', () => {
  it('puts the stored article before a name', () => {
    expect(withArticle('Malkuth', 'a', 'article')).toBe('a Malkuth');
    expect(withArticle('Malkuth', 'a', 'of')).toBe('da Malkuth');
    expect(withArticle('Casal do Churros', 'o', 'article')).toBe('o Casal do Churros');
    expect(withArticle('Casal do Churros', 'o', 'of')).toBe('do Casal do Churros');
    expect(withArticle('  Malkuth  ', 'a', 'plain')).toBe('Malkuth');
    expect(withArticle('   ', 'a', 'of')).toBe('');
  });

  it('keeps the article a name already starts with, never doubling it', () => {
    expect(withArticle('A Cabana da Barra', 'a', 'of')).toBe('da Cabana da Barra');
    expect(withArticle('A Cabana da Barra', 'a', 'article')).toBe('a Cabana da Barra');
    expect(withArticle('A Cabana da Barra', 'a', 'plain')).toBe('A Cabana da Barra');
    // The name's own article wins over a stored one that disagrees.
    expect(withArticle('O Boticário', 'a', 'of')).toBe('do Boticário');
    expect(withArticle('a  cabana', 'o', 'of')).toBe('da cabana');
    expect(withArticle('Os Pastéis', 'o', 'of')).toBe('dos Pastéis');
    expect(withArticle('As Meninas', 'a', 'article')).toBe('as Meninas');
  });

  it('does not take a word that only starts with the letter for an article', () => {
    expect(withArticle('Ana Lanches', 'a', 'of')).toBe('da Ana Lanches');
    expect(withArticle('Oásis Burger', 'o', 'of')).toBe('do Oásis Burger');
    expect(withArticle('A.C. Bebidas', 'a', 'of')).toBe('da A.C. Bebidas');
    expect(withArticle('A', 'a', 'of')).toBe('da A');
  });

  it('does not take an initial, a symbol or "e"/"do" after the letter for an article', () => {
    expect(withArticle('A & B Lanches', 'a', 'of')).toBe('da A & B Lanches');
    expect(withArticle('A - Z Store', 'a', 'of')).toBe('da A - Z Store');
    expect(withArticle('A e B Contabilidade', 'a', 'article')).toBe('a A e B Contabilidade');
    expect(withArticle('As do Churrasco', 'o', 'of')).toBe('do As do Churrasco');
    expect(withArticle('A J Silva Comércio', 'a', 'of')).toBe('da A J Silva Comércio');
    expect(withArticle('O K Lanches', 'o', 'of')).toBe('do O K Lanches');
    // A number is a word: "As 3 Marias" starts with its article.
    expect(withArticle('As 3 Marias', 'a', 'of')).toBe('das 3 Marias');
    expect(withArticle('A Doceria Real', 'a', 'of')).toBe('da Doceria Real');
    // Initials in capitals before a common word are part of the name.
    expect(withArticle('AS Construtora', 'a', 'of')).toBe('da AS Construtora');
    expect(withArticle('OS Informática', 'a', 'article')).toBe('a OS Informática');
    // A name all in capitals still starts with its article.
    expect(withArticle('A CABANA DA BARRA', 'a', 'of')).toBe('da CABANA DA BARRA');
    expect(withArticle('OS 2 IRMÃOS', 'o', 'of')).toBe('dos 2 IRMÃOS');
  });

  it('reads an accented first letter however it was typed (composed or not)', () => {
    expect(withArticle('O \u0045\u0301den', 'a', 'of')).toBe('do Éden');
    expect(withArticle('A A\u0301rvore', 'o', 'article')).toBe('a Árvore');
  });
});

describe('a text that already carries the article ("expansão da {{3}}")', () => {
  it('takes the name without its own article when the text carries the same one', () => {
    expect(withoutArticle('A Cabana da Barra', 'a')).toBe('Cabana da Barra');
    expect(withoutArticle('  O   Boticário ', 'o')).toBe('Boticário');
    expect(withoutArticle('As 3 Marias', 'as')).toBe('3 Marias');
    expect(withoutArticle('Malkuth', 'a')).toBe('Malkuth');
    expect(withoutArticle('A & B Lanches', 'a')).toBe('A & B Lanches');
    expect(withoutArticle('AS Construtora', 'as')).toBe('AS Construtora');
    expect(withoutArticle('A', 'a')).toBe('A');
  });

  it('keeps the name whole when the text carries another article', () => {
    // "da Bar do Zé" would cut the name and still be wrong: "da O Bar do Zé" stays as it was.
    expect(withoutArticle('O Bar do Zé', 'a')).toBe('O Bar do Zé');
    expect(withoutArticle('As 3 Marias', 'a')).toBe('As 3 Marias');
    expect(withoutArticle('Os 2 Irmãos', 'o')).toBe('Os 2 Irmãos');
  });

  it('reads the article or "da"/"do" right before the field, and not a bare "de"', () => {
    const body = 'Aqui é {{2}}, do time de expansão da {{3}}. A franquia {{4}} e o {{5}} de {{6}}.';
    expect(waArticleBefore(body, 3)).toBe('a');
    expect(waArticleBefore(body, 2)).toBeNull();
    expect(waArticleBefore(body, 4)).toBeNull();
    expect(waArticleBefore(body, 5)).toBe('o');
    expect(waArticleBefore(body, 6)).toBeNull();
    expect(waArticleBefore('transformar a {{3}} em franquia', 3)).toBe('a');
    expect(waArticleBefore('(COF) DA {{ 2 }} foi enviada', 2)).toBe('a');
    expect(waArticleBefore('o time dos {{1}}', 1)).toBe('os');
    expect(waArticleBefore(body, 9)).toBeNull();
    expect(waArticleBefore(null, 3)).toBeNull();
  });
});

describe('who Sofia speaks for', () => {
  it('says the brand with its own article, "da" while nobody said', () => {
    expect(sofiaVoice('A Cabana da Barra', 'a').quem).toBe(
      'do time de expansão da Cabana da Barra',
    );
    expect(sofiaVoice('Casal do Churros', 'o').quem).toBe(
      'do time de expansão do Casal do Churros',
    );
    expect(sofiaVoice('Malkuth').quem).toBe('do time de expansão da Malkuth');
    expect(sofiaVoice(null).quem).toBe('da Wings Company');
    expect(
      sofiaWords(
        'Eu sou a Sofia, atendente virtual {quem}. Fale com {empresa}.',
        'A Cabana da Barra',
        'a',
      ),
    ).toBe(
      'Eu sou a Sofia, atendente virtual do time de expansão da Cabana da Barra. Fale com A Cabana da Barra.',
    );
  });
});
