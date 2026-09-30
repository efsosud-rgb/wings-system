import {
  AD_PLATFORM_LABEL,
  type CockpitCampaignOption,
  type CockpitCampaignScope,
} from '@wings/shared';
import { useEffect, useId, useRef, useState } from 'react';

/**
 * Multi-choice campaign picker for the Cockpit. Nothing picked means the whole
 * scope ("Todas as ativas", or "Todas" when that mode is on). The pick is the
 * address's `?campanha=id1,id2`, owned by the page; this only reports changes.
 */
export function CampaignPicker({
  options,
  selected,
  scope,
  onChange,
}: {
  options: CockpitCampaignOption[];
  selected: string[];
  scope: CockpitCampaignScope;
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const everything = scope === 'todas' ? 'Todas' : 'Todas as ativas';

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false);
      } else if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const known = new Set(options.map((option) => option.id));
  const picked = selected.filter((id) => known.has(id));
  const summary =
    picked.length === 0
      ? everything
      : picked.length === 1
        ? (options.find((option) => option.id === picked[0])?.name ?? everything)
        : `${picked.length} campanhas`;

  const toggle = (id: string) =>
    onChange(picked.includes(id) ? picked.filter((item) => item !== id) : [...picked, id]);

  return (
    <div className="campaign-picker" ref={root}>
      <span className="window-picker-label">Campanha:</span>
      <button
        type="button"
        className="btn btn-ghost campaign-picker-button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {summary} ▾
      </button>
      {open && (
        <div
          className="campaign-picker-panel"
          id={panelId}
          role="group"
          aria-label="Escolher campanhas"
        >
          <label className="campaign-picker-option">
            <input type="checkbox" checked={picked.length === 0} onChange={() => onChange([])} />
            <span>{everything}</span>
          </label>
          {options.length === 0 && <p className="muted">Nenhuma campanha neste modo.</p>}
          {options.map((option) => (
            <label key={option.id} className="campaign-picker-option">
              <input
                type="checkbox"
                checked={picked.includes(option.id)}
                onChange={() => toggle(option.id)}
              />
              <span>
                {option.name}{' '}
                <span className="muted">
                  ({AD_PLATFORM_LABEL[option.platform]}
                  {option.delivering ? '' : ', parada'})
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
