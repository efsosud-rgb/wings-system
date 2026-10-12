import { failureReason } from '../lib/failure.js';

/**
 * A card or list that could not load: "—" and the reason, never an empty list.
 *
 * The rule (Eric): without data, show "—" and why; an invented empty state
 * ("Nenhuma tarefa", "0 leads") is a statement about the world that nobody checked.
 */
export function LoadFailure({
  what,
  error,
  onRetry,
}: {
  /** What did not load, after "Não foi possível carregar": "as tarefas", "os leads". */
  what: string;
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <p className="load-failure" role="alert">
      <span className="load-failure-dash" aria-hidden="true">
        —
      </span>
      <span>
        Não foi possível carregar {what}: {failureReason(error)}.
      </span>
      {onRetry && (
        <button type="button" className="link-button" onClick={onRetry}>
          Tentar de novo
        </button>
      )}
    </p>
  );
}

/** A number or short value that could not load, in place of a made-up "0". */
export function Unavailable({ error }: { error: unknown }) {
  const reason = failureReason(error);
  return (
    <span className="unavailable" title={reason}>
      —<span className="unavailable-why"> {reason}</span>
    </span>
  );
}
