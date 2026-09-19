import { describe, expect, it } from 'vitest';
import {
  checkPostSeo,
  countWords,
  internalLinks,
  type SeoChecklistInput,
} from './seo-checklist.js';

const long = Array.from({ length: 610 }, (_, i) => `palavra${i}`).join(' ');

const complete: SeoChecklistInput = {
  title: 'Formatação de franquia: por onde começar',
  excerpt: 'O que avaliar antes de transformar o negócio em franquia.',
  content: [
    'A formatação de franquia começa pelo diagnóstico do negócio.',
    '## Etapas da formatacao de franquia',
    long,
    'Veja a [metodologia](https://wingscompany.com.br/metodologia-wings/).',
  ].join('\n\n'),
  focusKeyword: 'formatação de franquia',
  seoTitle: 'Formatação de franquia: por onde começar | Wings',
  metaDescription:
    'Entenda as etapas da formatação de franquia, do diagnóstico ao manual de operação, e saiba quando o seu negócio está pronto para expandir.',
  hasFeaturedImage: true,
  featuredImageAlt: 'Consultor da Wings apresentando o plano de expansão',
  siteHost: 'wingscompany.com.br',
};

const failing = (input: SeoChecklistInput) =>
  checkPostSeo(input)
    .filter((check) => !check.ok)
    .map((check) => check.id);

describe('the SEO checklist', () => {
  it('is all green for a complete post, and is the same every time', () => {
    expect(failing(complete)).toEqual([]);
    expect(checkPostSeo(complete)).toEqual(checkPostSeo(complete));
    expect(checkPostSeo(complete)).toHaveLength(10);
  });

  it('is all red for an empty form, without throwing', () => {
    const empty: SeoChecklistInput = {
      title: '',
      excerpt: '',
      content: '',
      focusKeyword: '',
      seoTitle: '',
      metaDescription: '',
      hasFeaturedImage: false,
      featuredImageAlt: '',
      siteHost: '',
    };
    expect(failing(empty)).toHaveLength(10);
  });

  it('matches the keyword whatever the accents and the case', () => {
    expect(failing({ ...complete, focusKeyword: 'FORMATACAO  de Franquia' })).toEqual([]);
  });

  it('looks for the keyword in the title, the FIRST paragraph and a subtitle, separately', () => {
    expect(failing({ ...complete, title: 'Por onde começar' })).toEqual(['keyword_in_title']);
    expect(
      failing({
        ...complete,
        content: `Um parágrafo de abertura qualquer.\n\n${complete.content}`,
      }),
    ).toEqual(['keyword_in_first_paragraph']);
    expect(
      failing({
        ...complete,
        content: complete.content.replace('## Etapas da formatacao de franquia', '## Etapas'),
      }),
    ).toEqual(['keyword_in_subtitle']);
    // Bold around the keyword does not hide it.
    expect(
      failing({
        ...complete,
        content: complete.content.replace(
          'A formatação de franquia',
          'A **formatação de franquia**',
        ),
      }),
    ).toEqual([]);
  });

  it('holds the SEO title to 60 and the description to 120-160', () => {
    expect(failing({ ...complete, seoTitle: 'x'.repeat(61) })).toEqual(['seo_title_length']);
    expect(failing({ ...complete, seoTitle: 'x'.repeat(60) })).toEqual([]);
    expect(failing({ ...complete, metaDescription: 'y'.repeat(119) })).toEqual([
      'meta_description_length',
    ]);
    expect(failing({ ...complete, metaDescription: 'y'.repeat(161) })).toEqual([
      'meta_description_length',
    ]);
    expect(failing({ ...complete, metaDescription: 'y'.repeat(120) })).toEqual([]);
    const detail = checkPostSeo({ ...complete, metaDescription: 'y'.repeat(100) }).find(
      (check) => check.id === 'meta_description_length',
    )?.detail;
    expect(detail).toBe('Tem 100 caracteres. Faltam 20 para o mínimo.');
  });

  it('flags a description that opens by repeating the title', () => {
    const echoed = `${complete.seoTitle}. ${'z'.repeat(80)}`;
    expect(failing({ ...complete, metaDescription: echoed })).toEqual([
      'meta_description_not_title',
    ]);
  });

  it('wants the excerpt, and a featured image WITH a usable alt text', () => {
    expect(failing({ ...complete, excerpt: '  ' })).toEqual(['excerpt_filled']);
    expect(failing({ ...complete, hasFeaturedImage: false })).toEqual(['featured_image_alt']);
    expect(failing({ ...complete, featuredImageAlt: 'foto' })).toEqual(['featured_image_alt']);
    expect(failing({ ...complete, featuredImageAlt: 'a'.repeat(126) })).toEqual([
      'featured_image_alt',
    ]);
  });

  it('counts words of the text only: no markers, no Markdown signs, no link targets', () => {
    expect(
      countWords('## Um título\n\nDuas **palavras** aqui.\n\n{{img:1}}\n\n- item um\n- item dois'),
    ).toBe(9);
    expect(countWords('[texto do link](https://wingscompany.com.br/a-b-c)')).toBe(3);
    expect(failing({ ...complete, content: complete.content.replace(long, 'curto') })).toEqual([
      'word_count',
    ]);
  });

  it('counts only links to the site itself as internal', () => {
    const content =
      'a https://wingscompany.com.br/x b [c](https://www.wingscompany.com.br/y) d https://outro.com.br/?u=wingscompany.com.br e https://wingscompany.com.br.evil.test/z';
    expect(internalLinks(content, 'wingscompany.com.br')).toEqual([
      'https://wingscompany.com.br/x',
      'https://www.wingscompany.com.br/y',
    ]);
    expect(
      failing({
        ...complete,
        content: complete.content.replace(
          'wingscompany.com.br/metodologia',
          'outro.com.br/metodologia',
        ),
      }),
    ).toEqual(['internal_link']);
  });
});
