import { useEffect, useRef } from 'react';
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
  session: Pick<StudioSession, 'status' | 'clearSelection' | 'undo' | 'redo'>,
  handlers: { onSave: () => void },
): void {
  const { status, clearSelection, undo, redo } = session;
  const { onSave } = handlers;
  // The session hands out new functions on every render: the listener reads the latest.
  const history = useRef({ undo, redo });
  history.current = { undo, redo };

  // The core's Ctrl+Z ignores every text field, so with the focus left in one
  // (a property, the library search) it did nothing at all, and a picture
  // swapped by "Substituir" could not be taken back (staging, 2026-09-24). A
  // field nobody typed in since it got the focus has nothing of its own to
  // undo: there, Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) go to the editor. A field
  // with typing in it keeps the browser's own undo of that text.
  useEffect(() => {
    if (status !== 'ready') return;
    const atFocus = new WeakMap<EventTarget, string>();
    const valueOf = (target: EventTarget) =>
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? target.value
        : target instanceof HTMLElement
          ? (target.textContent ?? '')
          : '';
    const onFocus = (event: FocusEvent) => {
      if (event.target && isTypingTarget(event.target))
        atFocus.set(event.target, valueOf(event.target));
    };
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const target = event.target;
      if (!target || !isTypingTarget(target)) return;
      if (target instanceof HTMLElement && target.closest('[role="dialog"]')) return;
      if (atFocus.has(target) && atFocus.get(target) !== valueOf(target)) return;
      event.preventDefault();
      void (key === 'y' || event.shiftKey ? history.current.redo() : history.current.undo());
    };
    document.addEventListener('focusin', onFocus);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('focusin', onFocus);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [status]);

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
