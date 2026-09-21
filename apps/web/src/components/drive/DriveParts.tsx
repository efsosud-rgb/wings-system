import { drivePreviewKind, type DriveFile, type DriveFolder, type DriveLink } from '@wings/shared';
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { driveLink, useDriveVersions, useUpdateFile } from '../../api/drive.js';
import { Button } from '../ui.js';

/** What a dragged file of the Drive carries, so a drop can tell it from a file of the computer. */
export const DRIVE_DRAG_TYPE = 'application/x-wings-drive-file';

export const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
      : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('pt-BR')} KB`;

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback;

// ---------------------------------------------------------------------------
// Icons: drawn, never emoji, and always decorative (the name is next to them)
// ---------------------------------------------------------------------------

const Svg = ({ children }: { children: ReactNode }) => (
  <svg
    className="drive-icon"
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);
export const FolderIcon = () => (
  <Svg>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);
export function FileIcon({ mimeType }: { mimeType: string }) {
  const kind = drivePreviewKind(mimeType);
  return (
    <Svg>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      {kind === 'image' && <path d="m8 17 3-3 2 2 2-2 1 1" />}
      {kind === 'video' && <path d="m10 12 4 2.5-4 2.5z" />}
      {kind === 'pdf' && <path d="M8.5 13h7M8.5 16h5" />}
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export function FolderTree({
  folders,
  currentId,
  onOpen,
  onDropFile,
  onDropComputerFiles,
}: {
  folders: DriveFolder[];
  currentId: string | null;
  onOpen: (folder: DriveFolder) => void;
  onDropFile: (fileId: string, folder: DriveFolder) => void;
  onDropComputerFiles: (files: File[], folder: DriveFolder) => void;
}) {
  const children = useMemo(() => {
    const map = new Map<string | null, DriveFolder[]>();
    for (const folder of folders) {
      map.set(folder.parentId, [...(map.get(folder.parentId) ?? []), folder]);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return map;
  }, [folders]);

  // Open down to where the person is; whatever they opened by hand stays open.
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    setOpen((before) => {
      const next = new Set(before);
      for (let at = currentId ? byId.get(currentId) : undefined; at;) {
        next.add(at.id);
        at = at.parentId ? byId.get(at.parentId) : undefined;
      }
      // Somebody with one department lands with the way down to it already open.
      for (const folder of folders) if (!folder.accessible) next.add(folder.id);
      return next;
    });
  }, [currentId, folders]);
  const [over, setOver] = useState<string | null>(null);

  const drop = (event: DragEvent, folder: DriveFolder) => {
    event.preventDefault();
    setOver(null);
    if (!folder.canWrite) return;
    const fileId = event.dataTransfer.getData(DRIVE_DRAG_TYPE);
    if (fileId) onDropFile(fileId, folder);
    else if (event.dataTransfer.files.length > 0) {
      onDropComputerFiles([...event.dataTransfer.files], folder);
    }
  };

  const branch = (parentId: string | null, depth: number): ReactNode => {
    const list = children.get(parentId) ?? [];
    if (list.length === 0) return null;
    return (
      <ul className="drive-tree-list" role={depth === 0 ? 'tree' : 'group'}>
        {list.map((folder) => {
          const has = (children.get(folder.id) ?? []).length > 0;
          const expanded = open.has(folder.id);
          return (
            <li key={folder.id} role="treeitem" aria-expanded={has ? expanded : undefined}>
              <div
                className={`drive-tree-row ${folder.id === currentId ? 'current' : ''} ${
                  over === folder.id ? 'over' : ''
                } ${folder.accessible ? '' : 'passage'}`}
                style={{ paddingLeft: 4 + depth * 14 }}
                onDragOver={(event) => {
                  if (!folder.canWrite) return;
                  event.preventDefault();
                  setOver(folder.id);
                }}
                onDragLeave={() => setOver((now) => (now === folder.id ? null : now))}
                onDrop={(event) => drop(event, folder)}
              >
                <button
                  type="button"
                  className="drive-tree-toggle"
                  aria-label={`${expanded ? 'Recolher' : 'Expandir'} ${folder.name}`}
                  disabled={!has}
                  onClick={() =>
                    setOpen((before) => {
                      const next = new Set(before);
                      if (next.has(folder.id)) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    })
                  }
                >
                  <span aria-hidden="true" className={`chevron ${expanded ? 'open' : ''}`}>
                    {has ? '›' : ''}
                  </span>
                </button>
                <button
                  type="button"
                  className="drive-tree-name"
                  aria-current={folder.id === currentId ? 'true' : undefined}
                  // A folder that is only on the way to yours has nothing to show.
                  disabled={!folder.accessible}
                  title={folder.accessible ? undefined : 'Você não tem acesso a esta pasta'}
                  onClick={() => onOpen(folder)}
                >
                  <FolderIcon />
                  <span>{folder.name}</span>
                </button>
              </div>
              {has && expanded && branch(folder.id, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <nav className="drive-tree" aria-label="Pastas">
      {branch(null, 0)}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

export function Dialog({
  label,
  onClose,
  children,
  wide = false,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const close = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="media-dialog-backdrop" onClick={onClose}>
      <div
        className={`media-dialog ${wide ? 'drive-dialog-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="media-dialog-head">
          <h3>{label}</h3>
          <button ref={close} type="button" className="link-button" onClick={onClose}>
            Fechar
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Asks for the address and then sends the browser to it: the download starts by itself. */
export async function download(file: DriveFile, version?: number) {
  const { url } = await driveLink(file.id, 'attachment', version);
  window.location.assign(url);
}

export function PreviewDialog({
  file,
  onClose,
  onMove,
  onTrash,
  onNewVersion,
}: {
  file: DriveFile;
  onClose: () => void;
  onMove: () => void;
  onTrash: () => void;
  onNewVersion: (picked: File) => void;
}) {
  const kind = drivePreviewKind(file.mimeType);
  const [link, setLink] = useState<DriveLink | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLink(null);
    setFailed(null);
    if (!kind) return;
    driveLink(file.id, 'inline')
      .then((next) => alive && setLink(next))
      .catch((error: unknown) => alive && setFailed(errorText(error, 'Não foi possível abrir.')));
    return () => {
      alive = false;
    };
  }, [file.id, file.version, kind]);

  const update = useUpdateFile();
  const versions = useDriveVersions(file.version > 1 ? file.id : null);
  const [name, setName] = useState(file.name);
  const [tags, setTags] = useState(file.tags.join(', '));
  useEffect(() => {
    setName(file.name);
    setTags(file.tags.join(', '));
  }, [file.id, file.name, file.tags]);

  return (
    <Dialog label={file.name} onClose={onClose} wide>
      <div className="drive-preview">
        {!kind && <p className="muted">Este tipo de arquivo não tem prévia. Baixe para abrir.</p>}
        {kind && failed && (
          <p className="field-error" role="alert">
            {failed}
          </p>
        )}
        {kind && !link && !failed && <p className="muted">Abrindo…</p>}
        {link && kind === 'image' && <img src={link.url} alt={file.name} />}
        {link && kind === 'video' && <video src={link.url} controls preload="metadata" />}
        {link && kind === 'pdf' && <iframe src={link.url} title={`Prévia de ${file.name}`} />}
      </div>

      <dl className="agent-card-facts">
        <div>
          <dt>Pasta</dt>
          <dd>{file.folderPath}</dd>
        </div>
        <div>
          <dt>Tamanho</dt>
          <dd>
            {formatBytes(file.byteSize)} · versão {file.version}
          </dd>
        </div>
        {file.clientName && (
          <div>
            <dt>Cliente</dt>
            <dd>{file.clientName}</dd>
          </div>
        )}
        <div>
          <dt>Enviado por</dt>
          <dd>
            {file.ownerName ?? '—'} em {formatDate(file.createdAt)}
          </dd>
        </div>
      </dl>

      {file.canWrite && !file.trashedAt && (
        <form
          className="media-filing"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate({
              id: file.id,
              ...(name.trim() !== file.name ? { name: name.trim() } : {}),
              tags: tags
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
            });
          }}
        >
          <label className="field">
            <span className="field-label">Nome</span>
            <input
              className="control"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Tags, separadas por vírgula</span>
            <input className="control" value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <Button type="submit" variant="ghost" disabled={update.isPending}>
            Salvar
          </Button>
          {update.isSuccess && (
            <span className="field-hint" role="status">
              Salvo.
            </span>
          )}
          {update.error && (
            <span className="field-error" role="alert">
              {errorText(update.error, 'Não foi possível salvar.')}
            </span>
          )}
        </form>
      )}

      {(versions.data?.versions.length ?? 0) > 0 && (
        <details className="agent-details">
          <summary>Versões anteriores</summary>
          <ul className="drive-versions">
            {versions.data?.versions.map((version) => (
              <li key={version.version}>
                <span>
                  Versão {version.version} · {formatBytes(version.byteSize)} · até{' '}
                  {formatDate(version.createdAt)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void download(file, version.version)}
                >
                  Baixar
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="media-actions">
        <Button type="button" onClick={() => void download(file)}>
          Baixar
        </Button>
        {file.canWrite && !file.trashedAt && (
          <>
            <label className="btn btn-ghost btn-inline media-upload">
              Enviar nova versão
              <input
                type="file"
                className="sr-only"
                onChange={(event) => {
                  const picked = event.target.files?.[0];
                  event.target.value = '';
                  if (picked) onNewVersion(picked);
                }}
              />
            </label>
            <Button type="button" variant="ghost" onClick={onMove}>
              Mover
            </Button>
            <Button type="button" variant="ghost" onClick={onTrash}>
              Mover para a lixeira
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Moving without dragging: the same move, for a keyboard, a touch screen or a long tree. */
export function MoveDialog({
  file,
  folders,
  onClose,
  onMove,
  error,
}: {
  file: DriveFile;
  folders: DriveFolder[];
  onClose: () => void;
  onMove: (folderId: string) => void;
  error: string | null;
}) {
  const targets = folders.filter((folder) => folder.canWrite && folder.id !== file.folderId);
  const [folderId, setFolderId] = useState(targets[0]?.id ?? '');
  return (
    <Dialog label={`Mover ${file.name}`} onClose={onClose}>
      <form
        className="drive-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (folderId) onMove(folderId);
        }}
      >
        <label className="field">
          <span className="field-label">Para a pasta</span>
          <select
            className="control"
            value={folderId}
            onChange={(event) => setFolderId(event.target.value)}
          >
            {targets.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.path}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!folderId}>
          Mover
        </Button>
      </form>
    </Dialog>
  );
}
