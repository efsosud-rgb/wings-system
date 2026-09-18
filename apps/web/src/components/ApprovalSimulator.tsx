import { CHANGE_KIND_LABEL, type ChangeSimulation, type ExposureScenario } from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSimulation } from '../api/ads.js';
import { Alert, Button, Field, Input } from './ui.js';

/**
 * Before/after diff and scenario simulator for one pending change.
 *
 * Read-only decision support. Nothing here approves, edits or executes: the
 * "simular" box answers "what would a different number look like?" and stops
 * there — the request can only ever be approved exactly as it was made.
 *
 * The one fact this panel exists to make plain: **exposure is reserved when a
 * change is requested, not when it is approved.** So the month's committed
 * total already contains this request. Approving changes reality; rejecting
 * gives the reservation back. Showing only one committed figure would make
 * approving look free.
 */

function formatBrl(cents: number | null): string {
  if (cents === null) return '—';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function parseBrlToCents(value: string): number | null {
  const normalised = value
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.]/g, '');
  if (!normalised) return null;
  const parsed = Number(normalised);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function ScenarioColumn({
  scenario,
  title,
  hint,
}: {
  scenario: ExposureScenario;
  title: string;
  hint?: string;
}) {
  const breached = !scenario.withinUsable || !scenario.withinCap;

  return (
    <div className={`scenario ${breached ? 'scenario-breach' : ''}`}>
      <span className="field-label">{title}</span>
      {hint && <span className="cell-sub">{hint}</span>}
      <dl>
        <div>
          <dt>Orçamento diário</dt>
          <dd className="mono">{formatBrl(scenario.dailyBudgetCents)}</dd>
        </div>
        <div>
          <dt>Exposição da campanha</dt>
          <dd className="mono">{formatBrl(scenario.campaignExposureCents)}</dd>
        </div>
        <div>
          <dt>Comprometido no mês</dt>
          <dd className="mono">{formatBrl(scenario.committedCents)}</dd>
        </div>
        <div>
          <dt>Ainda disponível</dt>
          <dd className="mono">{formatBrl(scenario.availableCents)}</dd>
        </div>
        <div>
          <dt>Do utilizável</dt>
          <dd className="mono">{scenario.usedOfUsablePercent}%</dd>
        </div>
        <div>
          <dt>Do teto</dt>
          <dd className="mono">{scenario.usedOfCapPercent}%</dd>
        </div>
        <div>
          <dt>Fôlego</dt>
          <dd className="mono">
            {scenario.runwayDays === null ? '—' : `${scenario.runwayDays} dia(s)`}
          </dd>
        </div>
      </dl>
      {breached && (
        <p className="error-text">
          {scenario.withinUsable
            ? 'Ultrapassaria o teto mensal.'
            : 'Ultrapassaria a parcela utilizável do mês.'}
        </p>
      )}
    </div>
  );
}

function Diff({ simulation }: { simulation: ChangeSimulation }) {
  const rows: { label: string; before: string; after: string }[] = [];

  if (simulation.kind === 'set_daily_budget') {
    rows.push({
      label: 'Orçamento diário',
      before: formatBrl(simulation.current.dailyBudgetCents),
      after: formatBrl(simulation.requested.dailyBudgetCents),
    });
  }
  if (simulation.kind === 'pause_campaign' || simulation.kind === 'resume_campaign') {
    rows.push({
      label: 'Situação da campanha',
      before: simulation.kind === 'pause_campaign' ? 'Ativa' : 'Pausada',
      after: simulation.kind === 'pause_campaign' ? 'Pausada' : 'Ativa',
    });
  }
  rows.push({
    label: 'Exposição até o fim do mês',
    before: formatBrl(simulation.current.campaignExposureCents),
    after: formatBrl(simulation.requested.campaignExposureCents),
  });
  rows.push({
    label: 'Comprometido na conta',
    before: formatBrl(simulation.period.committedWithoutRequestCents),
    after: formatBrl(simulation.period.committedWithRequestCents),
  });

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Campo</th>
            <th>Antes</th>
            <th>Depois</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="mono diff-before">{row.before}</td>
              <td className="mono diff-after">{row.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ApprovalSimulator({ approvalId }: { approvalId: string }) {
  const [applied, setApplied] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const query = useSimulation(approvalId, applied);

  if (query.isLoading) return <p className="muted">Calculando cenário…</p>;
  if (query.isError || !query.data) {
    return <Alert kind="error">Não foi possível calcular o cenário.</Alert>;
  }

  const { simulation, nextPending } = query.data;

  const simulate = () => {
    const cents = parseBrlToCents(draft);
    if (cents === null) {
      setError('Informe um valor em reais, por exemplo 25,00');
      return;
    }
    setError(null);
    setApplied(cents);
  };

  return (
    <>
      <section className="block">
        <legend>Antes e depois</legend>
        <p className="field-hint">
          {CHANGE_KIND_LABEL[simulation.kind] ?? simulation.kind} em {simulation.campaignName} ·{' '}
          {simulation.daysLeftInPeriod} dia(s) restantes no mês · sobreentrega de{' '}
          {(simulation.overdeliveryFactorMilli / 1000).toLocaleString('pt-BR')}× já incluída.
        </p>

        {simulation.drift && (
          <Alert kind="error">
            O orçamento desta campanha mudou na plataforma desde o pedido:{' '}
            {formatBrl(simulation.drift.expectedCents)} quando foi solicitado,{' '}
            {formatBrl(simulation.drift.mirroredCents)} no último espelhamento. A execução será
            recusada enquanto não bater — confira no Gerenciador de Anúncios antes de aprovar.
          </Alert>
        )}

        <Diff simulation={simulation} />

        <p className="field-hint">
          A exposição é reservada quando a alteração é <strong>solicitada</strong>, não quando é
          aprovada. Recusar devolve {formatBrl(simulation.requested.campaignExposureCents)} ao
          disponível do mês; aprovar libera o gasto de verdade na plataforma.
        </p>
      </section>

      <section className="block">
        <legend>Simulação contra o teto do mês</legend>
        <div className="scenario-grid">
          <ScenarioColumn
            scenario={simulation.current}
            title="Hoje"
            hint="se esta solicitação for recusada"
          />
          <ScenarioColumn
            scenario={simulation.requested}
            title="Como solicitado"
            hint="valor que será aprovado"
          />
          {simulation.simulated && (
            <ScenarioColumn
              scenario={simulation.simulated}
              title="Simulação"
              hint="apenas exploração"
            />
          )}
        </div>

        {simulation.simulationAvailable ? (
          <div className="simulate-box">
            <Field
              label="E se o orçamento diário fosse…"
              error={error ?? undefined}
              hint="Só simula. Para aplicar outro valor, recuse esta e peça uma nova alteração."
            >
              <Input
                value={draft}
                inputMode="decimal"
                placeholder="Ex.: 25,00"
                onChange={(event) => setDraft(event.target.value)}
              />
            </Field>
            <Button type="button" variant="ghost" onClick={simulate}>
              Simular
            </Button>
          </div>
        ) : (
          <p className="field-hint">
            {simulation.budgetLevel === 'ad_set'
              ? 'Campanha ABO: o orçamento fica nos conjuntos de anúncios, então não há valor de campanha para simular.'
              : 'Esta alteração não tem um valor a variar.'}
          </p>
        )}
      </section>

      {nextPending && (
        <Alert kind="info">
          Há mais {nextPending.remaining} solicitação(ões) aguardando nesta campanha.{' '}
          <Link to={`/marketing/trafego-pago-wings/aprovacoes/${nextPending.approvalId}`}>
            Ir para a próxima decisão
          </Link>{' '}
          — cada uma é decidida e registrada separadamente.
        </Alert>
      )}
    </>
  );
}
