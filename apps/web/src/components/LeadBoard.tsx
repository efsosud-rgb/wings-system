import {
  LEAD_PIPELINE_LABELS,
  type BoardCard,
  type BoardColumn,
  type LeadPipeline,
} from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useBoard, useMoveLead } from '../api/leads.js';
import { Alert } from './ui.js';
import { formatDateTime, sinceLabel } from '../pages/LeadsPage.js';

/**
 * The kanban of one funnel: a column per stage, the open leads as cards.
 * Dragging a card to a column is the same PATCH as the lead's page; the
 * "Mover para" select on each card does the same without a mouse. A column
 * shows at most 60 cards and says how many more there are. No 3D here: this
 * is a work screen, it has to be fast.
 */
export function LeadBoard({
  pipeline,
  canWrite,
  filter,
}: {
  pipeline: LeadPipeline;
  canWrite: boolean;
  filter: { owner?: string; clientId?: string };
}) {
  const board = useBoard(pipeline, filter);
  const move = useMoveLead();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const columns = board.data?.columns ?? [];
  const targets = columns.filter((column) => column.stage?.active);

  const moveTo = (id: string, stageId: string) => move.mutate({ id, stageId });

  if (board.isLoading) return <p className="muted">Carregando o kanban…</p>;
  if (board.isError) return <Alert kind="error">Não foi possível carregar o kanban.</Alert>;
  if (columns.length === 0) {
    return (
      <p className="muted">
        O funil {LEAD_PIPELINE_LABELS[pipeline]} ainda não tem etapas nem leads em andamento. As
        etapas vêm do RD CRM na importação ou são criadas em Administração → CRM.
      </p>
    );
  }
  return (
    <>
      {move.error && (
        <Alert kind="error">
          {move.error instanceof ApiError ? move.error.message : 'Não foi possível mover o lead.'}
        </Alert>
      )}
      <div className="board" role="list" aria-label={`Kanban ${LEAD_PIPELINE_LABELS[pipeline]}`}>
        {columns.map((column) => (
          <Column
            key={column.stage?.id ?? 'none'}
            column={column}
            canDrop={canWrite && Boolean(column.stage?.active)}
            isOver={over === (column.stage?.id ?? 'none')}
            onDragOver={() => setOver(column.stage?.id ?? 'none')}
            onDrop={() => {
              if (dragging && column.stage?.active) moveTo(dragging, column.stage.id);
              setDragging(null);
              setOver(null);
            }}
          >
            {column.cards.map((card) => (
              <Card
                key={card.id}
                card={card}
                canWrite={canWrite}
                dragging={dragging === card.id}
                onDragStart={() => setDragging(card.id)}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                targets={targets.filter((target) => target.stage?.id !== column.stage?.id)}
                onMove={(stageId) => moveTo(card.id, stageId)}
              />
            ))}
          </Column>
        ))}
      </div>
    </>
  );
}

function Column({
  column,
  canDrop,
  isOver,
  onDragOver,
  onDrop,
  children,
}: {
  column: BoardColumn;
  canDrop: boolean;
  isOver: boolean;
  onDragOver: () => void;
  onDrop: () => void;
  children: React.ReactNode;
}) {
  const title = column.stage ? column.stage.name : 'Sem etapa';
  return (
    <section
      role="listitem"
      className={`board-column${isOver && canDrop ? ' board-drop' : ''}`}
      aria-label={`${title}: ${column.total} lead(s)`}
      onDragOver={(event) => {
        if (!canDrop) return;
        event.preventDefault();
        onDragOver();
      }}
      onDrop={(event) => {
        if (!canDrop) return;
        event.preventDefault();
        onDrop();
      }}
    >
      <div className="board-column-head">
        <span>
          {column.stage ? `${column.stage.position}. ` : ''}
          {title}
          {column.stage && !column.stage.active ? ' (desativada)' : ''}
        </span>
        <span className="muted">{column.total}</span>
      </div>
      {children}
      {column.total > column.cards.length && (
        <p className="muted">
          + {column.total - column.cards.length} lead(s) nesta etapa; use a lista com filtros para
          vê-los.
        </p>
      )}
    </section>
  );
}

function Card({
  card,
  canWrite,
  dragging,
  onDragStart,
  onDragEnd,
  targets,
  onMove,
}: {
  card: BoardCard;
  canWrite: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  targets: BoardColumn[];
  onMove: (stageId: string) => void;
}) {
  const overdue = card.nextTaskDueAt ? new Date(card.nextTaskDueAt).getTime() < Date.now() : false;
  return (
    <article
      className={`board-card${dragging ? ' board-card-dragging' : ''}`}
      draggable={canWrite}
      tabIndex={0}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', card.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <Link to={`/crm-vendas/funil/${card.id}`}>{card.name ?? 'Sem nome'}</Link>
      <span className="cell-sub">
        {card.brand ?? card.clientName}
        {card.ownerName ? ` · ${card.ownerName}` : ' · sem dono'}
      </span>
      <span className="cell-sub">
        {card.stageChangedAt
          ? `na etapa ${sinceLabel(card.stageChangedAt)}`
          : `chegou ${sinceLabel(card.createdAt)}`}
        {card.nextTaskDueAt
          ? ` · ${overdue ? 'tarefa atrasada' : `próxima tarefa ${formatDateTime(card.nextTaskDueAt)}`}`
          : ''}
      </span>
      {canWrite && targets.length > 0 && (
        <select
          className="control board-card-move"
          aria-label={`Mover ${card.name ?? 'lead'} para`}
          value=""
          onChange={(event) => event.target.value && onMove(event.target.value)}
        >
          <option value="">Mover para…</option>
          {targets.map((target) => (
            <option key={target.stage?.id} value={target.stage?.id}>
              {target.stage?.name}
            </option>
          ))}
        </select>
      )}
    </article>
  );
}
