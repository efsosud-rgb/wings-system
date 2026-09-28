import type { DashboardOverview } from '@wings/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { hasPermission, useSession } from '../../api/auth.js';
import { api, ApiError } from '../../api/client.js';
import { Button } from '../ui.js';
import { formatDateTime } from './format.js';

/**
 * "Dados até HH:MM" and "Atualizar agora", at the top of every tab.
 *
 * The time is when the last full ingestion finished well: campaigns, ads,
 * metrics and creatives are as of then (the job runs every hour). The button
 * is the same manual reconciliation as the builder's, one per account, with
 * the same permission (`ads.reconcile.manual`) and the server's own cooldown:
 * it refreshes spend, balance and campaign status now; metrics wait for the
 * next hourly run.
 */
export function DashboardRefresh({ overview }: { overview: DashboardOverview }) {
  const { data: user } = useSession();
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: async () => {
      const problems: string[] = [];
      // One at a time: each is a read against the platform, and the cooldown is per account.
      for (const account of overview.accounts) {
        try {
          await api.post(`/ads/accounts/${account.id}/reconcile-now`);
        } catch (error) {
          const reason =
            error instanceof ApiError &&
            error.code === 'reconcile_cooldown' &&
            error.retryAfterSeconds
              ? `aguarde ${error.retryAfterSeconds}s`
              : error instanceof Error
                ? error.message
                : 'não respondeu';
          problems.push(`${account.name}: ${reason}`);
        }
      }
      return problems;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });

  const until = overview.ingestion.dataUntil;
  return (
    <div className="dash-freshness">
      <span className="dash-freshness-time">
        {until ? `Dados até ${formatDateTime(until)}` : 'Nenhuma coleta completa registrada'}
        <span className="cell-sub">
          coleta completa de hora em hora; gasto e status a cada 15 min
        </span>
      </span>
      {hasPermission(user, 'ads.reconcile.manual') && overview.accounts.length > 0 && (
        <>
          <Button
            type="button"
            variant="ghost"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            {refresh.isPending ? 'Atualizando…' : 'Atualizar agora'}
          </Button>
          {refresh.data && refresh.data.length > 0 && (
            <p className="field-hint" role="alert">
              {refresh.data.join(' · ')}
            </p>
          )}
          {refresh.data && refresh.data.length === 0 && (
            <p className="field-hint" role="status">
              Gasto e status atualizados. As métricas chegam na próxima coleta de hora em hora.
            </p>
          )}
        </>
      )}
    </div>
  );
}
