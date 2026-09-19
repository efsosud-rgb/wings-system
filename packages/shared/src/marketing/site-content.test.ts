import { describe, expect, it } from 'vitest';
import {
  parseVideoLink,
  renderSitePost,
  type RenderImage,
  type RenderInput,
} from './site-content.js';
import { sitePostSchema } from './site-post.js';

const image = (n: number, caption = ''): RenderImage => ({
  src: `https://site.test/img-${n}.jpg`,
  caption,
  alt: caption || 'Post',
  mediaId: 100 + n,
});

const render = (input: Partial<RenderInput>, target: 'preview' | 'wordpress' = 'wordpress') =>
  renderSitePost({ content: '', images: [], gallery: [], video: null, ...input }, target);

describe('Markdown to HTML', () => {
  it('leaves plain text as paragraphs, as before', () => {
    expect(render({ content: 'Primeiro parágrafo.\n\nSegundo\ncom quebra.' }).html).toBe(
      '<p>Primeiro parágrafo.</p>\n\n<p>Segundo<br />com quebra.</p>',
    );
  });

  it('converts subtitles, bold, italic, lists and links', () => {
    const { html } = render({
      content: [
        '## Por que franquear',
        'Texto com **negrito**, *itálico* e [um link](https://wingscompany.com.br/contato?a=1&b=2).',
        '',
        '- primeiro',
        '- segundo com **força**',
        '',
        '1. um',
        '2. dois',
        '',
        '### Detalhe',
      ].join('\n'),
    });
    expect(html).toBe(
      [
        '<h2>Por que franquear</h2>',
        '<p>Texto com <strong>negrito</strong>, <em>itálico</em> e <a href="https://wingscompany.com.br/contato?a=1&amp;b=2">um link</a>.</p>',
        '<ul><li>primeiro</li><li>segundo com <strong>força</strong></li></ul>',
        '<ol><li>um</li><li>dois</li></ol>',
        '<h3>Detalhe</h3>',
      ].join('\n\n'),
    );
  });

  it('treats # as h2 too: the post title is the page h1', () => {
    expect(render({ content: '# Título digitado' }).html).toBe('<h2>Título digitado</h2>');
  });

  it('does not mistake snake_case or a lone asterisk for emphasis', () => {
    expect(render({ content: 'use utm_source e utm_medium; 2 * 3 = 6' }).html).toBe(
      '<p>use utm_source e utm_medium; 2 * 3 = 6</p>',
    );
  });

  it('escapes everything the operator typed: no markup gets through', () => {
    const { html } = render({
      content:
        '<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n## <b>x</b>\n\n- <i>y</i>\n\n[clique](javascript:alert(1)) [ok](https://a.test/"onmouseover="x)',
    });
    expect(html).not.toMatch(/<script|<img|<b>|<i>|<a /i);
    expect(html).toContain('&lt;script&gt;');
    // A refused link stays as the text that was typed, never as an anchor.
    expect(html).toContain('[clique](javascript:alert(1))');
    expect(html).toContain('[ok](https://a.test/&quot;onmouseover=&quot;x)');
  });

  it('escapes captions and alt text too', () => {
    const { html } = render({
      content: 'Texto.',
      images: [{ ...image(1, '"><script>x</script>'), alt: '" onload="x' }],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('alt="&quot; onload=&quot;x"');
  });
});

describe('media in the body', () => {
  it('puts an image where its marker is, as a WordPress image block with its caption', () => {
    const { html, problems } = render({
      content: 'Antes.\n\n{{img:1}}\n\nDepois.',
      images: [image(1, 'Equipe Wings')],
    });
    expect(problems).toEqual([]);
    expect(html).toBe(
      [
        '<p>Antes.</p>',
        '<!-- wp:image {"id":101,"sizeSlug":"large","linkDestination":"none"} -->\n' +
          '<figure class="wp-block-image size-large"><img src="https://site.test/img-1.jpg" alt="Equipe Wings" class="wp-image-101"/>' +
          '<figcaption class="wp-element-caption">Equipe Wings</figcaption></figure>\n<!-- /wp:image -->',
        '<p>Depois.</p>',
      ].join('\n\n'),
    );
  });

  it('splits a paragraph around a marker typed mid-sentence', () => {
    const { html } = render({ content: 'Antes {{img:1}} depois.', images: [image(1)] }, 'preview');
    expect(html).toBe(
      '<p>Antes</p>\n\n<figure><img src="https://site.test/img-1.jpg" alt="Post" /></figure>\n\n<p>depois.</p>',
    );
  });

  it('sends images without a marker to the end, in order', () => {
    const { html } = render(
      { content: '{{img:2}}\n\nTexto.', images: [image(1), image(2), image(3)] },
      'preview',
    );
    expect([...html.matchAll(/img-(\d)/g)].map((m) => m[1])).toEqual(['2', '1', '3']);
  });

  it('builds a WordPress gallery block from the chosen images, without repeating them', () => {
    const { html } = render({
      content: 'Texto.\n\n{{galeria}}\n\nFim.',
      images: [image(1), image(2), image(3)],
      gallery: [1, 3],
    });
    expect(html).toContain('<!-- wp:gallery {"linkTo":"none"} -->');
    expect(html).toContain('class="wp-block-gallery has-nested-images columns-default is-cropped"');
    const gallery = html.slice(html.indexOf('<!-- wp:gallery'), html.indexOf('<!-- /wp:gallery'));
    expect([...gallery.matchAll(/"id":(\d+)/g)].map((m) => m[1])).toEqual(['101', '103']);
    // Image 2 is loose and goes to the end; 1 and 3 appear only in the gallery.
    expect([...html.matchAll(/wp-image-(\d+)/g)].map((m) => m[1])).toEqual(['101', '103', '102']);
    expect(html.indexOf('/wp:gallery')).toBeLessThan(html.indexOf('<p>Fim.</p>'));
  });

  it('puts the video URL alone on its line for oEmbed, and an iframe in the preview', () => {
    const video = parseVideoLink('https://youtu.be/dQw4w9WgXcQ?t=10');
    const content = 'Assista:\n\n{{video}}\n\nFim.';
    expect(render({ content, video }).html).toBe(
      '<p>Assista:</p>\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n<p>Fim.</p>',
    );
    expect(render({ content, video }, 'preview').html).toContain(
      '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
    );
    // With no marker it goes last.
    expect(render({ content: 'Só texto.', video }).html.endsWith('watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  it('reports markers that point at nothing instead of failing', () => {
    const { html, problems } = render({ content: 'a\n\n{{img:4}}\n\n{{galeria}}\n\n{{video}}' });
    expect(html).toBe('<p>a</p>');
    expect(problems).toHaveLength(3);
  });
});

describe('video links', () => {
  it('accepts YouTube and Vimeo in their usual shapes', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ]) {
      expect(parseVideoLink(url)?.id).toBe('dQw4w9WgXcQ');
    }
    expect(parseVideoLink('https://vimeo.com/123456789')?.embedUrl).toBe(
      'https://player.vimeo.com/video/123456789',
    );
  });

  it('refuses anything else, including a file upload pretending to be a link', () => {
    for (const url of ['https://example.com/video.mp4', 'javascript:alert(1)', 'youtube.com', '']) {
      expect(parseVideoLink(url)).toBeNull();
    }
  });
});

describe('the post schema', () => {
  const valid = {
    title: 'Como é o dia a dia de um franqueado',
    excerpt: '',
    content: 'Um texto com mais de cinquenta caracteres para passar na validação.',
    categories: [37],
  };
  const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

  it('needs a category, and defaults the rest to empty', () => {
    expect(sitePostSchema.parse(valid)).toMatchObject({
      tags: [],
      images: [],
      gallery: [],
      videoUrl: '',
      featuredImageId: null,
    });
    expect(sitePostSchema.safeParse({ ...valid, categories: [] }).error?.issues[0]?.message).toBe(
      'Escolha pelo menos uma categoria',
    );
  });

  it('holds the gallery to real images, at least two, none repeated', () => {
    const images = [1, 2, 3].map((n) => ({ uploadId: id(n) }));
    const parse = (gallery: number[]) => sitePostSchema.safeParse({ ...valid, images, gallery });
    expect(parse([1, 3]).success).toBe(true);
    expect(parse([1]).success).toBe(false);
    expect(parse([1, 1]).success).toBe(false);
    expect(parse([1, 4]).success).toBe(false);
  });

  it('caps images at ten and takes only YouTube or Vimeo for video', () => {
    const eleven = Array.from({ length: 11 }, (_, n) => ({ uploadId: id(n % 9) }));
    expect(sitePostSchema.safeParse({ ...valid, images: eleven }).success).toBe(false);
    expect(sitePostSchema.safeParse({ ...valid, videoUrl: 'https://x.test/a.mp4' }).success).toBe(
      false,
    );
    expect(
      sitePostSchema.safeParse({ ...valid, videoUrl: 'https://vimeo.com/123456789' }).success,
    ).toBe(true);
  });
});
