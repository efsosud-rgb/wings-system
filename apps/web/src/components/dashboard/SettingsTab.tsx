import {
  OBJECTIVE_KIND_LABEL,
  TARGET_METRIC_LABEL,
  VERDICT_RULES,
  AD_PLATFORM_LABEL,
  VERDICT_SIGNAL_LABEL,
  type AccountCplTarget,
  type CplTarget,
} from '@wings/shared';
import { useState } from 'react';
import { hasPermission, useSession } from '../../api/auth.js';
import {
  useDashboardSettings,
  useSetAccountCplTarget,
  useSetCplTarget,
} from '../../api/dashboard.js';
import { formatBrl, parseBrlToCents } from '../campaign-builder/format.js';
import { LoadFailure } from '../LoadFailure.js';
import { Button, Field, Input } from '../ui.js';
import { formatDateTime, formatInt, formatMoney } from './format.js';

/**
 * Configurações do Dashboard: the CPL and CPC targets the verdicts judge
 * against. The system proposes a figure from the last 90 days and says how it
 * got there; only a person's confirmation makes it the target.
 */

const pct = (ratio: number) => `${Math.round(Math.abs(ratio) * 100)}%`;

function TargetCard({ target, canConfirm }: { target: CplTarget; canConfirm: boolean }) {
  const set = useSetCplTarget();
  const kind = target.objectiveKind as 'leads' | 'traffic';
  const [text, setText] = useState(
    target.targetCents === null ? '' : (target.targetCents / 100).toFixed(2).replace('.', ','),
  );
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    const cents = parseBrlToCents(text);
    if (!Number.isFinite(cents) || cents < 100) {
      setError('Informe um valor em reais, como 45,00.');
      return;
    }
    setError(null);
    set.mutate({ objectiveKind: kind, targetCents: cents });
  };

  return (
    <section className="target" aria-labelledby={`target-${kind}`}>
      <h3 id={`target-${kind}`}>
        {OBJECTIVE_KIND_LABEL[target.objectiveKind]}
        <span className="cell-sub">Meta de {TARGET_METRIC_LABEL[kind]}</span>
      </h3>
      <p className="target-current">
        {target.targetCents === null ? (
          <span className="muted">
            Sem meta confirmada: as campanhas deste objetivo ficam "Sem meta".
          </span>
        ) : (
          <>
            <b className="mono">{formatBrl(target.targetCents)}</b>
            <span className="cell-sub">
              confirmada{target.confirmedByName ? ` por ${target.confirmedByName}` : ''} em{' '}
              {formatDateTime(target.confirmedAt)}
            </span>
          </>
        )}
      </p>
      <div className="target-proposal">
        <span className="agent-card-label">Proposta a partir do histórico</span>
        {target.proposedCents === null ? (
          <p className="muted">
            Histórico curto demais para propor um valor: ainda faltam leads ou cliques nos últimos
            90 dias.
          </p>
        ) : (
          <>
            <p>
              <b className="mono">{formatBrl(target.proposedCents)}</b>
              <span className="cell-sub">{target.proposedBasis}</span>
            </p>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setText((target.proposedCents! / 100).toFixed(2).replace('.', ','))}
            >
              Usar proposta
            </Button>
          </>
        )}
      </div>
      <div className="target-form">
        <Field label="Meta em reais" error={error ?? undefined} errorId={`target-${kind}-error`}>
          <Input
            inputMode="decimal"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            aria-describedby={error ? `target-${kind}-error` : undefined}
            placeholder="45,00"
            disabled={!canConfirm}
          />
        </Field>
        {canConfirm ? (
          <div className="target-actions">
            <Button type="button" disabled={set.isPending} onClick={confirm}>
              {set.isPending ? 'Confirmando…' : 'Confirmar meta'}
            </Button>
            {target.targetCents !== null && (
              <Button
                type="button"
                variant="ghost"
                disabled={set.isPending}
                onClick={() => {
                  setText('');
                  set.mutate({ objectiveKind: kind, targetCents: null });
                }}
              >
                Remover meta
              </Button>
            )}
          </div>
        ) : (
          <p className="field-hint">Só quem pode pedir alterações de tráfego confirma uma meta.</p>
        )}
        {set.isError && (
          <p className="field-error" role="alert">
            {set.error instanceof Error ? set.error.message : 'Não foi possível salvar a meta.'}
          </p>
        )}
      </div>
    </section>
  );
}

const centsText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

/**
 * One account's leads CPL target. It wins over the company-wide one. The
 * suggestion only fills the box; the target exists after "Confirmar".
 */
function AccountTargetRow({
  target,
  canConfirm,
}: {
  target: AccountCplTarget;
  canConfirm: boolean;
}) {
  const set = useSetAccountCplTarget();
  const initial = target.targetCents ?? target.suggestedCents;
  const [text, setText] = useState(initial === null ? '' : centsText(initial));
  const [error, setError] = useState<string | null>(null);
  const inputId = `account-target-${target.adAccountId}`;

  const confirm = () => {
    const cents = parseBrlToCents(text);
    if (!Number.isFinite(cents) || cents < 100) {
      setError('Informe um valor em reais, como 85,90.');
      return;
    }
    setError(null);
    set.mutate({ adAccountId: target.adAccountId, targetCents: cents });
  };

  return (
    <tr>
      <td>
        {target.accountName}
        <span className="cell-sub">{AD_PLATFORM_LABEL[target.platform]}</span>
      </td>
      <td>
        {target.targetCents === null ? (
          <span className="muted">Sem meta da conta</span>
        ) : (
          <>
            <b className="mono">{formatBrl(target.targetCents)}</b>
            <span className="cell-sub">
              confirmada{target.confirmedByName ? ` por ${target.confirmedByName}` : ''} em{' '}
              {formatDateTime(target.confirmedAt)}
            </span>
          </>
        )}
        {target.targetCents === null && target.suggestionNote && (
          <span className="cell-sub">{target.suggestionNote}</span>
        )}
      </td>
      <td>
        <Field label="Meta de CPL em reais" error={error ?? undefined} errorId={`${inputId}-error`}>
          <Input
            id={inputId}
            inputMode="decimal"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            aria-describedby={error ? `${inputId}-error` : undefined}
            placeholder="85,90"
            disabled={!canConfirm}
          />
        </Field>
      </td>
      <td>
        {canConfirm && (
          <div className="target-actions">
            <Button type="button" disabled={set.isPending} onClick={confirm}>
              {set.isPending ? 'Confirmando…' : 'Confirmar'}
            </Button>
            {target.targetCents !== null && (
              <Button
                type="button"
                variant="ghost"
                disabled={set.isPending}
                onClick={() => {
                  setText('');
                  set.mutate({ adAccountId: target.adAccountId, targetCents: null });
                }}
              >
                Remover
              </Button>
            )}
          </div>
        )}
        {set.isError && (
          <p className="field-error" role="alert">
            {set.error instanceof Error ? set.error.message : 'Não foi possível salvar a meta.'}
          </p>
        )}
      </td>
    </tr>
  );
}

export function SettingsTab() {
  const { data: user } = useSession();
  const canConfirm = hasPermission(user, 'ads.request');
  const settings = useDashboardSettings();

  // The target forms stay out of reach until the settings loaded: a blank form must never
  // look like "no target set" and invite a save over a real one.
  if (settings.isError && !settings.data) {
    return (
      <LoadFailure
        what="as configurações"
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  }
  if (!settings.data) return <p className="muted">Carregando…</p>;

  return (
    <>
      {settings.isError && (
        <LoadFailure
          what="as configurações"
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      )}
      <section className="dash-section" aria-labelledby="targets-title">
        <h2 id="targets-title">Metas por objetivo</h2>
        <div className="targets">
          {settings.data.targets.map((target) => (
            <TargetCard key={target.objectiveKind} target={target} canConfirm={canConfirm} />
          ))}
        </div>
      </section>

      <section className="dash-section" aria-labelledby="account-targets-title">
        <h2 id="account-targets-title">Meta de CPL por conta</h2>
        <p className="muted">
          Vale para as campanhas de leads da conta e passa na frente da meta por objetivo acima. Sem
          meta da conta, vale a meta por objetivo; sem nenhuma, a campanha fica "Sem meta".
        </p>
        {settings.data.accountTargets.length === 0 ? (
          <p className="muted">Nenhuma conta de anúncios ativa.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Conta</th>
                  <th scope="col">Meta atual</th>
                  <th scope="col">Nova meta</th>
                  <th scope="col">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {settings.data.accountTargets.map((target) => (
                  <AccountTargetRow
                    key={target.adAccountId}
                    target={target}
                    canConfirm={canConfirm}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!canConfirm && (
          <p className="field-hint">Só quem pode pedir alterações de tráfego confirma uma meta.</p>
        )}
      </section>

      <section className="dash-section verdict-legend" aria-labelledby="legend-title">
        <h2 id="legend-title">Como o veredito é calculado</h2>
        <p className="muted">
          Uma campanha só é julgada com ao menos {formatMoney(VERDICT_RULES.minSpendCents)} gastos e{' '}
          {formatInt(VERDICT_RULES.minImpressions)} impressões no período. O sinal principal decide
          primeiro: CPL para campanhas de leads, CTR para as demais. Um sinal principal ruim, ou
          dois sinais ruins, dão Negativa; um sinal ruim ou dois em atenção dão Atenção; o resto é
          Positiva.
        </p>
        <dl className="legend-list">
          <div>
            <dt>{VERDICT_SIGNAL_LABEL.cpl}</dt>
            <dd>
              Bom até {pct(1 - VERDICT_RULES.cplGoodRatio)} abaixo da meta, atenção até{' '}
              {pct(VERDICT_RULES.cplAttentionRatio - 1)} acima, ruim além disso. Sem nenhum lead,
              ruim quando o gasto passa de {VERDICT_RULES.cplNoLeadSpendRatio}× a meta.
            </dd>
          </div>
          <div>
            <dt>{VERDICT_SIGNAL_LABEL.ctr}</dt>
            <dd>
              Bom a partir de {pct(VERDICT_RULES.ctrGoodRatio - 1)} acima da mediana da conta em 90
              dias, ruim abaixo de {pct(1 - VERDICT_RULES.ctrAttentionRatio)} sob ela.
            </dd>
          </div>
          <div>
            <dt>{VERDICT_SIGNAL_LABEL.trend}</dt>
            <dd>
              CPL: bom caindo {pct(VERDICT_RULES.cplTrendGoodPercent / 100)} ou mais, ruim subindo{' '}
              {pct(VERDICT_RULES.cplTrendBadPercent / 100)} ou mais. CTR: bom subindo{' '}
              {pct(VERDICT_RULES.ctrTrendGoodPercent / 100)}, ruim caindo{' '}
              {pct(VERDICT_RULES.ctrTrendBadPercent / 100)}.
            </dd>
          </div>
          <div>
            <dt>{VERDICT_SIGNAL_LABEL.frequency}</dt>
            <dd>
              Atenção a partir de {VERDICT_RULES.frequencyAttentionMilli / 1000}, ruim a partir de{' '}
              {VERDICT_RULES.frequencyBadMilli / 1000}. Como o alcance soma dias, a frequência do
              período é um piso.
            </dd>
          </div>
          <div>
            <dt>{VERDICT_SIGNAL_LABEL.pacing}</dt>
            <dd>
              Gasto dos últimos 7 dias contra 7 vezes o orçamento diário: bom entre{' '}
              {pct(VERDICT_RULES.pacingGoodMin)} e {pct(VERDICT_RULES.pacingGoodMax)}, atenção entre{' '}
              {pct(VERDICT_RULES.pacingAttentionMin)} e {pct(VERDICT_RULES.pacingAttentionMax)},
              ruim fora disso.
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
