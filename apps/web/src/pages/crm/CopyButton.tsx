import { useState } from 'react';

/** A small "Copiar" that says "Copiado" for a moment. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="crm-btn is-small is-quiet crm-copy"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined); // the browser refused: the value stays on the screen to select
      }}
    >
      {copied ? 'Copiado' : 'Copiar'}
    </button>
  );
}
