import {
  ALT_TEXT_MAX,
  COMPLIANCE_RULE_LABEL,
  FEATURED_MIN_HEIGHT,
  FEATURED_MIN_WIDTH,
  FOCUS_KEYWORD_MAX,
  GALLERY_MARKER,
  IMAGE_CAPTION_MAX,
  MAX_POST_IMAGES,
  META_DESCRIPTION_MAX,
  META_DESCRIPTION_MIN,
  MIN_GALLERY_IMAGES,
  SEO_TITLE_MAX,
  SITE_IMAGE_MAX_BYTES,
  SITE_IMAGE_TYPES,
  SITE_POST_EXCERPT_MAX,
  SITE_POST_OUTCOME_LABEL,
  SITE_POST_TITLE_MAX,
  VIDEO_MARKER,
  checkCopyCompliance,
  imageMarker,
  isBigEnoughToFeature,
  parseVideoLink,
  renderSitePost,
  sitePostSchema,
  type SiteImageUpload,
  type SiteTerm,
} from '@wings/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  useCreateSiteDraft,
  useHoldSiteImage,
  useRefreshSiteTerms,
  useSitePosts,
  useSiteStatus,
  useSiteTerms,
} from '../../api/ads.js';
import { LoadFailure } from '../LoadFailure.js';
import { Alert, Button, Field, Input } from '../ui.js';
import { SeoChecklist } from './SeoChecklist.js';

/**
 * The owned-channels tab: places Wings publishes to without buying media.
 *
 * Deliberately not the paid-media form with fields hidden. The two share
 * nothing: there is no budget, no objective and no approvals gate here. The
 * only real channel is Wings' WordPress site, and all the studio can do there
 * is leave a draft, with new media in it, for a person to publish.
 *
 * The form is long, so it is cut into numbered groups, keeps a local copy of
 * what is being written, and after a failed send lists what to fix at the top
 * while keeping each message next to its field. Images are held by our own
 * server while the post is written. Nothing reaches the site until the
 * operator asks for the draft.
 */

const SOON = [
  { name: 'Portal ClickFranquia', description: 'Vitrine de franquias.' },
  { name: 'App ClickFranquia', description: 'Notificações e destaques no aplicativo.' },
] as const;

const ACCEPT = SITE_IMAGE_TYPES.join(',');
const AUTOSAVE_KEY = 'wings.site-post-draft.v1';
const DEFAULT_SITE_HOST = 'wingscompany.com.br';

/** Where each validation message belongs, and what to call it in the summary. */
const FIELD_ANCHOR: Record<string, { id: string; name: string }> = {
  title: { id: 'site-post-title', name: 'Título' },
  excerpt: { id: 'site-post-excerpt', name: 'Resumo' },
  categories: { id: 'site-post-categories', name: 'Categoria' },
  content: { id: 'site-post-content', name: 'Texto do post' },
  images: { id: 'site-post-images', name: 'Imagens no texto' },
  gallery: { id: 'site-post-gallery', name: 'Galeria' },
  videoUrl: { id: 'site-post-video', name: 'Vídeo' },
  featuredImageAlt: { id: 'site-post-featured-alt', name: 'Descrição da imagem destacada' },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function imageUrl(id: string): string {
  return `/api/marketing/site/images/${id}`;
}

/** Why a file cannot be used, before it is sent anywhere; null when it can. */
function fileProblem(file: File): string | null {
  if (!(SITE_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return `"${file.name}" não é JPG, PNG nem WebP. Exporte a imagem em um desses formatos.`;
  }
  if (file.size > SITE_IMAGE_MAX_BYTES) {
    return `"${file.name}" tem ${(file.size / 1024 / 1024).toFixed(1)} MB e o limite é 5 MB. Reduza a imagem e envie de novo.`;
  }
  return null;
}

/** Removing image N: its marker goes, and the ones after it move down one. */
function withoutImageMarker(text: string, removed: number): string {
  return text.replace(/\{\{\s*img\s*:\s*(\d{1,2})\s*\}\}/gi, (whole, raw: string) => {
    const position = Number(raw);
    if (position === removed) return '';
    return position > removed ? imageMarker(position - 1) : whole;
  });
}

interface BodyImage {
  upload: SiteImageUpload;
  caption: string;
  inGallery: boolean;
}

interface DraftState {
  title: string;
  excerpt: string;
  content: string;
  categories: number[];
  tags: number[];
  featured: SiteImageUpload | null;
  featuredAlt: string;
  images: BodyImage[];
  videoUrl: string;
  focusKeyword: string;
  seoTitle: string;
  metaDescription: string;
}

const EMPTY: DraftState = {
  title: '',
  excerpt: '',
  content: '',
  categories: [],
  tags: [],
  featured: null,
  featuredAlt: '',
  images: [],
  videoUrl: '',
  focusKeyword: '',
  seoTitle: '',
  metaDescription: '',
};

function isEmpty(draft: DraftState): boolean {
  return JSON.stringify(draft) === JSON.stringify(EMPTY);
}

/** What was being written last time, if the browser still has it. */
function loadAutosave(): DraftState | null {
  try {
    const raw = window.localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const saved = { ...EMPTY, ...(JSON.parse(raw) as Partial<DraftState>) };
    return isEmpty(saved) ? null : saved;
  } catch {
    return null;
  }
}

function FormGroup({
  step,
  title,
  intro,
  children,
}: {
  step: number;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="site-group">
      <legend>
        <span className="builder-step">{step}</span>
        {title}
      </legend>
      {intro && <p className="field-hint">{intro}</p>}
      {children}
    </fieldset>
  );
}

function TermPicker({
  id,
  label,
  hint,
  terms,
  selected,
  onToggle,
  required,
  filterable,
}: {
  id: string;
  label: string;
  hint: string;
  terms: SiteTerm[];
  selected: number[];
  onToggle: (id: number) => void;
  required?: boolean;
  filterable?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const visible = terms.filter(
    (term) =>
      selected.includes(term.id) || term.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <fieldset className="builder-states" id={id} tabIndex={-1}>
      <legend className="field-label">
        {label}
        {required && (
          <span className="field-required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </legend>
      {filterable && terms.length > 12 && (
        <Input
          aria-label={`Filtrar ${label.toLowerCase()}`}
          placeholder="Digite para filtrar"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      {visible.map((term) => (
        <label key={term.id} className="builder-state">
          <input
            type="checkbox"
            checked={selected.includes(term.id)}
            onChange={() => onToggle(term.id)}
          />
          <span>{term.name}</span>
        </label>
      ))}
      <span className="field-hint site-term-hint">{hint}</span>
    </fieldset>
  );
}

function WordPressChannel({ canPublish }: { canPublish: boolean }) {
  const status = useSiteStatus();
  const configured = status.data?.status.configured ?? false;
  const siteHost = status.data?.status.siteHost ?? DEFAULT_SITE_HOST;
  const terms = useSiteTerms(configured);
  const refreshTerms = useRefreshSiteTerms();
  const posts = useSitePosts();
  const hold = useHoldSiteImage();
  const create = useCreateSiteDraft();

  const [restored] = useState(loadAutosave);
  const [draft, setDraft] = useState<DraftState>(restored ?? EMPTY);
  const [showRestored, setShowRestored] = useState(restored !== null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [imageProblem, setImageProblem] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const summary = useRef<HTMLDivElement | null>(null);

  /** Which validation message a field's change makes stale. */
  const errorOf: Partial<Record<keyof DraftState, string[]>> = {
    title: ['title'],
    excerpt: ['excerpt'],
    content: ['content'],
    categories: ['categories'],
    images: ['images', 'gallery'],
    videoUrl: ['videoUrl'],
    featuredAlt: ['featuredImageAlt'],
  };
  const set = <K extends keyof DraftState>(key: K, value: DraftState[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    // A message about a field stops being true the moment the field changes;
    // it comes back on the next attempt if the problem is still there.
    const stale: string[] = errorOf[key] ?? [];
    if (stale.some((name) => name in errors)) {
      setErrors((current) =>
        Object.fromEntries(Object.entries(current).filter(([name]) => !stale.includes(name))),
      );
    }
  };
  const { title, excerpt, content, categories, tags, featured, featuredAlt, images, videoUrl } =
    draft;

  // A long form loses work to a closed tab. The browser keeps a copy of the
  // text and of the ids of images our server already holds; nothing else.
  useEffect(() => {
    try {
      if (isEmpty(draft)) window.localStorage.removeItem(AUTOSAVE_KEY);
      else window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(draft));
    } catch {
      // Private mode or a full quota: writing simply goes unsaved.
    }
  }, [draft]);

  const video = videoUrl.trim() ? parseVideoLink(videoUrl) : null;
  const gallery = images.flatMap((image, index) => (image.inGallery ? [index + 1] : []));
  const galleryReady = gallery.length >= MIN_GALLERY_IMAGES;

  const preview = useMemo(
    () =>
      renderSitePost(
        {
          content,
          images: images.map((image) => ({
            src: imageUrl(image.upload.id),
            caption: image.caption,
            alt: image.caption || title,
          })),
          gallery: galleryReady ? gallery : [],
          video,
        },
        'preview',
      ),
    // `gallery` and `video` are rebuilt each render; what they derive from is listed.
    [content, images, title, videoUrl],
  );

  // A warning and never a block: on our own site figures can be legitimate
  // (the COF numbers, for one), but whoever writes them should see the flags.
  const findings = checkCopyCompliance(`${title}\n${excerpt}\n${content}`);

  const toggle = (list: number[], id: number) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  /** Puts a marker where the cursor is, on a line of its own. */
  const insertAtCursor = (marker: string) => {
    const at = textarea.current?.selectionStart ?? content.length;
    const next = `${content.slice(0, at).replace(/\n*$/, '')}\n\n${marker}\n\n${content.slice(at).replace(/^\n*/, '')}`;
    set('content', next.replace(/^\n+/, ''));
    textarea.current?.focus();
  };

  const holdFiles = async (
    files: File[],
    onHeld: (image: SiteImageUpload, file: File) => string | null,
  ) => {
    setImageProblem(null);
    for (const file of files) {
      const problem = fileProblem(file);
      if (problem) {
        setImageProblem(problem);
        continue;
      }
      try {
        const { image } = await hold.mutateAsync(file);
        const refused = onHeld(image, file);
        if (refused) setImageProblem(refused);
      } catch (failure) {
        setImageProblem(
          `"${file.name}" não pôde ser enviada: ${failure instanceof Error ? failure.message : 'erro desconhecido'}. Tente de novo.`,
        );
      }
    }
  };

  const submit = () => {
    create.reset();
    const parsed = sitePostSchema.safeParse({
      title,
      excerpt,
      content,
      categories,
      tags,
      featuredImageId: featured?.id ?? null,
      featuredImageAlt: featuredAlt,
      images: images.map((image) => ({ uploadId: image.upload.id, caption: image.caption })),
      gallery,
      videoUrl,
      seo: {
        focusKeyword: draft.focusKeyword,
        seoTitle: draft.seoTitle,
        metaDescription: draft.metaDescription,
      },
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        next[key] ??= issue.message;
      }
      setErrors(next);
      // With several things to fix, the list at the top is where to start.
      window.setTimeout(() => summary.current?.focus(), 0);
      return;
    }
    setErrors({});
    create.mutate(parsed.data, {
      // Only a draft that exists clears the form. On any failure everything
      // typed and every image stays exactly where it is.
      onSuccess: () => {
        setDraft(EMPTY);
        setShowRestored(false);
      },
    });
  };

  const busy = hold.isPending || create.isPending;
  const errorKeys = Object.keys(errors);

  return (
    <section className="builder-section" aria-labelledby="owned-wordpress">
      <h2 id="owned-wordpress">
        Site da Wings (WordPress)
        {status.data?.status.siteHost && (
          <span className="tag coming-soon-tag">{status.data.status.siteHost}</span>
        )}
      </h2>
      <p className="builder-why">
        O site é de onde vem o lead orgânico e para onde os anúncios levam. Um post aqui não custa
        mídia e continua trazendo gente depois que a campanha acaba.
      </p>
      <p className="muted">
        Este formulário cria um <strong>rascunho</strong> no blog. Ele só vai ao ar quando alguém
        revisar e publicar dentro do WordPress. O studio não altera nem apaga o que já está no site.
      </p>

      {/* Not "falta configurar": a failed read says nothing about the server's settings. */}
      {status.isError && !status.data && (
        <LoadFailure
          what="o estado da ligação com o site"
          error={status.error}
          onRetry={() => void status.refetch()}
        />
      )}
      {status.isSuccess && !configured && (
        <Alert kind="error">
          Falta configurar no servidor o endereço do site, o usuário e a senha de aplicativo do
          WordPress. Você pode escrever o post, mas o envio fica desligado até lá.
        </Alert>
      )}

      {showRestored && (
        <Alert kind="info">
          Recuperamos o post que você estava escrevendo neste navegador.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setDraft(EMPTY);
              setShowRestored(false);
              setErrors({});
            }}
          >
            Descartar e começar do zero
          </button>
        </Alert>
      )}

      <div className="site-layout">
        <form
          className="builder"
          noValidate
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <p className="field-hint">
            Os campos com <span className="field-required">*</span> são obrigatórios. O que você
            escreve fica salvo neste navegador até o rascunho ser criado.
          </p>

          {errorKeys.length > 0 && (
            <div
              ref={summary}
              className="alert alert-error site-error-summary"
              role="alert"
              tabIndex={-1}
              aria-labelledby="site-error-title"
            >
              <strong id="site-error-title">
                {errorKeys.length === 1
                  ? 'Falta acertar 1 campo para criar o rascunho'
                  : `Falta acertar ${errorKeys.length} campos para criar o rascunho`}
              </strong>
              <ul>
                {errorKeys.map((key) => (
                  <li key={key}>
                    <a href={`#${FIELD_ANCHOR[key]?.id ?? 'owned-wordpress'}`}>
                      {FIELD_ANCHOR[key]?.name ?? 'Formulário'}
                    </a>
                    : {errors[key]}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <FormGroup step={1} title="Título e resumo">
            <Field
              label="Título"
              required
              error={errors.title}
              errorId="site-post-title-error"
              hint={`${title.length}/${SITE_POST_TITLE_MAX}`}
            >
              <Input
                id="site-post-title"
                maxLength={SITE_POST_TITLE_MAX}
                value={title}
                aria-required="true"
                aria-invalid={errors.title ? true : undefined}
                aria-describedby={errors.title ? 'site-post-title-error' : undefined}
                onChange={(event) => set('title', event.target.value)}
              />
            </Field>
            <Field
              label="Resumo"
              error={errors.excerpt}
              hint={`Aparece nas listagens do blog. ${excerpt.length}/${SITE_POST_EXCERPT_MAX}`}
            >
              <textarea
                id="site-post-excerpt"
                className="control"
                rows={2}
                maxLength={SITE_POST_EXCERPT_MAX}
                value={excerpt}
                onChange={(event) => set('excerpt', event.target.value)}
              />
            </Field>
          </FormGroup>

          {configured && (
            <FormGroup step={2} title="Categoria e tags">
              <div className="site-terms-head">
                <span className="field-hint">
                  {terms.data
                    ? `Lista lida do site em ${formatDateTime(terms.data.terms.fetchedAt)}.${
                        terms.data.stale
                          ? ' O site não respondeu agora, então esta é a última lista que temos.'
                          : ''
                      }`
                    : terms.isError
                      ? 'Não conseguimos ler as categorias e tags do site. Clique em Atualizar lista.'
                      : 'Lendo categorias e tags do site...'}
                </span>
                <button
                  type="button"
                  className="link-button"
                  disabled={refreshTerms.isPending}
                  onClick={() => refreshTerms.mutate()}
                >
                  {refreshTerms.isPending ? 'Atualizando...' : 'Atualizar lista'}
                </button>
              </div>
              <TermPicker
                id="site-post-categories"
                label="Categoria"
                required
                hint="Marque uma ou mais. São as categorias que já existem no site."
                terms={terms.data?.terms.categories ?? []}
                selected={categories}
                onToggle={(id) => set('categories', toggle(categories, id))}
              />
              {errors.categories && (
                <p className="field-error" role="alert">
                  {errors.categories}
                </p>
              )}
              <TermPicker
                id="site-post-tags"
                label="Tags"
                hint="Opcional. Para usar uma tag nova, crie no WordPress e clique em Atualizar lista."
                terms={terms.data?.terms.tags ?? []}
                selected={tags}
                onToggle={(id) => set('tags', toggle(tags, id))}
                filterable
              />
            </FormGroup>
          )}

          <FormGroup
            step={3}
            title="Imagem destacada"
            intro="É a capa do post e a imagem que aparece quando alguém compartilha o link."
          >
            <div className="builder-creative site-featured">
              <div className="builder-creative-thumb site-featured-thumb">
                {featured ? (
                  <img src={imageUrl(featured.id)} alt="Imagem destacada" />
                ) : (
                  <span className="muted">Sem imagem</span>
                )}
              </div>
              <div className="site-featured-fields">
                <input
                  type="file"
                  className="control"
                  aria-label="Imagem destacada"
                  accept={ACCEPT}
                  disabled={busy}
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void holdFiles(files.slice(0, 1), (image, file) => {
                      if (!isBigEnoughToFeature(image)) {
                        return `"${file.name}" tem ${image.width} × ${image.height} px. A imagem destacada precisa de pelo menos ${FEATURED_MIN_WIDTH} × ${FEATURED_MIN_HEIGHT}. Escolha uma versão maior.`;
                      }
                      set('featured', image);
                      return null;
                    });
                  }}
                />
                <p className="field-hint">
                  JPG, PNG ou WebP de até 5 MB, com no mínimo {FEATURED_MIN_WIDTH} ×{' '}
                  {FEATURED_MIN_HEIGHT} px.
                  {featured && ` Esta tem ${featured.width} × ${featured.height} px.`}
                </p>
                {featured && (
                  <>
                    <Field
                      label="Descrição da imagem (texto alternativo)"
                      error={errors.featuredImageAlt}
                      hint={`Uma frase dizendo o que a imagem mostra. Leitores de tela e o Google leem isso. ${featuredAlt.length}/${ALT_TEXT_MAX}`}
                    >
                      <Input
                        id="site-post-featured-alt"
                        maxLength={ALT_TEXT_MAX}
                        placeholder="Ex.: consultor da Wings apresentando o plano de expansão"
                        value={featuredAlt}
                        onChange={(event) => set('featuredAlt', event.target.value)}
                      />
                    </Field>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setDraft({ ...draft, featured: null, featuredAlt: '' })}
                    >
                      Remover imagem destacada
                    </button>
                  </>
                )}
              </div>
            </div>
          </FormGroup>

          <FormGroup step={4} title="Texto do post">
            <Field
              label="Texto"
              required
              error={errors.content}
              errorId="site-post-content-error"
              hint="Escreva como em qualquer editor. Se quiser formatar: ## Subtítulo, **negrito**, *itálico*, - item de lista, [texto do link](https://...). Uma linha em branco separa os parágrafos."
            >
              <textarea
                id="site-post-content"
                ref={textarea}
                className="control"
                rows={16}
                value={content}
                aria-required="true"
                aria-invalid={errors.content ? true : undefined}
                aria-describedby={errors.content ? 'site-post-content-error' : undefined}
                onChange={(event) => set('content', event.target.value)}
              />
            </Field>
            <div className="site-preview" aria-label="Prévia do post">
              <span className="field-label">Como o post vai ficar</span>
              <article className="post-preview">
                <h1>{title || 'Título do post'}</h1>
                {content.trim() || images.length > 0 || video ? (
                  // Built by renderSitePost, which escapes everything typed and
                  // emits only its own tags; see its tests.
                  <div dangerouslySetInnerHTML={{ __html: preview.html }} />
                ) : (
                  <p className="muted">O texto aparece aqui enquanto você escreve.</p>
                )}
              </article>
              {preview.problems.length > 0 && (
                <ul className="field-error site-preview-problems" role="alert">
                  {preview.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}
            </div>
          </FormGroup>

          <FormGroup
            step={5}
            title="Imagens, galeria e vídeo"
            intro="Opcional. As imagens só vão para o site quando você criar o rascunho."
          >
            <div id="site-post-images" tabIndex={-1}>
              <span className="field-label">Imagens no texto</span>
              <input
                type="file"
                className="control"
                aria-label="Imagens no texto"
                accept={ACCEPT}
                multiple
                disabled={busy || images.length >= MAX_POST_IMAGES}
                onChange={(event) => {
                  const room = MAX_POST_IMAGES - images.length;
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  void holdFiles(files.slice(0, room), (image) => {
                    setDraft((current) => ({
                      ...current,
                      images: [...current.images, { upload: image, caption: '', inGallery: false }],
                    }));
                    return null;
                  }).then(() => {
                    if (files.length > room) {
                      setImageProblem(
                        `Só cabiam mais ${room}. O limite é de ${MAX_POST_IMAGES} imagens por post, então as outras ficaram de fora.`,
                      );
                    }
                  });
                }}
              />
              <p className="field-hint">
                JPG, PNG ou WebP de até 5 MB cada, até {MAX_POST_IMAGES} por post. Clique em Inserir
                no texto para escolher onde cada uma aparece. As que ficarem sem posição vão para o
                fim do post, na ordem desta lista.
              </p>
            </div>

            {hold.isPending && (
              <p className="field-hint" role="status">
                Enviando imagem...
              </p>
            )}
            {imageProblem && (
              <p className="field-error" role="alert">
                {imageProblem}
              </p>
            )}
            {errors.images && (
              <p className="field-error" role="alert">
                {errors.images}
              </p>
            )}

            <ol className="site-images">
              {images.map((image, index) => {
                const position = index + 1;
                const placed = new RegExp(`\\{\\{\\s*img\\s*:\\s*${position}\\s*\\}\\}`, 'i').test(
                  content,
                );
                const update = (patch: Partial<BodyImage>) =>
                  set(
                    'images',
                    images.map((item, i) => (i === index ? { ...item, ...patch } : item)),
                  );
                return (
                  <li key={image.upload.id}>
                    <img src={imageUrl(image.upload.id)} alt={`Imagem ${position}`} />
                    <div>
                      <strong>
                        Imagem {position}{' '}
                        <small className="muted">
                          {image.upload.width} × {image.upload.height} px.{' '}
                          {placed
                            ? `Está no texto, em ${imageMarker(position)}.`
                            : image.inGallery && galleryReady
                              ? 'Está na galeria.'
                              : 'Vai para o fim do post.'}
                        </small>
                      </strong>
                      <Input
                        aria-label={`Legenda da imagem ${position}`}
                        placeholder="Legenda (opcional)"
                        maxLength={IMAGE_CAPTION_MAX}
                        value={image.caption}
                        onChange={(event) => update({ caption: event.target.value })}
                      />
                      <div className="site-image-actions">
                        <Button
                          type="button"
                          variant="ghost"
                          className="btn-inline"
                          disabled={placed}
                          onClick={() => insertAtCursor(imageMarker(position))}
                        >
                          Inserir no texto
                        </Button>
                        <label className="checkbox-field">
                          <input
                            type="checkbox"
                            checked={image.inGallery}
                            onChange={() => update({ inGallery: !image.inGallery })}
                          />
                          <span>Na galeria</span>
                        </label>
                        <button
                          type="button"
                          className="link-button"
                          aria-label={`Remover imagem ${position}`}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              images: images.filter((_, i) => i !== index),
                              content: withoutImageMarker(content, position),
                            })
                          }
                        >
                          Remover
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div id="site-post-gallery" tabIndex={-1}>
              <span className="field-label">Galeria</span>
              <p className="field-hint">
                Marque Na galeria em {MIN_GALLERY_IMAGES} ou mais imagens. No site ela aparece em
                grade, porque o tema não tem carrossel.{' '}
                {gallery.length > 0 &&
                  (galleryReady
                    ? `${gallery.length} imagens na galeria.`
                    : `Falta mais ${MIN_GALLERY_IMAGES - gallery.length} para formar a galeria.`)}
              </p>
              {errors.gallery && (
                <p className="field-error" role="alert">
                  {errors.gallery}
                </p>
              )}
              <Button
                type="button"
                variant="ghost"
                className="btn-inline"
                disabled={!galleryReady || content.includes(GALLERY_MARKER)}
                onClick={() => insertAtCursor(GALLERY_MARKER)}
              >
                Inserir galeria no texto
              </Button>
            </div>

            <div>
              <Field
                label="Vídeo (link do YouTube ou Vimeo)"
                error={
                  errors.videoUrl ??
                  (videoUrl.trim() && !video
                    ? 'Este link não é do YouTube nem do Vimeo. Cole o endereço da página do vídeo.'
                    : undefined)
                }
                hint="Cole o link e o WordPress monta o player. Arquivo de vídeo não sobe por aqui porque pesa na hospedagem do site."
              >
                <Input
                  id="site-post-video"
                  type="url"
                  placeholder="https://www.youtube.com/watch?v=..."
                  value={videoUrl}
                  onChange={(event) => set('videoUrl', event.target.value)}
                />
              </Field>
              <Button
                type="button"
                variant="ghost"
                className="btn-inline"
                disabled={!video || content.includes(VIDEO_MARKER)}
                onClick={() => insertAtCursor(VIDEO_MARKER)}
              >
                Inserir vídeo no texto
              </Button>
            </div>
          </FormGroup>

          <FormGroup
            step={6}
            title="SEO"
            intro="O checklist ao lado usa estes três campos. O site não os recebe pela integração: eles ficam guardados em Últimos envios para você colar no Rank Math ao revisar o rascunho."
          >
            <Field
              label="Palavra-chave foco"
              hint="O termo que a pessoa digitaria no Google para achar este post."
            >
              <Input
                maxLength={FOCUS_KEYWORD_MAX}
                placeholder="Ex.: formatação de franquia"
                value={draft.focusKeyword}
                onChange={(event) => set('focusKeyword', event.target.value)}
              />
            </Field>
            <Field
              label="Título SEO"
              hint={`O link azul no resultado do Google. ${draft.seoTitle.length}/${SEO_TITLE_MAX}`}
            >
              <Input
                value={draft.seoTitle}
                maxLength={120}
                onChange={(event) => set('seoTitle', event.target.value)}
              />
            </Field>
            <Field
              label="Meta descrição"
              hint={`O texto cinza embaixo do link. Entre ${META_DESCRIPTION_MIN} e ${META_DESCRIPTION_MAX} caracteres. ${draft.metaDescription.length}/${META_DESCRIPTION_MAX}`}
            >
              <textarea
                className="control"
                rows={3}
                maxLength={320}
                value={draft.metaDescription}
                onChange={(event) => set('metaDescription', event.target.value)}
              />
            </Field>
          </FormGroup>

          {findings.length > 0 && (
            <div className="alert alert-warning" role="alert">
              <strong>Confira o que este texto promete.</strong> No site isto não bloqueia o
              rascunho, mas quem publicar precisa checar:
              <ul>
                {findings.map((finding) => (
                  <li key={`${finding.rule}:${finding.excerpt}`}>
                    {COMPLIANCE_RULE_LABEL[finding.rule]}: "{finding.excerpt}"
                  </li>
                ))}
              </ul>
            </div>
          )}

          {create.isError && <Alert kind="error">{create.error.message}</Alert>}
          {create.isSuccess && (
            <Alert kind="success">
              Rascunho criado. Ele ainda não está no ar.{' '}
              <a href={create.data.editUrl} target="_blank" rel="noreferrer">
                Abrir no WordPress para revisar e publicar
              </a>
            </Alert>
          )}

          <div className="form-actions">
            <Button type="submit" disabled={!configured || !canPublish || busy}>
              {create.isPending
                ? 'Enviando imagens e criando o rascunho...'
                : 'Criar rascunho no site'}
            </Button>
          </div>
          {!canPublish && (
            <p className="field-hint">Seu perfil não tem permissão para enviar conteúdo ao site.</p>
          )}
        </form>

        <SeoChecklist
          input={{
            title,
            excerpt,
            content,
            focusKeyword: draft.focusKeyword,
            seoTitle: draft.seoTitle,
            metaDescription: draft.metaDescription,
            hasFeaturedImage: featured !== null,
            featuredImageAlt: featuredAlt,
            siteHost,
          }}
        />
      </div>

      {posts.isError && !posts.data && (
        <LoadFailure
          what="os últimos envios"
          error={posts.error}
          onRetry={() => void posts.refetch()}
        />
      )}
      {(posts.data?.posts.length ?? 0) > 0 && (
        <div>
          <span className="field-label">Últimos envios</span>
          <ul className="site-posts">
            {posts.data?.posts.map((post) => (
              <li key={post.id}>
                <span>
                  {post.title}{' '}
                  {post.editUrl && (
                    <a href={post.editUrl} target="_blank" rel="noreferrer">
                      Editar no WordPress
                    </a>
                  )}
                </span>
                <span className="cell-sub">
                  {SITE_POST_OUTCOME_LABEL[post.outcome]} ·{' '}
                  {post.categoryNames.length > 0 ? post.categoryNames.join(', ') : 'sem categoria'}{' '}
                  · {post.hasFeaturedImage ? 'com imagem destacada' : 'sem imagem destacada'}
                  {post.imageCount > 0 && ` · ${post.imageCount} no texto`} ·{' '}
                  {post.createdByName ?? 'autor não registrado'} · {formatDateTime(post.createdAt)}
                </span>
                {post.seo &&
                  (post.seo.focusKeyword || post.seo.seoTitle || post.seo.metaDescription) && (
                    <details className="site-post-seo">
                      <summary>SEO para colar no Rank Math</summary>
                      <dl>
                        <dt>Palavra-chave foco</dt>
                        <dd>{post.seo.focusKeyword || 'não preenchida'}</dd>
                        <dt>Título SEO</dt>
                        <dd>{post.seo.seoTitle || 'não preenchido'}</dd>
                        <dt>Meta descrição</dt>
                        <dd>{post.seo.metaDescription || 'não preenchida'}</dd>
                      </dl>
                    </details>
                  )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function OwnedChannelsPanel({ canPublish }: { canPublish: boolean }) {
  return (
    <div className="builder">
      <WordPressChannel canPublish={canPublish} />
      {SOON.map((channel) => (
        <section
          key={channel.name}
          className="builder-section builder-section-soon"
          aria-label={channel.name}
        >
          <h2>
            {channel.name}
            <span className="tag coming-soon-tag">Em breve</span>
          </h2>
          <p className="muted">{channel.description}</p>
        </section>
      ))}
    </div>
  );
}
