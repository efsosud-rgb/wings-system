import {
  DRIVE_DEPARTMENTS,
  DRIVE_DEPARTMENT_KEYS,
  type DriveDepartment,
  type DriveTemplateKind,
  type DriveTemplateNode,
} from '@wings/shared';
import { useState, type ReactNode } from 'react';
import {
  useCreateTemplateNode,
  useDeleteTemplateNode,
  useDriveTemplate,
  useSyncDrive,
  useUpdateTemplateNode,
} from '../api/drive.js';
import { errorText } from '../components/drive/DriveParts.js';
import { LoadFailure } from '../components/LoadFailure.js';
import { Alert, Button } from '../components/ui.js';
import { PageHeader } from '../components/PageHeader.js';

/**
 * Administração → Drive → Modelo de pastas. The folders every department gets,
 * and what goes inside each client's folder. Editing the model changes nothing
 * in the Drive by itself: "Sincronizar pastas" applies it, and only ever adds
 * or renames.
 */

function AddNode({ parent }: { parent: DriveTemplateNode | null }) {
  const create = useCreateTemplateNode();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DriveTemplateKind>('folder');
  const [department, setDepartment] = useState<DriveDepartment>(parent?.department ?? 'formatacao');
  const where = parent ? `dentro de ${parent.name}` : 'na raiz';
  return (
    <form
      className="drive-template-add"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          { parentId: parent?.id ?? null, name, kind, department },
          { onSuccess: () => setName('') },
        );
      }}
    >
      <label className="field">
        <span className="field-label">Nova pasta {where}</span>
        <input
          className="control"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Tipo</span>
        <select
          className="control"
          value={kind}
          onChange={(event) => setKind(event.target.value as DriveTemplateKind)}
        >
          <option value="folder">Pasta</option>
          <option value="clients">Pasta de clientes (uma por cliente)</option>
        </select>
      </label>
      <label className="field">
        <span className="field-label">Departamento</span>
        <select
          className="control"
          value={department}
          onChange={(event) => setDepartment(event.target.value as DriveDepartment)}
        >
          {DRIVE_DEPARTMENT_KEYS.map((key) => (
            <option key={key} value={key}>
              {DRIVE_DEPARTMENTS[key]}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="ghost" disabled={create.isPending || name.trim() === ''}>
        Adicionar
      </Button>
      {create.error && (
        <span className="field-error" role="alert">
          {errorText(create.error, 'Não foi possível adicionar.')}
        </span>
      )}
    </form>
  );
}

function NodeRow({ node, inClients }: { node: DriveTemplateNode; inClients: boolean }) {
  const update = useUpdateTemplateNode();
  const remove = useDeleteTemplateNode();
  const [name, setName] = useState(node.name);
  const [adding, setAdding] = useState(false);
  const problem = update.error ?? remove.error;
  return (
    <div className="drive-template-row">
      <form
        className="drive-template-name"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== node.name) update.mutate({ id: node.id, name: name.trim() });
        }}
      >
        <input
          className="control"
          aria-label={`Nome de ${node.name}`}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
        {name.trim() !== node.name && (
          <Button type="submit" variant="ghost" disabled={update.isPending}>
            Salvar nome
          </Button>
        )}
      </form>
      {node.kind === 'clients' && <span className="tag">uma pasta por cliente</span>}
      {inClients && <span className="tag">dentro de cada cliente</span>}
      <select
        className="control"
        aria-label={`Departamento de ${node.name}`}
        value={node.department}
        onChange={(event) =>
          update.mutate({ id: node.id, department: event.target.value as DriveDepartment })
        }
      >
        {DRIVE_DEPARTMENT_KEYS.map((key) => (
          <option key={key} value={key}>
            {DRIVE_DEPARTMENTS[key]}
          </option>
        ))}
      </select>
      <Button type="button" variant="ghost" onClick={() => setAdding((now) => !now)}>
        {adding ? 'Cancelar' : 'Adicionar dentro'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        aria-label={`Tirar ${node.name} do modelo`}
        disabled={remove.isPending}
        onClick={() => remove.mutate(node.id)}
      >
        Tirar do modelo
      </Button>
      {problem && (
        <span className="field-error" role="alert">
          {errorText(problem, 'Não foi possível salvar.')}
        </span>
      )}
      {adding && <AddNode parent={node} />}
    </div>
  );
}

export function DriveTemplatePage() {
  const template = useDriveTemplate();
  const sync = useSyncDrive();
  const nodes = template.data?.nodes ?? [];

  const branch = (parentId: string | null, inClients: boolean): ReactNode => {
    const list = nodes.filter((node) => node.parentId === parentId);
    if (list.length === 0) return null;
    return (
      <ul className="drive-template-list">
        {list.map((node) => (
          <li key={node.id}>
            <NodeRow node={node} inClients={inClients} />
            {branch(node.id, inClients || node.kind === 'clients')}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <>
      <PageHeader
        title="Drive: modelo de pastas"
        subtitle="As pastas que cada departamento recebe. Uma pasta de clientes ganha uma pasta para cada cliente ativo, com o que estiver dentro dela no modelo."
        actions={
          <Button type="button" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? 'Sincronizando…' : 'Sincronizar pastas'}
          </Button>
        }
      />

      {sync.data && (
        <Alert kind="success">
          {sync.data.foldersCreated}{' '}
          {sync.data.foldersCreated === 1 ? 'pasta criada' : 'pastas criadas'},{' '}
          {sync.data.foldersRenamed} {sync.data.foldersRenamed === 1 ? 'renomeada' : 'renomeadas'},
          para {sync.data.clients} {sync.data.clients === 1 ? 'cliente ativo' : 'clientes ativos'}.
        </Alert>
      )}
      {sync.error && <Alert kind="error">{errorText(sync.error, 'A sincronização falhou.')}</Alert>}
      {template.isError && (
        <LoadFailure
          what="o modelo de pastas"
          error={template.error}
          onRetry={() => void template.refetch()}
        />
      )}
      <p className="field-hint">
        Mudar o modelo não mexe no Drive até você sincronizar. A sincronização só cria e renomeia:
        tirar uma pasta do modelo deixa a pasta e os arquivos dela onde estão.
      </p>

      {template.isLoading ? <p className="muted">Carregando…</p> : branch(null, false)}
      <AddNode parent={null} />
    </>
  );
}
