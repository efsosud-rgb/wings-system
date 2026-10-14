import { useId, useRef, type ReactNode } from 'react';
import { useDialog } from './useDialog.js';
// Its look lives with the Agenda's; the deal's meetings ask with it too.
import '../../pages/agenda.css';

/**
 * A question asked inside the page (never `window.confirm`, which the browser
 * draws its own way and some block): role="alertdialog", focus on "Cancelar"
 * first so Enter never destroys by accident, Escape cancels.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancelar',
  busyLabel,
  busy = false,
  error,
  onConfirm,
  onCancel,
  returnFocus,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  /** The button that leaves without acting ("Cancelar"; "Voltar" when the action is a cancellation). */
  cancelLabel?: string;
  /** The confirm button's text while the action runs ("Excluindo…"). */
  busyLabel?: string;
  busy?: boolean;
  /** The API's refusal, shown above the buttons. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  // While the action runs the question stays open, so its answer (a refusal too) is seen.
  const cancel = () => {
    if (!busy) onCancel();
  };
  useDialog(ref, cancel, { initialFocus: cancelRef, returnFocus });

  return (
    <div
      className="crm-modal-backdrop agenda-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div
        ref={ref}
        className="crm-modal agenda-dialog agenda-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <h2 id={titleId}>{title}</h2>
        <div id={bodyId} className="agenda-confirm-body">
          {children}
        </div>
        {error && (
          <p className="agenda-error" role="alert">
            {error}
          </p>
        )}
        <div className="agenda-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            className="crm-btn"
            onClick={cancel}
            aria-disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="crm-btn agenda-btn-danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
