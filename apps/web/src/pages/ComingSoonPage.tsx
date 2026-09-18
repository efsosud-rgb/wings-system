import { ALL_SUBMODULES } from '@wings/shared';
import { useLocation } from 'react-router-dom';

/**
 * The screen behind a sub-module that has no backend yet.
 *
 * It exists so the menu can be complete without any entry leading to a blank
 * page that looks broken: the person sees where they are, what will live there
 * and that it is not ready — rather than wondering whether it failed to load.
 */
export function ComingSoonPage() {
  const { pathname } = useLocation();
  const submodule = ALL_SUBMODULES.find((entry) => pathname.startsWith(entry.path));

  return (
    <>
      <header className="page-header">
        <h1>{submodule?.label ?? 'Em breve'}</h1>
        <p>{submodule?.moduleLabel ?? 'Wings System'}</p>
      </header>

      <section className="card coming-soon">
        <span className="status coming-soon-tag">Em breve</span>
        <h2>Este módulo ainda não foi construído</h2>
        {submodule?.description && <p className="muted">{submodule.description}</p>}
        <p className="field-hint">
          A navegação já está no lugar para que a estrutura do sistema seja visível por inteiro.
          Esta tela passa a funcionar quando o módulo for implementado — nada aqui está quebrado.
        </p>
      </section>
    </>
  );
}
