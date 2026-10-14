import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * What every Agenda dialog does: focus goes in on open (`initialFocus`, else
 * the first control), Tab stays inside, Escape closes, and on close focus goes
 * back to `returnFocus` (the event or button that opened it) when it is still
 * on the page.
 */
export function useDialog(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: {
    initialFocus?: RefObject<HTMLElement | null>;
    returnFocus?: HTMLElement | null;
  } = {},
): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const returnRef = useRef(options.returnFocus ?? null);
  const initialRef = options.initialFocus;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const opener = returnRef.current ?? (document.activeElement as HTMLElement | null);
    const first = initialRef?.current ?? node.querySelector<HTMLElement>(FOCUSABLE) ?? node;
    first.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const head = items[0];
      const tail = items[items.length - 1];
      if (!head || !tail) return;
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    node.addEventListener('keydown', onKey);
    return () => {
      node.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [ref, initialRef]);
}
