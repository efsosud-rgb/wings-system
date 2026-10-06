import {
  CALL_TO_ACTION_LABEL,
  LEAD_FORM_CONSENT_PREVIEW,
  LEAD_FORM_QUESTIONS,
  leadFormQuestionsInOrder,
  type CallToAction,
  type SiteFormSpec,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { creativeUrl, videoUrl } from './AdPreview.js';

/**
 * How the ad looks with Wings' standard form, drawn by us.
 *
 * NOT Meta's preview and not the site itself: a drawing to see, before any
 * form exists, the ad in Instagram's Feed, Stories and Reels with the instant
 * form rising over it, the form's screens, and the site page `/lp/<slug>`
 * with the same questions. Every answer shown is made up. Meta's official
 * preview exists only after the ads are created, on the approval screen, and
 * it shows the ad, never the form's screens.
 */

export type LeadPreviewPlacement = 'feed' | 'stories' | 'reels';

const PLACEMENT_LABEL: Record<LeadPreviewPlacement, string> = {
  feed: 'Instagram Feed',
  stories: 'Instagram Stories',
  reels: 'Instagram Reels',
};

/** The form as the preview needs it: the site spec plus, on Meta, the button. */
export interface LeadPreviewForm extends SiteFormSpec {
  brand?: string;
}

export interface LeadPreviewMedia {
  mediaType: 'image' | 'video';
  creativeId?: string | null;
  videoId?: string | null;
  headline: string;
  primaryText: string;
  callToAction: CallToAction;
}

/** The sheet's stages, in the order a person goes through them. */
type Stage = 'ad' | 'intro' | 'questions' | 'review' | 'thanks';
const STAGES: Stage[] = ['ad', 'intro', 'questions', 'review', 'thanks'];
const STAGE_LABEL: Record<Stage, string> = {
  ad: 'Anúncio',
  intro: 'Formulário abre',
  questions: 'Perguntas',
  review: 'Revisão e envio',
  thanks: 'Agradecimento',
};
/** How long each stage stays on screen while the preview plays itself. */
const STAGE_MS: Record<Stage, number> = {
  ad: 1600,
  intro: 1800,
  questions: 2600,
  review: 2200,
  thanks: 2600,
};

function Media({ media, label }: { media: LeadPreviewMedia; label: string }) {
  if (media.mediaType === 'video') {
    return media.videoId ? (
      <video muted loop autoPlay playsInline preload="metadata" src={videoUrl(media.videoId)} />
    ) : (
      <span className="lead-preview-placeholder">Sem vídeo</span>
    );
  }
  return media.creativeId ? (
    <img src={creativeUrl(media.creativeId)} alt={`Criativo — ${label}`} />
  ) : (
    <span className="lead-preview-placeholder">Sem criativo</span>
  );
}

/** The instant form's screens, one at a time, inside the sheet. */
function FormScreens({
  form,
  stage,
  brand,
}: {
  form: LeadPreviewForm;
  stage: Exclude<Stage, 'ad'>;
  brand: string;
}) {
  const questions = leadFormQuestionsInOrder(form);
  if (stage === 'intro') {
    return (
      <div className="lead-sheet-screen">
        <p className="lead-sheet-kicker">{brand}</p>
        <h4>Envie suas informações de contato para se conectar a esta empresa</h4>
        <p className="muted">
          {questions.length} perguntas · leva menos de um minuto. Seus dados já preenchidos podem
          ser editados.
        </p>
        <span className="lead-sheet-button">Continuar</span>
      </div>
    );
  }
  if (stage === 'questions') {
    return (
      <div className="lead-sheet-screen">
        <p className="lead-sheet-kicker">{brand}</p>
        {questions.map((question, index) => (
          <div className="lead-sheet-field" key={index}>
            <span className="lead-sheet-label">{question.label}</span>
            {question.kind === 'qualifier' ? (
              <div className="lead-sheet-options" role="list">
                {question.options?.map((option, optionIndex) => (
                  <span
                    role="listitem"
                    key={option}
                    className={`lead-sheet-option ${optionIndex === 1 ? 'is-picked' : ''}`}
                  >
                    {option}
                  </span>
                ))}
              </div>
            ) : (
              <span className="lead-sheet-input">{question.sample}</span>
            )}
          </div>
        ))}
        <span className="lead-sheet-button">Continuar</span>
      </div>
    );
  }
  if (stage === 'review') {
    return (
      <div className="lead-sheet-screen">
        <p className="lead-sheet-kicker">{brand}</p>
        <h4>Confira antes de enviar</h4>
        <dl className="lead-sheet-review">
          {LEAD_FORM_QUESTIONS.map((question) => (
            <div key={question.field}>
              <dt>{question.label}</dt>
              <dd>{question.sample}</dd>
            </div>
          ))}
        </dl>
        <p className="lead-sheet-consent">
          {LEAD_FORM_CONSENT_PREVIEW}{' '}
          <span className="lead-sheet-link">{hostOf(form.privacyPolicyUrl)}</span>
        </p>
        <span className="lead-sheet-button">Enviar</span>
      </div>
    );
  }
  return (
    <div className="lead-sheet-screen">
      <p className="lead-sheet-kicker">{brand}</p>
      <h4>{form.thankYou.title}</h4>
      <p>{form.thankYou.body}</p>
      <span className="lead-sheet-button">{form.thankYou.buttonText}</span>
      <small className="muted">{hostOf(form.thankYou.buttonUrl)}</small>
    </div>
  );
}

function hostOf(url: string): string {
  return /^https?:\/\/([^/?#]+)/i.exec(url)?.[1]?.replace(/^www\./, '') ?? 'wingscompany.com.br';
}

/**
 * One placement with the sheet rising over the ad. The rise is a CSS
 * transform the stage toggles: light, and interruptible by a tap on a stage.
 */
function MetaLeadPreview({
  placement,
  media,
  form,
  brand,
  stage,
  onStage,
}: {
  placement: LeadPreviewPlacement;
  media: LeadPreviewMedia;
  form: LeadPreviewForm;
  brand: string;
  stage: Stage;
  onStage: (stage: Stage) => void;
}) {
  const vertical = placement !== 'feed';
  const open = stage !== 'ad';
  return (
    <figure className={`lead-preview lead-preview-${placement}`}>
      <figcaption className="field-label">{PLACEMENT_LABEL[placement]}</figcaption>
      <div className={`lead-preview-phone ${vertical ? 'is-vertical' : ''}`}>
        <div className="lead-preview-top">
          <span className="ad-preview-avatar" aria-hidden="true">
            W
          </span>
          <span>
            <strong>{brand}</strong>
            <small>Patrocinado</small>
          </span>
        </div>
        <div className="lead-preview-media">
          <Media media={media} label={PLACEMENT_LABEL[placement]} />
          {vertical && (
            <div className="lead-preview-overlay">
              <p>{media.primaryText || 'Texto do anúncio'}</p>
            </div>
          )}
          <button
            type="button"
            className="lead-preview-cta"
            onClick={() => onStage(open ? 'ad' : 'intro')}
            aria-expanded={open}
          >
            {CALL_TO_ACTION_LABEL[media.callToAction]}
          </button>
          <div className={`lead-sheet ${open ? 'is-open' : ''}`} aria-hidden={!open}>
            <span className="lead-sheet-handle" aria-hidden="true" />
            {open && <FormScreens form={form} stage={stage} brand={brand} />}
          </div>
        </div>
        {!vertical && (
          <div className="lead-preview-bottom">
            <p>
              <strong>{brand.toLowerCase().replace(/\s+/g, '')}</strong>{' '}
              {media.primaryText || 'Texto do anúncio'}
            </p>
            <small>{media.headline || 'Título do anúncio'}</small>
          </div>
        )}
      </div>
    </figure>
  );
}

/** The site page `/lp/<slug>` with the same form, as a visitor sees it. */
export function SiteFormPreview({
  form,
  brand,
  path,
  stage = 'form',
}: {
  form: SiteFormSpec;
  brand: string;
  path: string;
  stage?: 'form' | 'thanks';
}) {
  const questions = leadFormQuestionsInOrder(form);
  return (
    <figure className="lead-preview lead-preview-site">
      <figcaption className="field-label">{`Página do site · ${path}`}</figcaption>
      <div className="lead-site-frame">
        <div className="lead-site-bar">
          <span />
          <span />
          <span />
          <em>wingssystem.online{path}</em>
        </div>
        <div className="lead-site-page">
          <h3>Seja um franqueado {brand}</h3>
          <p className="muted">Deixe seus dados e o time de expansão entra em contato.</p>
          {stage === 'thanks' ? (
            <div className="lead-site-thanks">
              <strong>{form.thankYou.title}</strong>
              <p>{form.thankYou.body}</p>
              <span className="lead-sheet-button">{form.thankYou.buttonText}</span>
            </div>
          ) : (
            <div className="lead-site-form">
              {questions.map((question, index) => (
                <label className="lead-site-field" key={index}>
                  <span>{question.label}</span>
                  {question.kind === 'qualifier' ? (
                    <div className="lead-sheet-options">
                      {question.options?.map((option, optionIndex) => (
                        <span
                          key={option}
                          className={`lead-sheet-option ${optionIndex === 1 ? 'is-picked' : ''}`}
                        >
                          {option}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="lead-site-input">{question.sample}</span>
                  )}
                </label>
              ))}
              <label className="lead-site-field">
                <span>E-mail</span>
                <span className="lead-site-input">ana@exemplo.com.br</span>
              </label>
              <p className="lead-sheet-consent">
                Autorizo o contato da Wings pelos dados informados.{' '}
                <span className="lead-sheet-link">{hostOf(form.privacyPolicyUrl)}</span>
              </p>
              <span className="lead-sheet-button">Enviar</span>
            </div>
          )}
        </div>
      </div>
    </figure>
  );
}

/**
 * The gallery: the three Instagram placements side by side, one stage at a
 * time, playing themselves until a stage is tapped. Reels and Stories are the
 * same drawing in a different frame, which is also true of the real thing.
 */
export function LeadFormPreviewGallery({
  media,
  form,
  brand,
  placements = ['feed', 'stories', 'reels'],
}: {
  media: LeadPreviewMedia;
  form: LeadPreviewForm;
  brand: string;
  placements?: LeadPreviewPlacement[];
}) {
  const [stage, setStage] = useState<Stage>('ad');
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      const next = STAGES[(STAGES.indexOf(stage) + 1) % STAGES.length] ?? 'ad';
      setStage(next);
    }, STAGE_MS[stage]);
    return () => window.clearTimeout(timer);
  }, [playing, stage]);

  const pick = (next: Stage) => {
    setPlaying(false);
    setStage(next);
  };

  return (
    <div className="lead-preview-gallery">
      <div className="lead-preview-stages" role="group" aria-label="Etapa da prévia">
        {STAGES.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={stage === item}
            className={`ad-preview-switch-option ${stage === item ? 'is-active' : ''}`}
            onClick={() => pick(item)}
          >
            {STAGE_LABEL[item]}
          </button>
        ))}
        <button
          type="button"
          className="ad-preview-switch-option"
          onClick={() => setPlaying((value) => !value)}
          aria-pressed={playing}
        >
          {playing ? 'Pausar' : 'Reproduzir'}
        </button>
      </div>
      <div className="lead-preview-row">
        {placements.map((placement) => (
          <MetaLeadPreview
            key={placement}
            placement={placement}
            media={media}
            form={form}
            brand={brand}
            stage={stage}
            onStage={pick}
          />
        ))}
      </div>
      <p className="field-hint">
        <strong>Desenho do Wings System</strong>, com dados fictícios, para conferir as perguntas, a
        política e o agradecimento sobre o anúncio. Não é a prévia oficial da Meta: essa só existe
        depois que os anúncios forem criados, na tela da aprovação, e mostra o anúncio, nunca as
        telas do formulário.
      </p>
    </div>
  );
}
