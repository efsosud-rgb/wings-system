import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  PROJECT_STAGES,
  PROJECT_NOTE_MAX,
  PROJECT_REASON_MAX,
  STAGE_PROGRESSES,
  STAGE_PROGRESS_LABELS,
  projectStageOf,
  projectStatusRequiresReason,
  type ClientProject,
  type ClientProjectStage,
  type ProjectStatus,
  type StageProgress,
} from '@wings/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { useChangeProjectStatus, useProject, useUpdateProjectStage } from '../../api/projects.js';
import { Alert, Button, Field, Select } from '../ui.js';

/**
 * The pieces of a client project the screens share: the coloured status tag,
 * the chip of a stage, the two dialogs that change them, and the summary the
 * Drive shows on a client's folder.
 */

export function ProjectStatusTag({ status }: { status: ProjectStatus }) {
  return (
    <span className={`project-status project-status-${status}`}>
      {PROJECT_STATUS_LABELS[status]}
    </span>
  );
}

/** `04 Financeiro`, from the slot. */
export const stageLabel = (slot: string) => projectStageOf(slot)?.name ?? slot;

export function StageChip({
  stage,
  current,
  onClick,
}: {
  stage: ClientProjectStage;
  /** Whether this is the stage the client is at. */
  current: boolean;
  /** Present when the viewer may set this stage's progress. */
  onClick?: () => void;
}) {
  const className = `stage-chip stage-${stage.progress} ${current ? 'stage-current' : ''}`;
  const title = [
    stage.name,
    STAGE_PROGRESS_LABELS[stage.progress],
    stage.updatedByName ? `por ${stage.updatedByName}` : null,
    stage.note,
  ]
    .filter(Boolean)
    .join(' · ');
  if (!onClick) {
    return (
      <span className={className} title={title}>
        {STAGE_PROGRESS_LABELS[stage.progress]}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={`${stage.name}: ${STAGE_PROGRESS_LABELS[stage.progress]}`}
      onClick={onClick}
    >
      {STAGE_PROGRESS_LABELS[stage.progress]}
    </button>
  );
}

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

function Dialog({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="project-dialog-backdrop" onClick={onClose}>
      <div
        className="project-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** Changes the status; Parado and Cancelado ask why. */
export function StatusDialog({
  project,
  onClose,
}: {
  project: ClientProject;
  onClose: () => void;
}) {
  const change = useChangeProjectStatus();
  const [status, setStatus] = useState<ProjectStatus>(
    PROJECT_STATUSES.find((item) => item !== project.status) ?? project.status,
  );
  const [reason, setReason] = useState('');
  const needsReason = projectStatusRequiresReason(status);
  const missingReason = needsReason && reason.trim().length === 0;

  return (
    <Dialog label={`Status de ${project.clientName}`} onClose={onClose}>
      <h2>Status do projeto</h2>
      <p className="muted">
        {project.clientName} está <ProjectStatusTag status={project.status} />
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (missingReason) return;
          change.mutate(
            { clientId: project.clientId, status, reason: reason.trim() },
            { onSuccess: onClose },
          );
        }}
      >
        <Field label="Novo status">
          <Select
            aria-label="Novo status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as ProjectStatus);
              change.reset();
            }}
          >
            {PROJECT_STATUSES.filter((item) => item !== project.status).map((item) => (
              <option key={item} value={item}>
                {PROJECT_STATUS_LABELS[item]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Motivo"
          required={needsReason}
          hint={
            needsReason
              ? 'Obrigatório para Parado e Cancelado; fica no histórico do projeto.'
              : 'Opcional; fica no histórico do projeto.'
          }
        >
          <textarea
            className="control"
            aria-label="Motivo"
            rows={3}
            maxLength={PROJECT_REASON_MAX}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              change.reset();
            }}
          />
        </Field>
        {change.error && (
          <Alert kind="error">{errorText(change.error, 'Não foi possível mudar o status.')}</Alert>
        )}
        <div className="project-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={change.isPending || missingReason}>
            Salvar status
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Sets a stage's progress; Bloqueada asks what blocks it. */
export function StageDialog({
  project,
  stage,
  onClose,
}: {
  project: ClientProject;
  stage: ClientProjectStage;
  onClose: () => void;
}) {
  const update = useUpdateProjectStage();
  const [progress, setProgress] = useState<StageProgress>(stage.progress);
  const [note, setNote] = useState(stage.note ?? '');
  const missingNote = progress === 'bloqueada' && note.trim().length === 0;

  return (
    <Dialog label={`${stage.name} de ${project.clientName}`} onClose={onClose}>
      <h2>{stage.name}</h2>
      <p className="muted">
        {project.clientName}
        {stage.updatedByName && stage.updatedAt
          ? ` · última mudança por ${stage.updatedByName} em ${new Date(stage.updatedAt).toLocaleString('pt-BR')}`
          : ''}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (missingNote) return;
          update.mutate(
            { clientId: project.clientId, slot: stage.slot, progress, note: note.trim() },
            { onSuccess: onClose },
          );
        }}
      >
        <Field label="Andamento">
          <Select
            aria-label="Andamento"
            value={progress}
            onChange={(event) => {
              setProgress(event.target.value as StageProgress);
              update.reset();
            }}
          >
            {STAGE_PROGRESSES.map((item) => (
              <option key={item} value={item}>
                {STAGE_PROGRESS_LABELS[item]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Observação"
          required={progress === 'bloqueada'}
          hint={
            progress === 'bloqueada'
              ? 'Diga o que bloqueia a etapa.'
              : 'Opcional: aparece ao passar o mouse na etapa.'
          }
        >
          <textarea
            className="control"
            aria-label="Observação"
            rows={3}
            maxLength={PROJECT_NOTE_MAX}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              update.reset();
            }}
          />
        </Field>
        {update.error && (
          <Alert kind="error">{errorText(update.error, 'Não foi possível salvar a etapa.')}</Alert>
        )}
        <div className="project-dialog-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={update.isPending || missingNote}>
            Salvar etapa
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * What the Drive shows on a client's folder: the status and the current stage,
 * and on a stage folder that stage's progress. Read only: the board is where
 * it changes. Shows nothing while loading or when the project cannot be read.
 */
export function ProjectSummary({ clientId, slot }: { clientId: string; slot: string | null }) {
  const project = useProject(clientId);
  const data = project.data?.project;
  if (!data) return null;
  const stage = slot ? data.stages.find((item) => item.slot === slot) : undefined;
  return (
    <div className="drive-project" aria-label="Projeto do cliente">
      <ProjectStatusTag status={data.status} />
      <span className="drive-project-stage">Etapa atual: {stageLabel(data.currentStage)}</span>
      {stage && (
        <span className="drive-project-stage">
          Esta etapa: <StageChip stage={stage} current={stage.slot === data.currentStage} />
        </span>
      )}
    </div>
  );
}

export const STAGE_COLUMNS = PROJECT_STAGES;
