import { useEffect } from 'react';
import type { StudioSession } from './session.js';

/**
 * The workspace's own keys, on top of the core's (space, arrows, Ctrl+Z,
 * Delete live in packages/studio's Controls): `S` saves, `Escape` drops the
 * selection. Nothing fires while somebody is typing in a field or while a
 * dialog is open, so a name being typed never saves half-way.
 */

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (EDITABLE.has(target.tagName) || target.isContentEditable) return true;
  return target.closest('[contenteditable="true"]') !== null;
}

export function useStudioShortcuts(
  session: Pick<StudioSession, 'status' | 'clearSelection'>,
  handlers: { onSave: () => void },
): void {
  const { status, clearSelection } = session;
  const { onSave } = handlers;
  useEffect(() => {
    if (status !== 'ready') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key === 'Escape') {
        clearSelection();
        return;
      }
      if (
        (event.key === 's' || event.key === 'S') &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        onSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, clearSelection, onSave]);
}
