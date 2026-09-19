import {
  COMPLIANCE_RULE_LABEL,
  FEATURED_MIN_HEIGHT,
  FEATURED_MIN_WIDTH,
  GALLERY_MARKER,
  IMAGE_CAPTION_MAX,
  MAX_POST_IMAGES,
  MIN_GALLERY_IMAGES,
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
import { useMemo, useRef, useState } from 'react';
import {
  useCreateSiteDraft,
  useHoldSiteImage,
  useRefreshSiteTerms,
  useSitePosts,
  useSiteStatus,
  useSiteTerms,
} from '../../api/ads.js';
import { Alert, Button, Field, Input } from '../ui.js';

/**
 * The owned-channels tab: places Wings publishes to without buying media.
 *
 * Deliberately not the paid-media form with fields hidden — the two share
 * nothing: there is no budget, no objective and no approvals gate here. The
 * only real channel is Wings' WordPress site, and all the studio can do there
 * is leave a draft, with new media in it, for a person to publish.
 *
 * Images are held by our own server while the post is written, so they can be
 * checked and previewed. Nothing reaches the site until "Criar rascunho".
 */

const SOON = [
  { name: 'Portal ClickFranquia', description: 'Vitrine de franquias.' },
  { name: 'App ClickFranquia', description: 'Notificações e destaques no aplicativo.' },
] as const;

const ACCEPT = SITE_IMAGE_TYPES.join(',');

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function imageUrl(id: string): string {
  return `/api/marketing/site/images/${id}`;
}

/** Why a file cannot be used, before it is sent anywhere; null when it can. */
function fileProblem(file: File): string | null {
  if (!(SITE_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return `“${file.name}”: use JPG, PNG ou WebP.`;
  }
  if (file.size > SITE_IMAGE_MAX_BYTES) {
    return `“${file.name}” tem ${(file.size / 1024 / 1024).toFixed(1)} MB. O máximo é 5 MB.`;
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

function TermPicker({
  label,
  hint,
  terms,
  selected,
  onToggle,
  filterable,
}: {
  label: string;
  hint: string;
  terms: SiteTerm[];
  selected: number[];
  onToggle: (id: number) => void;
  filterable?: boolean;
}) {
  const [filter, setFilter] = useState('');
  const visible = terms.filter(
    (term) =>
      selected.includes(term.id) || term.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <fieldset className="builder-states">
      <legend className="field-label">{label}</legend>
      {filterable && terms.length > 12 && (
        <Input
          aria-label={`Filtrar ${label.toLowerCase()}`}
          placeholder="Filtrar…"
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
  const terms = useSiteTerms(configured);
  const refreshTerms = useRefreshSiteTerms();
  const posts = useSitePosts();
  const hold = useHoldSiteImage();
  const create = useCreateSiteDraft();

  const [title, setTitle] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [content, setContent] = useState('');
  const [categories, setCategories] = useState<number[]>([]);
  const [tags, setTags] = useState<number[]>([]);
  const [featured, setFeatured] = useState<SiteImageUpload | null>(null);
  const [images, setImages] = useState<BodyImage[]>([]);
  const [videoUrl, setVideoUrl] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [imageProblem, setImageProblem] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

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

  // A warning, not a block: on our own site figures can be legitimate (the COF
  // numbers, for one), but whoever writes them should see the same flags.
  const findings = checkCopyCompliance(`${title}\n${excerpt}\n${content}`);

  const toggle = (list: number[], id: number) =>
    list.includes(id) ? list.filter((item) => item !== id) : [...list, id];

  /** Puts a marker where the cursor is, on a line of its own. */
  const insertAtCursor = (marker: string) => {
    const at = textarea.current?.selectionStart ?? content.length;
    const next = `${content.slice(0, at).replace(/\n*$/, '')}\n\n${marker}\n\n${content.slice(at).replace(/^\n*/, '')}`;
    setContent(next.replace(/^\n+/, ''));
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
        setImageProblem(`“${file.name}”: ${failure instanceof Error ? failure.message : 'falhou'}`);
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
      images: images.map((image) => ({ uploadId: image.upload.id, caption: image.caption })),
      gallery,
      videoUrl,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        next[key] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    create.mutate(parsed.data, {
      // Only a draft that exists clears the form. On any failure everything
      // typed and every image stays exactly where it is.
      onSuccess: () => {
        setTitle('');
        setExcerpt('');
        setContent('');
        setCategories([]);
        setTags([]);
        setFeatured(null);
        setImages([]);
        setVideoUrl('');
      },
    });
  };

  const busy = hold.isPending || create.isPending;

  return (
    <section className="builder-section" aria-labelledby="owned-wordpress">
      <h2 id="owned-wordpress">
        Site da Wings (WordPress)
        {status.data?.status.siteHost && (
          <span className="tag coming-soon-tag">{status.data.status.siteHost}</span>
        )}
      </h2>
      <p className="builder-why">
        O site é de onde o lead orgânico vem e para onde os anúncios levam. Conteúdo aqui não custa
        mídia e continua trazendo gente depois que a campanha acaba.
      </p>
      <p className="muted">
        Cria um <strong>rascunho</strong> de post no blog. Nada fica público: alguém revisa e
        publica dentro do WordPress. O studio não edita nem apaga o que já está no site.
      </p>

      {status.isSuccess && !configured && (
        <Alert kind="error">
          A integração ainda não foi configurada no servidor (endereço do site, usuário e senha de
          aplicativo do WordPress). Você pode escrever, mas o envio está desligado.
        </Alert>
      )}

      <form
        className="builder"
        noValidate
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="Título" error={errors.title} hint={`${title.length}/${SITE_POST_TITLE_MAX}`}>
          <Input
            maxLength={SITE_POST_TITLE_MAX}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field
          label="Resumo"
          error={errors.excerpt}
          hint={`Opcional · aparece nas listagens do blog · ${excerpt.length}/${SITE_POST_EXCERPT_MAX}`}
        >
          <textarea
            className="control"
            rows={2}
            maxLength={SITE_POST_EXCERPT_MAX}
            value={excerpt}
            onChange={(event) => setExcerpt(event.target.value)}
          />
        </Field>

        {configured && (
          <div className="site-terms">
            <div className="site-terms-head">
              <span className="field-hint">
                {terms.data
                  ? `Categorias e tags lidas do site em ${formatDateTime(terms.data.terms.fetchedAt)}.${
                      terms.data.stale ? ' O site não respondeu agora; esta é a última lista.' : ''
                    }`
                  : terms.isError
                    ? 'Não foi possível ler as categorias e tags do site.'
                    : 'Lendo categorias e tags do site…'}
              </span>
              <button
                type="button"
                className="link-button"
                disabled={refreshTerms.isPending}
                onClick={() => refreshTerms.mutate()}
              >
                {refreshTerms.isPending ? 'Atualizando…' : 'Atualizar lista'}
              </button>
            </div>
            <TermPicker
              label="Categoria"
              hint="Uma ou mais. São as categorias que já existem no site."
              terms={terms.data?.terms.categories ?? []}
              selected={categories}
              onToggle={(id) => setCategories(toggle(categories, id))}
            />
            {errors.categories && (
              <p className="field-error" role="alert">
                {errors.categories}
              </p>
            )}
            <TermPicker
              label="Tags"
              hint="Só tags que já existem: tag nova se cria no WordPress e aparece aqui em “Atualizar lista”."
              terms={terms.data?.terms.tags ?? []}
              selected={tags}
              onToggle={(id) => setTags(toggle(tags, id))}
              filterable
            />
          </div>
        )}

        <div className="site-featured">
          <span className="field-label">Imagem destacada</span>
          <div className="builder-creative">
            <div className="builder-creative-thumb site-featured-thumb">
              {featured ? (
                <img src={imageUrl(featured.id)} alt="Imagem destacada" />
              ) : (
                <span className="muted">Sem imagem</span>
              )}
            </div>
            <div>
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
                      return `“${file.name}” tem ${image.width} × ${image.height} px. A imagem destacada precisa de pelo menos ${FEATURED_MIN_WIDTH} × ${FEATURED_MIN_HEIGHT}.`;
                    }
                    setFeatured(image);
                    return null;
                  });
                }}
              />
              <p className="field-hint">
                JPG, PNG ou WebP, até 5 MB, mínimo {FEATURED_MIN_WIDTH} × {FEATURED_MIN_HEIGHT} px.
                É a capa do post e o que aparece quando o link é compartilhado.
                {featured && ` · ${featured.width} × ${featured.height} px`}
              </p>
              {featured && (
                <button type="button" className="link-button" onClick={() => setFeatured(null)}>
                  Remover imagem destacada
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="site-editor">
          <Field
            label="Texto do post"
            error={errors.content}
            hint="Texto simples funciona. Se quiser: ## Subtítulo, **negrito**, *itálico*, - lista, [texto do link](https://…). Linha em branco separa parágrafos."
          >
            <textarea
              ref={textarea}
              className="control"
              rows={16}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>
          <div className="site-preview" aria-label="Prévia do post">
            <span className="field-label">Prévia</span>
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
        </div>

        <fieldset className="site-media">
          <legend className="field-label">Mídia do post</legend>

          <div>
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
                if (files.length > room) {
                  setImageProblem(
                    `Cabem mais ${room}: o máximo é ${MAX_POST_IMAGES} imagens por post.`,
                  );
                }
                void holdFiles(files.slice(0, room), (image) => {
                  setImages((current) => [
                    ...current,
                    { upload: image, caption: '', inGallery: false },
                  ]);
                  return null;
                });
              }}
            />
            <p className="field-hint">
              JPG, PNG ou WebP, até 5 MB cada, até {MAX_POST_IMAGES} por post. Use “Inserir no
              texto” para escolher onde cada uma aparece; as que ficarem sem marcador vão para o
              fim, na ordem.
            </p>
          </div>

          {hold.isPending && <p className="field-hint">Enviando imagem…</p>}
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
              return (
                <li key={image.upload.id}>
                  <img src={imageUrl(image.upload.id)} alt={`Imagem ${position}`} />
                  <div>
                    <strong>
                      Imagem {position}{' '}
                      <small className="muted">
                        {image.upload.width} × {image.upload.height} px ·{' '}
                        {placed
                          ? `no texto (${imageMarker(position)})`
                          : image.inGallery && galleryReady
                            ? 'na galeria'
                            : 'vai para o fim do texto'}
                      </small>
                    </strong>
                    <Input
                      aria-label={`Legenda da imagem ${position}`}
                      placeholder="Legenda (opcional)"
                      maxLength={IMAGE_CAPTION_MAX}
                      value={image.caption}
                      onChange={(event) =>
                        setImages(
                          images.map((item, i) =>
                            i === index ? { ...item, caption: event.target.value } : item,
                          ),
                        )
                      }
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
                          onChange={() =>
                            setImages(
                              images.map((item, i) =>
                                i === index ? { ...item, inGallery: !item.inGallery } : item,
                              ),
                            )
                          }
                        />
                        <span>Na galeria</span>
                      </label>
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`Remover imagem ${position}`}
                        onClick={() => {
                          setImages(images.filter((_, i) => i !== index));
                          setContent(withoutImageMarker(content, position));
                        }}
                      >
                        Remover
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          <div>
            <span className="field-label">Galeria</span>
            <p className="field-hint">
              Marque “Na galeria” em {MIN_GALLERY_IMAGES} ou mais imagens. No site ela aparece em{' '}
              <strong>grade</strong> — o tema não tem carrossel.{' '}
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
                (videoUrl.trim() && !video ? 'Use um link do YouTube ou do Vimeo' : undefined)
              }
              hint="Só o link: o WordPress transforma em player. Arquivo de vídeo não sobe por aqui — pesa na hospedagem."
            >
              <Input
                type="url"
                placeholder="https://www.youtube.com/watch?v=…"
                value={videoUrl}
                onChange={(event) => setVideoUrl(event.target.value)}
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
        </fieldset>

        <Alert kind="info">
          <strong>SEO (Rank Math):</strong> palavra-chave foco, título SEO e meta descrição são
          preenchidos no WordPress, ao revisar o rascunho. O site não aceita esses campos por aqui.
        </Alert>

        {findings.length > 0 && (
          <div className="alert alert-warning" role="alert">
            <strong>Atenção ao que este texto promete.</strong> No site isto não é bloqueado, mas
            quem publicar deve conferir:
            <ul>
              {findings.map((finding) => (
                <li key={`${finding.rule}:${finding.excerpt}`}>
                  <strong>{COMPLIANCE_RULE_LABEL[finding.rule]}</strong> — “{finding.excerpt}”
                </li>
              ))}
            </ul>
          </div>
        )}

        {create.isError && <Alert kind="error">{create.error.message}</Alert>}
        {create.isSuccess && (
          <Alert kind="success">
            Rascunho criado — ainda não está no ar.{' '}
            <a href={create.data.editUrl} target="_blank" rel="noreferrer">
              Abrir no WordPress para revisar e publicar
            </a>
          </Alert>
        )}

        <div className="form-actions">
          <Button type="submit" disabled={!configured || !canPublish || busy}>
            {create.isPending ? 'Enviando imagens e criando o rascunho…' : 'Criar rascunho no site'}
          </Button>
        </div>
        {!canPublish && (
          <p className="field-hint">Seu perfil não pode enviar conteúdo para o site.</p>
        )}
      </form>

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
                  {post.createdByName ?? '—'} · {formatDateTime(post.createdAt)}
                </span>
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
