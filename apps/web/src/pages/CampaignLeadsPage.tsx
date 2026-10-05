import {
  AD_PLATFORM_LABEL,
  ATTRIBUTION_METHOD_LABEL,
  TEMPERATURE_LABEL,
  UNATTRIBUTED_REASONS,
  firstContactBand,
  type CampaignLeadRow,
  type CampaignLeadsSummary,
} from '@wings/shared';
import { useState } from 'react';
import { useCampaignLeads, useRevealCampaignLead } from '../api/campaign-leads.js';
import { formatDateTime, formatInt, formatWhen } from '../components/dashboard/format.js';
import { Chart3D } from '../components/charts3d/Chart3D.js';
import { ChartTable } from '../components/dashboard/charts3d.js';
import { Alert } from '../components/ui.js';
import { PageHeader } from '../components/PageHeader.js';

/**
 * Dashboard → Leads das Campanhas. The RD CRM deals of the Formatação funnel
 * that came from the campaigns running now, since 28/09. Phone and e-mail
 * arrive masked; "revelar" asks the server, which writes it to the audit log.
 */

function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} dias`;
}

const BAND_CLASS = {
  green: 'status-active',
  amber: 'status-on_leave',
  red: 'status-inactive',
} as const;

function FirstContact({ lead }: { lead: CampaignLeadRow }) {
  if (lead.firstContactMinutes === null) {
    const waiting = Math.round((Date.now() - new Date(lead.enteredAt).getTime()) / 60_000);
    return (
      <span
        className={`status ${BAND_CLASS[firstContactBand(waiting)]}`}
        title="Ainda sem contato registrado no RD"
      >
        esperando há {minutesLabel(waiting)}
      </span>
    );
  }
  return (
    <span
      className={`status ${BAND_CLASS[firstContactBand(lead.firstContactMinutes)]}`}
      title={
        lead.firstContactSource === 'stage'
          ? 'Pela mudança de etapa vista pela conferência (precisão de 15 min)'
          : 'Pela primeira anotação ou tarefa feita no RD'
      }
    >
      {minutesLabel(lead.firstContactMinutes)}
    </span>
  );
}

function Reveal({
  lead,
  field,
  masked,
}: {
  lead: CampaignLeadRow;
  field: 'phone' | 'email';
  masked: string | null;
}) {
  const reveal = useRevealCampaignLead();
  const [value, setValue] = useState<string | null>(null);
  if (!masked) return <span className="muted">—</span>;
  if (value) return <span className="mono">{value}</span>;
  return (
    <span>
      <span className="mono">{masked}</span>{' '}
      <button
        type="button"
        className="link-button"
        disabled={reveal.isPending}
        onClick={() =>
          reveal.mutate({ id: lead.id, field }, { onSuccess: (result) => setValue(result.value) })
        }
        title="Fica registrado no log de auditoria"
      >
        revelar
      </button>
      {reveal.isError && <span className="cell-sub">não foi possível revelar</span>}
    </span>
  );
}

function Summary({ summary }: { summary: CampaignLeadsSummary }) {
  return (
    <section className="campaign-leads-summary" aria-label="Resumo">
      <div className="kpi">
        <span className="kpi-label">Leads hoje</span>
        <span className="kpi-value mono">{formatInt(summary.today)}</span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Últimos 7 dias</span>
        <span className="kpi-value mono">{formatInt(summary.week)}</span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Contatados</span>
        <span className="kpi-value mono">
          {summary.contactedPercent === null ? '—' : `${summary.contactedPercent}%`}
        </span>
        {summary.contactedPercent === null && (
          <span className="kpi-delta muted">sem leads ainda</span>
        )}
      </div>
      <div className="kpi">
        <span className="kpi-label">Tempo médio até o 1º contato</span>
        <span className="kpi-value mono">
          {summary.averageFirstContactMinutes === null
            ? '—'
            : minutesLabel(summary.averageFirstContactMinutes)}
        </span>
        {summary.averageFirstContactMinutes === null && (
          <span className="kpi-delta muted">nenhum contato registrado</span>
        )}
      </div>
    </section>
  );
}

/** Stages, losses and the deals left out, each as a 3D chart with its table. */
function Breakdown({ summary }: { summary: CampaignLeadsSummary }) {
  const lists: {
    title: string;
    empty: string;
    rows: { label: string; value: number }[];
    ordered?: boolean;
    head: string;
  }[] = [
    {
      title: 'Por etapa',
      empty: '— nenhum lead no período',
      rows: summary.stages.map((stage) => ({ label: stage.stage, value: stage.count })),
      ordered: true,
      head: 'Etapa',
    },
    {
      title: 'Perdidos, com motivo',
      empty: 'nenhum perdido no período',
      rows: summary.lost.map((lost) => ({ label: lost.reason, value: lost.count })),
      head: 'Motivo',
    },
    {
      title: 'Sem atribuição, por motivo',
      empty: 'nenhum negócio sem atribuição',
      rows: summary.unattributed.map((entry) => ({
        label: UNATTRIBUTED_REASONS[entry.reason],
        value: entry.count,
      })),
      head: 'Motivo',
    },
  ];
  return (
    <div className="sales-grid campaign-leads-charts">
      {lists.map((list) => (
        <section key={list.title} className="card sales-card" aria-label={list.title}>
          <h2>{list.title}</h2>
          {list.rows.length === 0 ? (
            <p className="muted sales-empty">{list.empty}</p>
          ) : (
            <Chart3D
              height={Math.min(300, 70 + Math.min(list.rows.length, 6) * 38)}
              ariaLabel={list.title}
              spec={{
                kind: 'ranked',
                items: list.rows,
                format: 'int',
                sort: !list.ordered,
                limit: list.ordered ? Infinity : undefined,
              }}
              table={
                <ChartTable
                  caption={list.title}
                  head={[list.head, 'Negócios']}
                  rows={list.rows.map((row) => ({
                    key: row.label,
                    cells: [row.label, formatInt(row.value)],
                  }))}
                />
              }
            />
          )}
        </section>
      ))}
    </div>
  );
}

export function CampaignLeadsPage() {
  const leads = useCampaignLeads();
  const data = leads.data;

  return (
    <>
      <PageHeader
        title="Leads das Campanhas"
        subtitle={
          <>
            Negócios do Funil Formatação no RD CRM que vieram das campanhas ativas, desde
            28/09/2026. A conferência com o RD roda a cada 15 minutos e só lê: nada é alterado no
            RD.
            {data?.summary.fetchedAt && <> Dados do RD {formatWhen(data.summary.fetchedAt)}.</>}
            {data && !data.summary.fetchedAt && <> A primeira conferência ainda não rodou.</>}
          </>
        }
      />

      {leads.isError && <Alert kind="error">Não foi possível carregar os leads.</Alert>}
      {leads.isLoading && <p className="muted">Carregando…</p>}

      {data && (
        <>
          {data.scope === 'own' && (
            <Alert kind="info">Você vê só os leads que o RD atribui a você.</Alert>
          )}
          {data.summary.smallSample && data.summary.total > 0 && (
            <p>
              <span className="status status-on_leave">Amostra pequena</span>{' '}
              <span className="cell-sub">
                Menos de 10 leads no período: as taxas mudam muito a cada lead novo.
              </span>
            </p>
          )}

          <Summary summary={data.summary} />
          <Breakdown summary={data.summary} />

          <section className="campaign-leads-attribution" aria-label="Atribuição">
            <p>
              <b>Sem atribuição:</b>{' '}
              {data.summary.unattributedPercent === null
                ? '—'
                : `${data.summary.unattributedPercent}% dos negócios do Funil Formatação no período`}
              {data.summary.tests > 0 && (
                <span className="cell-sub">
                  {' '}
                  · {data.summary.tests} negócio(s) de teste ignorado(s) em todos os números
                </span>
              )}
            </p>
          </section>

          <div className="table-wrap">
            <table className="table campaign-leads-table">
              <thead>
                <tr>
                  <th>Entrada</th>
                  <th>Lead</th>
                  <th>Origem</th>
                  <th>Etapa</th>
                  <th>Responsável</th>
                  <th>1º contato</th>
                  <th>Temperatura</th>
                  <th>Última atividade</th>
                  <th>Telefone</th>
                  <th>E-mail</th>
                </tr>
              </thead>
              <tbody>
                {data.leads.length === 0 && (
                  <tr>
                    <td colSpan={10} className="muted">
                      Nenhum lead das campanhas ativas desde 28/09. Quando o RD criar um negócio no
                      Funil Formatação vindo delas, ele aparece aqui na conferência seguinte.
                    </td>
                  </tr>
                )}
                {data.leads.map((lead) => (
                  <tr key={lead.id}>
                    <td className="mono">{formatDateTime(lead.enteredAt)}</td>
                    <td>
                      {lead.name ?? '—'}
                      <span className="cell-sub">
                        {[lead.company, lead.segment, lead.city].filter(Boolean).join(' · ') ||
                          'empresa, segmento e cidade não informados no RD'}
                      </span>
                    </td>
                    <td>
                      {lead.campaignName ?? '—'}
                      <span className="cell-sub">
                        {lead.platform ? AD_PLATFORM_LABEL[lead.platform] : ''}
                        {lead.adName ? ` · ${lead.adName}` : ' · anúncio não identificado'}
                        {lead.attribution ? ` · ${ATTRIBUTION_METHOD_LABEL[lead.attribution]}` : ''}
                      </span>
                    </td>
                    <td>
                      {lead.stage}
                      {lead.win === false && (
                        <span className="cell-sub">Perdido: {lead.lostReason ?? 'sem motivo'}</span>
                      )}
                      {lead.win === true && <span className="cell-sub">Ganho</span>}
                    </td>
                    <td>{lead.owner ?? '—'}</td>
                    <td>
                      <FirstContact lead={lead} />
                    </td>
                    <td>{lead.temperature ? TEMPERATURE_LABEL[lead.temperature] : '—'}</td>
                    <td className="mono">
                      {lead.lastActivityAt ? formatDateTime(lead.lastActivityAt) : '—'}
                    </td>
                    <td>
                      <Reveal lead={lead} field="phone" masked={lead.phoneMasked} />
                    </td>
                    <td>
                      <Reveal lead={lead} field="email" masked={lead.emailMasked} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="cell-sub">
            Temperatura pela classificação de estrelas do RD (1–2 Frio, 3 Morno, 4–5 Quente). 1º
            contato: verde em menos de 5 min, amarelo em menos de 1 h, vermelho acima.
          </p>
        </>
      )}
    </>
  );
}
