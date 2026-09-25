import { hasPermission, useSession } from '../../api/auth.js';
import { useReconcileNow } from '../../api/ads.js';
import { ApiError } from '../../api/client.js';
import { Button } from '../ui.js';

/**
 * "Atualizar agora" — a manual reconciliation, next to any figure sourced
 * from the platform. Only for `ads.reconcile.manual` (Admin Master,
 * Diretoria); invisible to anyone else, since the API would refuse it anyway.
 *
 * The trava against repeated clicks is the server's, not this component's:
 * a click while one is already in flight or inside the cooldown comes back
 * as a refusal, shown in place rather than silently retried.
 */
export function ReconcileNowButton({ accountId }: { accountId: string | undefined }) {
  const { data: user } = useSession();
  const reconcile = useReconcileNow(accountId);

  if (!hasPermission(user, 'ads.reconcile.manual')) return null;

  const failure = reconcile.error instanceof ApiError ? reconcile.error : null;

  return (
    <div className="builder-ceiling-refresh">
      <Button
        type="button"
        variant="ghost"
        disabled={!accountId || reconcile.isPending}
        onClick={() => reconcile.mutate()}
      >
        {reconcile.isPending ? 'Atualizando…' : 'Atualizar agora'}
      </Button>
      {failure && (
        <p className="field-hint" role="alert">
          {failure.code === 'reconcile_cooldown' && failure.retryAfterSeconds
            ? `Aguarde ${failure.retryAfterSeconds}s e tente de novo.`
            : failure.message}
        </p>
      )}
    </div>
  );
}
