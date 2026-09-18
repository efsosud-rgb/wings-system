import { zodResolver } from '@hookform/resolvers/zod';
import {
  COMPLIANCE_RULE_LABEL,
  SITE_POST_EXCERPT_MAX,
  SITE_POST_OUTCOME_LABEL,
  SITE_POST_TITLE_MAX,
  checkCopyCompliance,
  sitePostSchema,
  type SitePostInput,
} from '@wings/shared';
import { useForm } from 'react-hook-form';
import { useCreateSiteDraft, useSitePosts, useSiteStatus } from '../../api/ads.js';
import { Alert, Button, Field, Input } from '../ui.js';

/**
 * The owned-channels tab: places Wings publishes to without buying media.
 *
 * Deliberately not the paid-media form with fields hidden — the two share
 * nothing: there is no budget, no objective and no approvals gate here. The
 * only real channel is Wings' WordPress site, and all the studio can do there
 * is leave a draft for a person to publish.
 */

const SOON = [
  { name: 'Portal ClickFranquia', description: 'Vitrine de franquias.' },
  { name: 'App ClickFranquia', description: 'Notificações e destaques no aplicativo.' },
] as const;

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function WordPressChannel({ canPublish }: { canPublish: boolean }) {
  const status = useSiteStatus();
  const posts = useSitePosts();
  const create = useCreateSiteDraft();
  const configured = status.data?.status.configured ?? false;

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<SitePostInput>({
    resolver: zodResolver(sitePostSchema),
    defaultValues: { title: '', excerpt: '', content: '' },
  });
  const values = watch();
  // A warning, not a block: on our own site figures can be legitimate (the COF
  // numbers, for one), but whoever writes them should see the same flags.
  const findings = checkCopyCompliance(`${values.title}\n${values.excerpt}\n${values.content}`);

  return (
    <section className="builder-section" aria-labelledby="owned-wordpress">
      <h2 id="owned-wordpress">
        Site da Wings (WordPress)
        {status.data?.status.siteHost && (
          <span className="tag coming-soon-tag">{status.data.status.siteHost}</span>
        )}
      </h2>
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
        onSubmit={(event) => {
          create.reset();
          void handleSubmit((post) => create.mutate(post, { onSuccess: () => reset() }))(event);
        }}
      >
        <Field
          label="Título"
          error={errors.title?.message}
          hint={`${values.title.length}/${SITE_POST_TITLE_MAX}`}
        >
          <Input maxLength={SITE_POST_TITLE_MAX} {...register('title')} />
        </Field>
        <Field
          label="Resumo"
          error={errors.excerpt?.message}
          hint={`Opcional · aparece nas listagens do blog · ${values.excerpt.length}/${SITE_POST_EXCERPT_MAX}`}
        >
          <textarea
            className="control"
            rows={2}
            maxLength={SITE_POST_EXCERPT_MAX}
            {...register('excerpt')}
          />
        </Field>
        <Field
          label="Texto do post"
          error={errors.content?.message}
          hint="Texto simples. Uma linha em branco separa parágrafos; formatação e imagens entram no WordPress."
        >
          <textarea className="control" rows={10} {...register('content')} />
        </Field>

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
          <Button type="submit" disabled={!configured || !canPublish || create.isPending}>
            {create.isPending ? 'Enviando…' : 'Criar rascunho no site'}
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
                  {post.editUrl ? (
                    <a href={post.editUrl} target="_blank" rel="noreferrer">
                      {post.title}
                    </a>
                  ) : (
                    post.title
                  )}
                </span>
                <span className="cell-sub">
                  {SITE_POST_OUTCOME_LABEL[post.outcome]} · {post.createdByName ?? '—'} ·{' '}
                  {formatDateTime(post.createdAt)}
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
