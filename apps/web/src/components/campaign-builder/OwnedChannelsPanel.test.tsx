import type { SiteImageUpload, SitePostRecord, SiteTerms } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The owned-channels tab promises one thing on screen — a draft, never a live
 * post — shows the post as it will read, media included, and keeps the form
 * intact when anything goes wrong.
 */

const site = { configured: true };
const posts: { current: SitePostRecord[] } = { current: [] };
const createDraft = vi.fn();
const refreshTerms = vi.fn();
const createState: { current: Record<string, unknown> } = { current: {} };
const nextImage: { current: Partial<SiteImageUpload> } = { current: {} };
let held = 0;

const terms: SiteTerms = {
  categories: [
    { id: 37, name: 'Formatação de Franquia', count: 14 },
    { id: 39, name: 'Governança & Franchising', count: 1 },
  ],
  tags: [
    { id: 7, name: 'Artigo', count: 9 },
    { id: 8, name: 'IA', count: 2 },
  ],
  fetchedAt: '2026-09-19T15:00:00.000Z',
};

vi.mock('../../api/ads.js', () => ({
  useSiteStatus: () => ({
    isSuccess: true,
    data: {
      status: {
        configured: site.configured,
        siteHost: site.configured ? 'wingscompany.com.br' : null,
      },
    },
  }),
  useSiteTerms: (enabled: boolean) => ({ data: enabled ? { terms } : undefined, isError: false }),
  useRefreshSiteTerms: () => ({ mutate: refreshTerms, isPending: false }),
  useSitePosts: () => ({ data: { posts: posts.current } }),
  useHoldSiteImage: () => ({
    isPending: false,
    mutateAsync: async () => {
      held += 1;
      return {
        image: {
          id: `0000000${held}-0000-4000-8000-000000000000`,
          mimeType: 'image/jpeg',
          width: 1600,
          height: 900,
          byteSize: 1000,
          ...nextImage.current,
        },
      };
    },
  }),
  useCreateSiteDraft: () => ({
    mutate: createDraft,
    reset: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
    error: null,
    ...createState.current,
  }),
}));

const { OwnedChannelsPanel } = await import('./OwnedChannelsPanel.js');

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  site.configured = true;
  posts.current = [];
  createState.current = {};
  nextImage.current = {};
  held = 0;
  createDraft.mockReset();
  refreshTerms.mockReset();
});

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });
const file = (name = 'foto.jpg', type_ = 'image/jpeg', size = 1000) => {
  const f = new File(['x'], name, { type: type_ });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const choose = (label: string | RegExp, files: File[]) =>
  fireEvent.change(screen.getByLabelText(label), { target: { files } });
const previewHtml = () => screen.getByLabelText('Prévia do post').innerHTML;
const text = () => screen.getByLabelText(/^Texto \*/) as HTMLTextAreaElement;

function fillBasics() {
  type(screen.getByLabelText(/^Título \*/), 'Como é o dia a dia de um franqueado');
  type(text(), 'Um texto com mais de cinquenta caracteres para passar na validação do post.');
}

describe('the owned-channels tab', () => {
  it('shows the site as the only real channel, the others as coming soon', () => {
    render(<OwnedChannelsPanel canPublish />);
    expect(screen.getByRole('button', { name: 'Criar rascunho no site' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Portal ClickFranquia' }).textContent).toContain(
      'Em breve',
    );
    expect(screen.getByRole('region', { name: 'App ClickFranquia' }).textContent).toContain(
      'Em breve',
    );
    expect(screen.queryByText(/Verba/)).toBeNull();
  });

  it('offers the site’s own categories and tags, and needs a category', async () => {
    render(<OwnedChannelsPanel canPublish />);
    fillBasics();
    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunho no site' }));
    expect(screen.getByText('Escolha pelo menos uma categoria')).toBeTruthy();
    expect(createDraft).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Governança & Franchising' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'IA' }));
    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunho no site' }));
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    expect(createDraft.mock.calls[0]?.[0]).toMatchObject({ categories: [39], tags: [8] });

    fireEvent.click(screen.getByRole('button', { name: 'Atualizar lista' }));
    expect(refreshTerms).toHaveBeenCalledTimes(1);
  });

  it('shows Markdown as it will read, and escapes anything that looks like markup', () => {
    render(<OwnedChannelsPanel canPublish />);
    type(text(), '## Rotina\n\nTexto com **força** e <script>alert(1)</script>.\n\n- um\n- dois');
    expect(previewHtml()).toContain('<h2>Rotina</h2>');
    expect(previewHtml()).toContain('<strong>força</strong>');
    expect(previewHtml()).toContain('<ul><li>um</li><li>dois</li></ul>');
    expect(previewHtml()).not.toContain('<script>');
  });

  it('checks the featured image before using it, and previews it', async () => {
    render(<OwnedChannelsPanel canPublish />);
    choose('Imagem destacada', [file('capa.gif', 'image/gif')]);
    expect(await screen.findByText(/"capa.gif" não é JPG, PNG nem WebP/)).toBeTruthy();
    choose('Imagem destacada', [file('capa.jpg', 'image/jpeg', 6 * 1024 * 1024)]);
    expect(await screen.findByText(/o limite é 5 MB. Reduza a imagem/)).toBeTruthy();
    expect(held).toBe(0);

    nextImage.current = { width: 800, height: 600 };
    choose('Imagem destacada', [file('pequena.jpg')]);
    expect(
      await screen.findByText(
        /800 × 600 px. A imagem destacada precisa de pelo menos 1200 × 630. Escolha uma versão maior/,
      ),
    ).toBeTruthy();
    expect(screen.queryByAltText('Imagem destacada')).toBeNull();

    nextImage.current = {};
    choose('Imagem destacada', [file('capa.jpg')]);
    expect(await screen.findByAltText('Imagem destacada')).toBeTruthy();
  });

  it('places body images at the cursor, keeps markers right when one is removed, and sends captions', async () => {
    render(<OwnedChannelsPanel canPublish />);
    fillBasics();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Formatação de Franquia' }));
    choose('Imagens no texto', [file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    await screen.findByLabelText('Legenda da imagem 3');

    // Cursor after "Um texto": the marker lands there, on a line of its own.
    text().setSelectionRange(8, 8);
    fireEvent.click(screen.getAllByRole('button', { name: 'Inserir no texto' })[1] as Element);
    expect(text().value.startsWith('Um texto\n\n{{img:2}}\n\n')).toBe(true);
    type(screen.getByLabelText('Legenda da imagem 2'), 'Equipe Wings');
    expect(previewHtml()).toContain('<figcaption>Equipe Wings</figcaption>');
    // Image 2 sits between the two halves of the text; 1 and 3 go to the end.
    expect([...previewHtml().matchAll(/images\/0000000(\d)/g)].map((m) => m[1])).toEqual([
      '2',
      '1',
      '3',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Remover imagem 1' }));
    expect(text().value).toContain('{{img:1}}');
    expect(text().value).not.toContain('{{img:2}}');

    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunho no site' }));
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    expect(createDraft.mock.calls[0]?.[0].images).toEqual([
      { uploadId: '00000002-0000-4000-8000-000000000000', caption: 'Equipe Wings' },
      { uploadId: '00000003-0000-4000-8000-000000000000', caption: '' },
    ]);
  });

  it('builds a gallery from two or more images and says it renders as a grid', async () => {
    render(<OwnedChannelsPanel canPublish />);
    fillBasics();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Formatação de Franquia' }));
    choose('Imagens no texto', [file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    await screen.findByLabelText('Legenda da imagem 3');
    expect(screen.getByText(/porque o tema não tem carrossel/)).toBeTruthy();

    const inGallery = screen.getAllByRole('checkbox', { name: 'Na galeria' });
    fireEvent.click(inGallery[0] as Element);
    expect(screen.getByText(/Falta mais 1 para formar a galeria/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Inserir galeria no texto' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(inGallery[2] as Element);
    fireEvent.click(screen.getByRole('button', { name: 'Inserir galeria no texto' }));
    expect(text().value).toContain('{{galeria}}');
    expect(previewHtml()).toContain('class="post-gallery"');

    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunho no site' }));
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    expect(createDraft.mock.calls[0]?.[0].gallery).toEqual([1, 3]);
  });

  it('takes a YouTube or Vimeo link only, and plays it in the preview where the marker is', () => {
    render(<OwnedChannelsPanel canPublish />);
    type(screen.getByLabelText(/^Vídeo/), 'https://example.com/video.mp4');
    expect(screen.getByText(/Este link não é do YouTube nem do Vimeo/)).toBeTruthy();
    expect(screen.queryByLabelText(/arquivo de vídeo/i)).toBeNull();

    type(screen.getByLabelText(/^Vídeo/), 'https://youtu.be/dQw4w9WgXcQ');
    type(text(), 'Antes.\n\nDepois.');
    text().setSelectionRange(6, 6);
    fireEvent.click(screen.getByRole('button', { name: 'Inserir vídeo no texto' }));
    const html = previewHtml();
    expect(html).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(html.indexOf('Antes.')).toBeLessThan(html.indexOf('<iframe'));
    expect(html.indexOf('<iframe')).toBeLessThan(html.indexOf('Depois.'));
  });

  it('updates the SEO checklist while the person types, with a state that is not colour alone', () => {
    render(<OwnedChannelsPanel canPublish />);
    const list = screen.getByRole('complementary', { name: 'Checklist SEO' });
    const item = (label: RegExp) =>
      [...list.querySelectorAll('li')].find((li) => label.test(li.textContent ?? ''));
    expect(screen.getByRole('status').textContent).toBe('0 de 10 itens prontos');
    expect(item(/Palavra-chave no título/)?.textContent).toContain('Falta: ');

    type(screen.getByLabelText(/^Palavra-chave foco/), 'formatação de franquia');
    type(screen.getByLabelText(/^Título \*/), 'Formatacao de Franquia: por onde começar');
    expect(item(/Palavra-chave no título/)?.textContent).toContain('Feito: ');
    expect(item(/Palavra-chave no título/)?.className).toBe('seo-check-ok');

    type(
      text(),
      'Sem a palavra aqui.\n\n## Etapas da formatação de franquia\n\nVeja https://wingscompany.com.br/contato',
    );
    expect(item(/no primeiro parágrafo/)?.className).toBe('seo-check-missing');
    expect(item(/em um subtítulo/)?.className).toBe('seo-check-ok');
    expect(item(/Link para outra página de wingscompany.com.br/)?.className).toBe('seo-check-ok');

    type(screen.getByLabelText(/^Meta descrição/), 'curta');
    expect(item(/Meta descrição entre 120 e 160/)?.textContent).toContain(
      'Faltam 115 para o mínimo',
    );
    expect(screen.getByRole('status').textContent).toBe('4 de 10 itens prontos');
  });

  it('never lets the checklist block the draft, and keeps SEO fields out of what goes to the site', async () => {
    render(<OwnedChannelsPanel canPublish />);
    fillBasics();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Formatação de Franquia' }));
    type(screen.getByLabelText(/^Palavra-chave foco/), 'franquia');
    expect(screen.getByRole('status').textContent).toMatch(/^[0-3] de 10/);
    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunho no site' }));
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));
    expect(createDraft.mock.calls[0]?.[0].seo).toEqual({
      focusKeyword: 'franquia',
      seoTitle: '',
      metaDescription: '',
    });
    expect(screen.getByText(/para você colar no Rank Math/)).toBeTruthy();
  });

  it('lists what to fix at the top, focuses it, and keeps each message by its field', async () => {
    render(<OwnedChannelsPanel canPublish />);
    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunho no site' }));
    const summary = await screen.findByText('Falta acertar 3 campos para criar o rascunho');
    const box = summary.closest('div') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.querySelector('a[href="#site-post-title"]')?.textContent).toBe('Título');
    expect(box.querySelector('a[href="#site-post-categories"]')).toBeTruthy();

    const title = screen.getByLabelText(/^Título \*/);
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(title.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Dê um título ao post',
    );

    // A message stops being shown as soon as its field changes.
    type(title, 'Agora tem título');
    expect(screen.queryByText('Dê um título ao post')).toBeNull();
    expect(screen.getByText('Falta acertar 2 campos para criar o rascunho')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Formatação de Franquia' }));
    type(text(), 'Um texto com mais de cinquenta caracteres para passar na validação do post.');
    expect(screen.queryByText(/Falta acertar/)).toBeNull();
  });

  it('keeps what was being written across a closed tab, and lets the person discard it', () => {
    const first = render(<OwnedChannelsPanel canPublish />);
    type(screen.getByLabelText(/^Título \*/), 'Um post pela metade');
    type(screen.getByLabelText(/^Palavra-chave foco/), 'franquia');
    first.unmount();

    render(<OwnedChannelsPanel canPublish />);
    expect((screen.getByLabelText(/^Título \*/) as HTMLInputElement).value).toBe(
      'Um post pela metade',
    );
    expect(screen.getByText(/Recuperamos o post que você estava escrevendo/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Descartar e começar do zero' }));
    expect((screen.getByLabelText(/^Título \*/) as HTMLInputElement).value).toBe('');
    expect(window.localStorage.getItem('wings.site-post-draft.v1')).toBeNull();
  });

  it('keeps everything in the form when sending fails', async () => {
    createState.current = {
      isError: true,
      error: new Error(
        'Imagem 2 não subiu para o WordPress. O post não foi criado e o formulário continua como está.',
      ),
    };
    render(<OwnedChannelsPanel canPublish />);
    fillBasics();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Formatação de Franquia' }));
    choose('Imagens no texto', [file('a.jpg')]);
    await screen.findByLabelText('Legenda da imagem 1');
    fireEvent.click(screen.getByRole('button', { name: 'Criar rascunho no site' }));
    await waitFor(() => expect(createDraft).toHaveBeenCalledTimes(1));

    expect(screen.getByText(/Imagem 2 não subiu.*não foi criado/)).toBeTruthy();
    expect((screen.getByLabelText(/^Título \*/) as HTMLInputElement).value).toBe(
      'Como é o dia a dia de um franqueado',
    );
    expect(screen.getByLabelText('Legenda da imagem 1')).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: 'Formatação de Franquia' }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it('links to WordPress once the draft exists', () => {
    createState.current = {
      isSuccess: true,
      data: { editUrl: 'https://wingscompany.com.br/wp-admin/post.php?post=9&action=edit' },
    };
    render(<OwnedChannelsPanel canPublish />);
    expect(screen.getByText(/ainda não está no ar/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /revisar e publicar/ }).getAttribute('href')).toContain(
      'post=9',
    );
  });

  it('turns sending off, and says why, when the server has no credentials', () => {
    site.configured = false;
    render(<OwnedChannelsPanel canPublish />);
    expect(screen.getByText(/Falta configurar no servidor/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Criar rascunho no site' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('warns about risky promises without blocking the site', () => {
    render(<OwnedChannelsPanel canPublish />);
    type(screen.getByLabelText(/^Título \*/), 'Retorno garantido em 12 meses');
    expect(screen.getByText(/No site isto não bloqueia o\s+rascunho/)).toBeTruthy();
  });

  it('lists what was sent with its edit link, category and images', () => {
    posts.current = [
      {
        id: 'p1',
        title: 'Post enviado',
        outcome: 'draft_created',
        editUrl: 'https://wingscompany.com.br/wp-admin/post.php?post=12&action=edit',
        categoryNames: ['Formatação de Franquia'],
        hasFeaturedImage: true,
        imageCount: 3,
        seo: {
          focusKeyword: 'formatação de franquia',
          seoTitle: 'Formatação de franquia: por onde começar',
          metaDescription: '',
        },
        createdAt: '2026-09-18T12:00:00.000Z',
        createdByName: 'Eric',
      },
      {
        id: 'p2',
        title: 'Sem confirmação',
        outcome: 'unknown',
        editUrl: null,
        categoryNames: [],
        hasFeaturedImage: false,
        imageCount: 0,
        seo: null,
        createdAt: '2026-09-18T11:00:00.000Z',
        createdByName: 'Eric',
      },
    ];
    render(<OwnedChannelsPanel canPublish />);
    expect(
      screen.getByRole('link', { name: 'Editar no WordPress' }).getAttribute('href'),
    ).toContain('post=12');
    expect(
      screen.getByText(/Formatação de Franquia · com imagem destacada · 3 no texto/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /O site não confirmou. Confira no WordPress · sem categoria · sem imagem destacada/,
      ),
    ).toBeTruthy();
    // What was typed for SEO is kept here, to be pasted into Rank Math.
    expect(screen.getByText('SEO para colar no Rank Math')).toBeTruthy();
    expect(screen.getByText('Formatação de franquia: por onde começar')).toBeTruthy();
  });
});
