import {
  CONVERSION_PLATFORM_LABEL,
  CONVERSION_PLATFORMS,
  CONVERSION_SKIP_LABEL,
  type ConversionMapping,
  type ConversionPlatform,
  type ConversionPlatformStatus,
} from '@wings/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useConversionsPanel, useSaveConversionMapping } from '../api/ads.js';
import { hasPermission, useSession } from '../api/auth.js';
import { useStages } from '../api/leads.js';
import { LoadFailure } from '../components/LoadFailure.js';
import { PageHeader } from '../components/PageHeader.js';
import { failureReason } from '../lib/failure.js';

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function PlatformCard({ status }: { status: ConversionPlatformStatus }) {
  const state = !status.enabled
    ? 'Desligado'
    : status.missing.length > 0
      ? 'Ligado, mas sem configuração'
      : 'Ligado';
  return (
    <section className="card" aria-label={CONVERSION_PLATFORM_LABEL[status.platform]}>
      <h2>
        {CONVERSION_PLATFORM_LABEL[status.platform]} <span className="muted">— {state}</span>
      </h2>
      {status.missing.length > 0 && (
        <p className="field-hint">Falta no ambiente: {status.missing.join(', ')}.</p>
      )}
      <dl className="conversion-stats">
        <dt>Enviados</dt>
        <dd>{status.sent}</dd>
        <dt>Na fila</dt>
        <dd>{status.pending}</dd>
        <dt>Falharam</dt>
        <dd>{status.failed}</dd>
        <dt>Não enviados</dt>
        <dd>{status.skipped}</dd>
        <dt>Último envio</dt>
        <dd>{formatDateTime(status.lastSentAt)}</dd>
      </dl>
      {status.errors.length > 0 && (
        <>
          <h3>Falhas e novas tentativas, por código</h3>
          <ul>
            {status.errors.map((error) => (
              <li key={error.code}>
                <code>{error.code}</code>: {error.count}
              </li>
            ))}
          </ul>
        </>
      )}
      {status.skips.length > 0 && (
        <>
          <h3>Por que não foram enviados</h3>
          <ul>
            {status.skips.map((skip) => (
              <li key={skip.reason}>
                {CONVERSION_SKIP_LABEL[skip.reason]}: {skip.count}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Which stage becomes which event: bound to the stage's id, so a rename changes nothing. */
function MappingForm() {
  const stages = useStages();
  const save = useSaveConversionMapping();
  const [stageId, setStageId] = useState('');
  const [platform, setPlatform] = useState<ConversionPlatform>('meta');
  const [eventName, setEventName] = useState('');
  const [actionId, setActionId] = useState('');
  const [active, setActive] = useState(true);

  if (stages.isError) return <LoadFailure what="as etapas do CRM" error={stages.error} />;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({
      stageId,
      platform,
      eventName,
      googleConversionActionId: platform === 'google' ? actionId : null,
      active,
    });
  };
  return (
    <form className="card conversion-form" onSubmit={submit} aria-label="Etapa e evento">
      <h2>Escolher etapa e evento</h2>
      <label>
        Etapa
        <select value={stageId} onChange={(e) => setStageId(e.target.value)} required>
          <option value="">Escolha…</option>
          {(stages.data?.stages ?? [])
            .filter((stage) => stage.active)
            .map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.pipeline} — {stage.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        Plataforma
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as ConversionPlatform)}
        >
          {CONVERSION_PLATFORMS.map((value) => (
            <option key={value} value={value}>
              {CONVERSION_PLATFORM_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Nome do evento
        <input
          value={eventName}
          onChange={(e) => setEventName(e.target.value)}
          placeholder="reuniao_agendada"
          required
        />
      </label>
      {platform === 'google' && (
        <label>
          Id da ação de conversão (Google Ads)
          <input
            value={actionId}
            onChange={(e) => setActionId(e.target.value)}
            inputMode="numeric"
            required
          />
        </label>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Ativo
      </label>
      <button type="submit" className="btn" disabled={save.isPending}>
        Salvar
      </button>
      {save.isError && (
        <p role="alert" className="field-error">
          Não salvou: {failureReason(save.error)}.
        </p>
      )}
      {save.isSuccess && <p className="field-hint">Salvo.</p>}
    </form>
  );
}

function MappingTable({ mappings }: { mappings: ConversionMapping[] }) {
  if (mappings.length === 0) {
    return <p className="muted">Nenhuma etapa escolhida ainda: nada é enviado.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Funil</th>
            <th>Etapa</th>
            <th>Plataforma</th>
            <th>Evento</th>
            <th>Ação de conversão</th>
            <th>Situação</th>
          </tr>
        </thead>
        <tbody>
          {mappings.map((mapping) => (
            <tr key={mapping.id}>
              <td>{mapping.pipeline}</td>
              <td>{mapping.stageName}</td>
              <td>{CONVERSION_PLATFORM_LABEL[mapping.platform]}</td>
              <td>
                <code>{mapping.eventName}</code>
              </td>
              <td>{mapping.googleConversionActionId ?? '—'}</td>
              <td>{mapping.active ? 'Ativo' : 'Inativo'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Closing the loop: how many stage events went to Meta and Google, how many failed and why.
 * Counts and codes only; no lead appears here. The switches are Eric's, in the environment.
 */
export function AdConversionsPage() {
  const panel = useConversionsPanel();
  const { data: user } = useSession();
  const canConfigure = hasPermission(user, 'ads.approve');

  return (
    <div className="page">
      <PageHeader
        title="Etapas do CRM para a Meta e o Google"
        subtitle="Últimos 30 dias. Só contagens e códigos: nenhum dado de lead aparece aqui."
        actions={
          <Link to="/marketing/trafego-pago-wings" className="btn btn-ghost btn-inline">
            Voltar
          </Link>
        }
      />
      {panel.isError ? (
        <LoadFailure what="o painel" error={panel.error} onRetry={() => void panel.refetch()} />
      ) : !panel.data ? (
        <p className="muted">Carregando…</p>
      ) : (
        <>
          <p className="field-hint">
            Data de corte:{' '}
            {panel.data.since
              ? formatDateTime(panel.data.since)
              : '— não definida (CRM_CONVERSIONS_SINCE): nada é enviado'}
            . E-mail e telefone com hash: {panel.data.hashedEnabled ? 'ligado' : 'desligado'}.
            Google: {panel.data.googleValidateOnly ? 'só valida, nada é gravado' : 'grava'}.
          </p>
          <div className="grid-2">
            {panel.data.platforms.map((status) => (
              <PlatformCard key={status.platform} status={status} />
            ))}
          </div>
          <h2>Etapas que viram eventos</h2>
          <MappingTable mappings={panel.data.mappings} />
          {canConfigure && <MappingForm />}
        </>
      )}
    </div>
  );
}
