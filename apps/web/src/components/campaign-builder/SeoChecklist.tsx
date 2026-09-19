import { checkPostSeo, type SeoChecklistInput } from '@wings/shared';

/**
 * The checklist beside the post form.
 *
 * Every item comes from `checkPostSeo`, which is plain string comparison: no
 * model, no network, the same answer for the same text. It updates as the
 * person types and it never stops a draft from being sent.
 *
 * State is never carried by colour alone: each item has an icon and a spoken
 * "Feito" or "Falta". Only the running total is a live region, so a screen
 * reader hears "6 de 10" once instead of ten items talking over each other.
 */

function Icon({ ok }: { ok: boolean }) {
  return (
    <svg
      className="seo-check-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      {ok ? (
        <path
          d="M4.6 8.3l2.2 2.2 4.6-4.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export function SeoChecklist({ input }: { input: SeoChecklistInput }) {
  const checks = checkPostSeo(input);
  const done = checks.filter((check) => check.ok).length;

  return (
    <aside className="seo-checklist" aria-labelledby="seo-checklist-title">
      <h3 id="seo-checklist-title">Checklist SEO</h3>
      <p className="seo-checklist-total" role="status" aria-atomic="true">
        {done} de {checks.length} itens prontos
      </p>
      <div
        className="seo-checklist-bar"
        role="img"
        aria-label={`${done} de ${checks.length} itens prontos`}
      >
        <span style={{ width: `${(done / checks.length) * 100}%` }} />
      </div>
      <ul>
        {checks.map((check) => (
          <li key={check.id} className={check.ok ? 'seo-check-ok' : 'seo-check-missing'}>
            <Icon ok={check.ok} />
            <div>
              <span className="seo-check-label">
                <span className="sr-only">{check.ok ? 'Feito: ' : 'Falta: '}</span>
                {check.label}
              </span>
              <span className="seo-check-detail">{check.detail}</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="field-hint">
        Serve de orientação. Você pode criar o rascunho com itens em vermelho e acertar o resto no
        WordPress.
      </p>
    </aside>
  );
}
