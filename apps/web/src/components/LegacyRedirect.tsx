import { Navigate, useLocation } from 'react-router-dom';

/**
 * Sends an old address to its new one, preserving whatever came after it.
 *
 * `/trafego-pago/aprovacoes/<id>` has to land on the same approval under the
 * new path, not on the list — that id is what the WhatsApp message points at,
 * and those messages cannot be edited after they are sent.
 */
export function LegacyRedirect({ from, to }: { from: string; to: string }) {
  const { pathname, search } = useLocation();
  const rest = pathname.startsWith(from) ? pathname.slice(from.length) : '';
  return <Navigate to={`${to}${rest}${search}`} replace />;
}
