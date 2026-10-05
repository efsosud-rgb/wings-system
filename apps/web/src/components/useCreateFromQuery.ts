import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * `?criar=1` on a list screen opens its "create" form once and leaves the
 * address clean, so the top bar's "Criar" can land anywhere without each
 * screen inventing its own entry.
 */
export function useCreateFromQuery(open: () => void) {
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('criar') !== '1') return;
    open();
    const next = new URLSearchParams(params);
    next.delete('criar');
    setParams(next, { replace: true });
    // `open` is a fresh closure each render; the flag is what matters.
  }, [params]);
}
