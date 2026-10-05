import { useEffect } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { Icon } from './Icon.js';
import { isStaleChunkError, reloadOnceForNewBuild } from './stale-build.js';

/**
 * What a screen shows when it fails to render. A chunk from a previous build
 * (the usual case right after a deploy) reloads the page once by itself;
 * anything else shows a plain screen with one action. The technical detail
 * goes to the console only.
 */
export function RouteError() {
  const error = useRouteError();
  const stale = isStaleChunkError(error);
  useEffect(() => {
    console.error('Screen failed to render', error);
    if (stale) reloadOnceForNewBuild();
  }, [error, stale]);

  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="route-error" role="alert">
      <span className="route-error-icon">
        <Icon name={stale ? 'refresh' : 'alert'} size={22} />
      </span>
      <h1>{notFound ? 'Página não encontrada' : 'Esta tela foi atualizada'}</h1>
      <p>
        {notFound
          ? 'O endereço acessado não existe no Wings System.'
          : 'Recarregue para abrir a versão mais nova. O que você já salvou continua salvo.'}
      </p>
      <div className="route-error-actions">
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Recarregar
        </button>
        <a className="btn btn-ghost" href="/inicio">
          Ir para o Início
        </a>
      </div>
    </div>
  );
}
