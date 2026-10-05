import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  PROJECT_STAGES,
  type ClientProject,
  type ClientProjectStage,
  type ProjectStageSlot,
  type ProjectStatus,
} from '@wings/shared';
import { useMemo, useState } from 'react';
import { ApiError } from '../api/client.js';
import { useProjects, useSetCurrentStage } from '../api/projects.js';
import {
  ProjectStatusTag,
  StageChip,
  StageDialog,
  StatusDialog,
  stageLabel,
} from '../components/projects/ProjectParts.js';
import { Alert, Button, Select } from '../components/ui.js';
import { PageHeader } from '../components/PageHeader.js';

/**
 * Gestão → Projetos: one row per client, the eight stages in columns. What is
 * clickable is what the API said the viewer may change (`canManage` for the
 * status and the current stage, `canEdit` per stage); the API decides again.
 */

type Open =
  | { kind: 'status'; project: ClientProject }
  | { kind: 'stage'; project: ClientProject; stage: ClientProjectStage }
  | null;

/** `NN` as the Drive shows it. */
const numberLabel = (number: number | null) =>
  number === null ? '—' : String(number).padStart(2, '0');

const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function CurrentStageCell({ project }: { project: ClientProject }) {
  const move = useSetCurrentStage();
  if (!project.canManage) return <>{stageLabel(project.currentStage)}</>;
  return (
    <>
      <Select
        aria-label={`Etapa atual de ${project.clientName}`}
        className="projects-stage-select"
        value={project.currentStage}
        disabled={move.isPending}
        onChange={(event) =>
          move.mutate({ clientId: project.clientId, stage: event.target.value as ProjectStageSlot })
        }
      >
        {PROJECT_STAGES.map((stage) => (
          <option key={stage.slot} value={stage.slot}>
            {stage.name}
          </option>
        ))}
      </Select>
      {move.error && (
        <div className="field-error" role="alert">
          {move.error instanceof ApiError ? move.error.message : 'Não foi possível mudar a etapa.'}
        </div>
      )}
    </>
  );
}

export function ProjectsPage() {
  const [status, setStatus] = useState<ProjectStatus | ''>('');
  const [inactive, setInactive] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [text, setText] = useState('');
  const [open, setOpen] = useState<Open>(null);
  const projects = useProjects({ status: status || undefined, inactive, hidden });

  const rows = useMemo(() => {
    const list = projects.data?.projects ?? [];
    const needle = plain(text.trim());
    return needle ? list.filter((project) => plain(project.clientName).includes(needle)) : list;
  }, [projects.data, text]);

  return (
    <>
      <PageHeader
        title="Projetos"
        subtitle="O projeto de cada cliente: status, etapa atual e o andamento das oito etapas. Cada departamento marca a sua etapa."
      />

      <div className="filters" role="search" aria-label="Filtros do quadro">
        <label className="field">
          <span className="field-label">Status</span>
          <select
            className="control"
            aria-label="Filtrar por status"
            value={status}
            onChange={(event) => setStatus(event.target.value as ProjectStatus | '')}
          >
            <option value="">Todos</option>
            {PROJECT_STATUSES.map((item) => (
              <option key={item} value={item}>
                {PROJECT_STATUS_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Cliente</span>
          <input
            className="control"
            type="search"
            placeholder="Nome do cliente"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <label className="field projects-check">
          <input
            type="checkbox"
            checked={inactive}
            onChange={(event) => setInactive(event.target.checked)}
          />
          <span>Mostrar clientes inativos</span>
        </label>
        <label className="field projects-check">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(event) => setHidden(event.target.checked)}
          />
          <span>Mostrar projetos ocultos</span>
        </label>
      </div>

      {projects.isError && (
        <Alert kind="error">
          {projects.error instanceof ApiError
            ? projects.error.message
            : 'Não foi possível carregar os projetos.'}
        </Alert>
      )}

      <div className="table-wrap projects-board-wrap">
        <table className="table projects-board">
          <thead>
            <tr>
              <th title="O número da pasta do cliente no Drive">Nº</th>
              <th>Cliente</th>
              <th>Status</th>
              <th>Etapa atual</th>
              {PROJECT_STAGES.map((stage) => (
                <th key={stage.slot} className="projects-stage-head" title={stage.name}>
                  <span className="projects-stage-number">{stage.slot}</span>
                  <span className="projects-stage-name">{stage.name.slice(3)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.isLoading && (
              <tr>
                <td colSpan={4 + PROJECT_STAGES.length} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {!projects.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={4 + PROJECT_STAGES.length} className="muted">
                  Nenhum projeto com estes filtros.
                </td>
              </tr>
            )}
            {rows.map((project) => (
              <tr
                key={project.id}
                className={project.clientActive ? undefined : 'projects-row-inactive'}
              >
                <td className="mono">{numberLabel(project.clientNumber)}</td>
                <td>
                  {project.clientName}
                  {!project.clientActive && <span className="tag">inativo</span>}
                  {project.hidden && <span className="tag">oculto</span>}
                  {project.updatedByName && (
                    <div className="cell-sub">
                      Última mudança: {project.updatedByName},{' '}
                      {new Date(project.updatedAt).toLocaleDateString('pt-BR')}
                    </div>
                  )}
                </td>
                <td>
                  {project.canManage ? (
                    <button
                      type="button"
                      className="projects-status-button"
                      aria-label={`Status de ${project.clientName}: ${PROJECT_STATUS_LABELS[project.status]}`}
                      onClick={() => setOpen({ kind: 'status', project })}
                    >
                      <ProjectStatusTag status={project.status} />
                    </button>
                  ) : (
                    <ProjectStatusTag status={project.status} />
                  )}
                </td>
                <td>
                  <CurrentStageCell project={project} />
                </td>
                {PROJECT_STAGES.map((column) => {
                  const stage = project.stages.find((item) => item.slot === column.slot);
                  if (!stage) return <td key={column.slot} />;
                  return (
                    <td key={column.slot} className="projects-stage-cell">
                      <StageChip
                        stage={stage}
                        current={stage.slot === project.currentStage}
                        onClick={
                          stage.canEdit
                            ? () => setOpen({ kind: 'stage', project, stage })
                            : undefined
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="field-hint">
        Legenda: cinza não iniciada, azul em andamento, verde concluída, vermelho bloqueada. A borda
        marca a etapa atual do cliente. Concluir a etapa atual leva o cliente à próxima não
        concluída.
      </p>
      {open?.kind === 'status' && (
        <StatusDialog project={open.project} onClose={() => setOpen(null)} />
      )}
      {open?.kind === 'stage' && (
        <StageDialog project={open.project} stage={open.stage} onClose={() => setOpen(null)} />
      )}
      {projects.data && projects.data.projects.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          className="projects-refresh"
          onClick={() => void projects.refetch()}
        >
          Atualizar
        </Button>
      )}
    </>
  );
}
