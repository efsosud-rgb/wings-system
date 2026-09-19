import { parseContent, type ContentBlock } from './site-content.js';

/**
 * The SEO checklist beside the post form.
 *
 * Deterministic string checks over what is in the form: no model, no network,
 * same answer every time. The thresholds come from the claude-seo skill's
 * quality gates (title up to 60 characters, meta description 120 to 160 and
 * not a restatement of the title, alt text of 10 to 125 characters, internal
 * links), with the word count set by Wings at 600. The skill's own target for
 * an in-depth post, 1,500, is shown as a hint and is not the bar.
 *
 * It guides and never blocks: nothing here is consulted when the draft is sent.
 */

export const SEO_TITLE_MAX = 60;
export const SEO_TITLE_MIN = 30;
export const META_DESCRIPTION_MIN = 120;
export const META_DESCRIPTION_MAX = 160;
export const ALT_TEXT_MIN = 10;
export const ALT_TEXT_MAX = 125;
export const POST_MIN_WORDS = 600;
export const POST_IN_DEPTH_WORDS = 1500;
export const FOCUS_KEYWORD_MAX = 80;

export interface SeoChecklistInput {
  title: string;
  excerpt: string;
  content: string;
  focusKeyword: string;
  seoTitle: string;
  metaDescription: string;
  hasFeaturedImage: boolean;
  featuredImageAlt: string;
  /** The site's own host, e.g. wingscompany.com.br: what counts as internal. */
  siteHost: string;
}

export type SeoCheckId =
  | 'keyword_in_title'
  | 'keyword_in_first_paragraph'
  | 'keyword_in_subtitle'
  | 'seo_title_length'
  | 'meta_description_length'
  | 'meta_description_not_title'
  | 'excerpt_filled'
  | 'featured_image_alt'
  | 'word_count'
  | 'internal_link';

export interface SeoCheck {
  id: SeoCheckId;
  label: string;
  ok: boolean;
  /** What is there now, and what to do about it when it is not ok. */
  detail: string;
}

/** Lower case, no accents, single spaces. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function plainText(html: string): string {
  return html
    .replace(/<br \/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textOf(block: ContentBlock): string {
  if (block.kind === 'heading' || block.kind === 'paragraph') return plainText(block.html);
  if (block.kind === 'list') return block.items.map(plainText).join(' ');
  return '';
}

/** Words of the text itself: markers, Markdown signs and link targets do not count. */
export function countWords(content: string): number {
  const text = parseContent(content).map(textOf).join(' ');
  return (text.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []).length;
}

/** Links in the text that point at the site itself, with or without www. */
export function internalLinks(content: string, siteHost: string): string[] {
  const host = siteHost
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
  if (!host) return [];
  const urls = content.match(/https?:\/\/[^\s)\]"'<>]+/gi) ?? [];
  return urls.filter((url) => {
    const found = /^https?:\/\/([^/?#:]+)/i
      .exec(url)?.[1]
      ?.toLowerCase()
      .replace(/^www\./, '');
    return found === host;
  });
}

export function checkPostSeo(input: SeoChecklistInput): SeoCheck[] {
  const keyword = fold(input.focusKeyword);
  const blocks = parseContent(input.content);
  const firstParagraph = blocks.find((block) => block.kind === 'paragraph');
  const subtitles = blocks.filter((block) => block.kind === 'heading');
  const has = (text: string) => keyword !== '' && fold(text).includes(keyword);
  const needsKeyword = 'Escreva a palavra-chave foco para este item ser conferido.';

  const seoTitle = input.seoTitle.trim();
  const description = input.metaDescription.trim();
  const alt = input.featuredImageAlt.trim();
  const words = countWords(input.content);
  const links = internalLinks(input.content, input.siteHost);

  const titleToCompare = fold(seoTitle || input.title);
  const descriptionEchoesTitle =
    titleToCompare !== '' && fold(description).startsWith(titleToCompare);

  return [
    {
      id: 'keyword_in_title',
      label: 'Palavra-chave no título',
      ok: has(input.title),
      detail: !keyword
        ? needsKeyword
        : has(input.title)
          ? 'O título do post traz a palavra-chave.'
          : `Inclua "${input.focusKeyword.trim()}" no título do post, de preferência no começo.`,
    },
    {
      id: 'keyword_in_first_paragraph',
      label: 'Palavra-chave no primeiro parágrafo',
      ok: firstParagraph !== undefined && has(textOf(firstParagraph)),
      detail: !keyword
        ? needsKeyword
        : !firstParagraph
          ? 'O texto ainda não tem um parágrafo.'
          : has(textOf(firstParagraph))
            ? 'O primeiro parágrafo traz a palavra-chave.'
            : 'Use a palavra-chave logo no primeiro parágrafo.',
    },
    {
      id: 'keyword_in_subtitle',
      label: 'Palavra-chave em um subtítulo',
      ok: subtitles.some((block) => has(textOf(block))),
      detail: !keyword
        ? needsKeyword
        : subtitles.length === 0
          ? 'O texto não tem subtítulos. Comece uma linha com ## para criar um.'
          : subtitles.some((block) => has(textOf(block)))
            ? 'Pelo menos um subtítulo traz a palavra-chave.'
            : `Nenhum dos ${subtitles.length} subtítulos traz a palavra-chave.`,
    },
    {
      id: 'seo_title_length',
      label: `Título SEO com até ${SEO_TITLE_MAX} caracteres`,
      ok: seoTitle.length > 0 && seoTitle.length <= SEO_TITLE_MAX,
      detail:
        seoTitle.length === 0
          ? 'Escreva o título SEO. É o que aparece como link azul no Google.'
          : seoTitle.length > SEO_TITLE_MAX
            ? `Tem ${seoTitle.length} caracteres. O Google corta perto de ${SEO_TITLE_MAX}.`
            : seoTitle.length < SEO_TITLE_MIN
              ? `Tem ${seoTitle.length} caracteres. Cabe, mas entre ${SEO_TITLE_MIN} e ${SEO_TITLE_MAX} descreve melhor a página.`
              : `Tem ${seoTitle.length} caracteres.`,
    },
    {
      id: 'meta_description_length',
      label: `Meta descrição entre ${META_DESCRIPTION_MIN} e ${META_DESCRIPTION_MAX} caracteres`,
      ok: description.length >= META_DESCRIPTION_MIN && description.length <= META_DESCRIPTION_MAX,
      detail:
        description.length === 0
          ? 'Escreva a meta descrição. É o texto cinza embaixo do link no Google.'
          : description.length < META_DESCRIPTION_MIN
            ? `Tem ${description.length} caracteres. Faltam ${META_DESCRIPTION_MIN - description.length} para o mínimo.`
            : description.length > META_DESCRIPTION_MAX
              ? `Tem ${description.length} caracteres. Passou ${description.length - META_DESCRIPTION_MAX} do limite e o Google vai cortar.`
              : `Tem ${description.length} caracteres.`,
    },
    {
      id: 'meta_description_not_title',
      label: 'Meta descrição diferente do título',
      ok: description.length > 0 && !descriptionEchoesTitle,
      detail:
        description.length === 0
          ? 'Sem meta descrição para comparar.'
          : descriptionEchoesTitle
            ? 'A descrição começa repetindo o título. Use o espaço para dizer o que a pessoa encontra no post.'
            : 'A descrição acrescenta informação ao título.',
    },
    {
      id: 'excerpt_filled',
      label: 'Resumo preenchido',
      ok: input.excerpt.trim().length > 0,
      detail:
        input.excerpt.trim().length > 0
          ? 'O resumo aparece nas listagens do blog.'
          : 'Sem resumo, o blog mostra as primeiras linhas do texto nas listagens.',
    },
    {
      id: 'featured_image_alt',
      label: 'Imagem destacada com texto alternativo',
      ok: input.hasFeaturedImage && alt.length >= ALT_TEXT_MIN && alt.length <= ALT_TEXT_MAX,
      detail: !input.hasFeaturedImage
        ? 'O post está sem imagem destacada.'
        : alt.length === 0
          ? 'Descreva a imagem em uma frase. Leitores de tela e o Google leem esse texto.'
          : alt.length < ALT_TEXT_MIN
            ? `O texto alternativo tem ${alt.length} caracteres. Descreva a imagem com pelo menos ${ALT_TEXT_MIN}.`
            : alt.length > ALT_TEXT_MAX
              ? `O texto alternativo tem ${alt.length} caracteres. Resuma em até ${ALT_TEXT_MAX}.`
              : 'A imagem destacada tem descrição.',
    },
    {
      id: 'word_count',
      label: `Texto com mais de ${POST_MIN_WORDS} palavras`,
      ok: words > POST_MIN_WORDS,
      detail:
        words > POST_MIN_WORDS
          ? `Tem ${words} palavras. Para um artigo aprofundado, a referência é ${POST_IN_DEPTH_WORDS}.`
          : `Tem ${words} palavras. Faltam ${POST_MIN_WORDS + 1 - words}.`,
    },
    {
      id: 'internal_link',
      label: `Link para outra página de ${input.siteHost || 'nosso site'}`,
      ok: links.length > 0,
      detail:
        links.length > 0
          ? `${links.length} link${links.length === 1 ? '' : 's'} para o próprio site.`
          : 'Aponte para pelo menos uma página do site, no formato [texto](https://…).',
    },
  ];
}
