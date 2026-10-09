import { describe, expect, it } from 'vitest';
import { withArticle } from './whatsapp-art.js';

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
});
