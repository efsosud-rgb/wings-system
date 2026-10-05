import { ALL_SUBMODULES, NAVIGATION } from '@wings/shared';
import { useLocation } from 'react-router-dom';
import { Icon } from '../components/Icon.js';
import { PageHeader } from '../components/PageHeader.js';

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
  const module = NAVIGATION.find((entry) => entry.key === submodule?.moduleKey);

  return (
    <>
      <PageHeader
        title={submodule?.label ?? 'Em breve'}
        subtitle={submodule?.moduleLabel ?? 'Wings System'}
      />

      <section className="card coming-soon">
        <span className="coming-soon-icon">
          <Icon name={submodule?.icon ?? module?.icon ?? 'sparkles'} size={22} />
        </span>
        <span className="status coming-soon-tag">Em breve</span>
        <h2>Esta tela ainda não foi construída</h2>
        {submodule?.description && <p className="muted">{submodule.description}</p>}
        <p className="field-hint">
          Ela já aparece no menu para que a estrutura do sistema fique visível por inteiro. Passa a
          funcionar quando o módulo for implementado.
        </p>
      </section>
    </>
  );
}
