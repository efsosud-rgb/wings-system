import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';

/**
 * A company's name, linked to its record in Empresas when the person may open that screen. The
 * sellers have no Empresas (Eric, 14/10): for them it is the name alone, never a link to "Sem acesso".
 */
export function CompanyLink({ id, children }: { id: string; children: ReactNode }) {
  const session = useSession();
  if (!hasPermission(session.data, 'companies.read')) return <>{children}</>;
  return <Link to={`/crm-vendas/empresas/${id}`}>{children}</Link>;
}
