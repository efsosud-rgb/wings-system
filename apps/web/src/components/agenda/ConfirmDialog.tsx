import { useId, useRef, type ReactNode } from 'react';
import { useDialog } from './useDialog.js';

/**
 * A question asked inside the page (never `window.confirm`, which the browser
 * draws its own way and some block): role="alertdialog", focus on "Cancelar"
 * first so Enter never destroys by accident, Escape cancels.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
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
  useDialog(ref, onCancel, { initialFocus: cancelRef, returnFocus });

  return (
    <div
      className="crm-modal-backdrop agenda-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
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
          <button ref={cancelRef} type="button" className="crm-btn" onClick={onCancel}>
            Cancelar
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
