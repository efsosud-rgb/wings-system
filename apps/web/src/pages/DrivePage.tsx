import { DRIVE_TRASH_DAYS, type DriveFolder } from '@wings/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import {
  NameTakenError,
  isSearching,
  sendFile,
  useCreateFolder,
  useDeleteFolder,
  useDriveFolder,
  useDriveSearch,
  useDriveTrash,
  useDriveTree,
  usePurgeFile,
  useRestoreFile,
  useTrashFile,
  useUpdateFile,
  useUpdateFolder,
  type DriveSearch,
} from '../api/drive.js';
import {
  DRIVE_DRAG_TYPE,
  Dialog,
  FileIcon,
  FolderIcon,
  FolderTree,
  MoveDialog,
  PreviewDialog,
  download,
  errorText,
  formatBytes,
  formatDate,
} from '../components/drive/DriveParts.js';
import { LoadFailure } from '../components/LoadFailure.js';
import { ClientSelect } from '../components/media-studio/MediaLibrary.js';
import { Alert, Button } from '../components/ui.js';
import { ProjectSummary } from '../components/projects/ProjectParts.js';
import { PageHeader } from '../components/PageHeader.js';

/**
 * The Drive. The tree on the left is what the server says this person may see;
 * on the right, the folder they are in. Files go from the browser straight to
 * storage, several at a time, each with its own progress.
 */

interface Sending {
  id: number;
  folderId: string;
  file: File;
  replaceFileId?: string;
  progress: number;
  state: 'waiting' | 'sending' | 'done' | 'failed' | 'conflict';
  message?: string;
  existingFileId?: string;
}

const VIEW_KEY = 'wings.drive.view';
const PARALLEL = 3;

/** "Relatório.pdf" → "Relatório (2).pdf": for keeping both when the name is taken. */
function numbered(name: string): string {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const match = / \((\d+)\)$/.exec(stem);
  return match
    ? `${stem.slice(0, match.index)} (${Number(match[1]) + 1})${ext}`
    : `${stem} (2)${ext}`;
}

export function DrivePage() {
  const { data: user } = useSession();
  const canManage = hasPermission(user ?? null, 'drive.manage');
  const queryClient = useQueryClient();
  const tree = useDriveTree();
  const folders = useMemo(() => tree.data?.folders ?? [], [tree.data]);
  const maxFileBytes = tree.data?.maxFileBytes ?? Infinity;

  const [params, setParams] = useSearchParams();
  const wanted = params.get('pasta');
  const inTrash = params.get('ver') === 'lixeira';
  // The folder in the address, or the first one this person works in.
  const current =
    folders.find((folder) => folder.id === wanted && folder.accessible) ??
    folders.find((folder) => folder.accessible) ??
    null;
  const open = useCallback((folder: DriveFolder) => setParams({ pasta: folder.id }), [setParams]);

  const [search, setSearch] = useState<DriveSearch>({});
  const searching = isSearching(search) && !inTrash;
  const listing = useDriveFolder(!inTrash && !searching ? (current?.id ?? null) : null);
  const found = useDriveSearch(searching ? search : {});
  const trash = useDriveTrash(inTrash);
  const files = inTrash
    ? (trash.data?.files ?? [])
    : searching
      ? (found.data?.files ?? [])
      : (listing.data?.files ?? []);
  const subfolders = useMemo(
    () =>
      inTrash || searching || !current
        ? []
        : folders
            .filter((folder) => folder.parentId === current.id)
            .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    [folders, current, inTrash, searching],
  );
  const loading = tree.isLoading || listing.isLoading || found.isLoading || trash.isLoading;
  // A failed request is not an empty folder. The query behind the files on screen, and the
  // tree behind the folders: with no earlier answer the files are unknown ("—"); after a
  // failed refresh what was there stays, with the failure line above it.
  const filesQuery = inTrash ? trash : searching ? found : listing;
  const failed = tree.isError ? tree : filesQuery.isError ? filesQuery : null;
  // Without the tree there is no folder to list; the trash and the search do not need it.
  const filesUnknown =
    (!inTrash && !searching && tree.isError && !tree.data) ||
    (filesQuery.isError && !filesQuery.data);

  const [view, setView] = useState<'list' | 'grid'>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';
    } catch {
      return 'list';
    }
  });
  const chooseView = (next: 'list' | 'grid') => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Without localStorage the choice lasts for this visit.
    }
  };

  // -------------------------------------------------------------------------
  // Sending files
  // -------------------------------------------------------------------------

  const [queue, setQueue] = useState<Sending[]>([]);
  const nextId = useRef(1);
  const patch = (id: number, changes: Partial<Sending>) =>
    setQueue((before) => before.map((item) => (item.id === id ? { ...item, ...changes } : item)));

  const enqueue = useCallback(
    (picked: File[], folderId: string, replaceFileId?: string) => {
      setQueue((before) => [
        ...before,
        ...picked.map((file): Sending =>
          file.size > maxFileBytes
            ? {
                id: nextId.current++,
                folderId,
                file,
                progress: 0,
                state: 'failed',
                message: `Passa do limite de ${formatBytes(maxFileBytes)} por arquivo.`,
              }
            : {
                id: nextId.current++,
                folderId,
                file,
                replaceFileId,
                progress: 0,
                state: 'waiting',
              },
        ),
      ]);
    },
    [maxFileBytes],
  );

  // A few at a time: enough to be quick, not so many that each one crawls.
  useEffect(() => {
    const active = queue.filter((item) => item.state === 'sending').length;
    const next = queue.find((item) => item.state === 'waiting');
    if (!next || active >= PARALLEL) return;
    patch(next.id, { state: 'sending' });
    sendFile({
      folderId: next.folderId,
      file: next.file,
      replaceFileId: next.replaceFileId,
      onProgress: (progress) => patch(next.id, { progress }),
    })
      .then(() => {
        patch(next.id, { state: 'done', progress: 1 });
        void queryClient.invalidateQueries({ queryKey: ['drive'] });
      })
      .catch((error: unknown) =>
        error instanceof NameTakenError
          ? patch(next.id, { state: 'conflict', existingFileId: error.existingFileId })
          : patch(next.id, { state: 'failed', message: errorText(error, 'O envio falhou.') }),
      );
  }, [queue, queryClient]);

  const [dropping, setDropping] = useState(false);
  const onDropHere = (event: DragEvent) => {
    event.preventDefault();
    setDropping(false);
    if (current?.canWrite && event.dataTransfer.files.length > 0) {
      enqueue([...event.dataTransfer.files], current.id);
    }
  };

  // -------------------------------------------------------------------------
  // Acting on files and folders
  // -------------------------------------------------------------------------

  const updateFile = useUpdateFile();
  const trashFile = useTrashFile();
  const restoreFile = useRestoreFile();
  const purgeFile = usePurgeFile();
  const createFolder = useCreateFolder();
  const updateFolder = useUpdateFolder();
  const deleteFolder = useDeleteFolder();

  const [previewId, setPreviewId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [naming, setNaming] = useState<{ mode: 'new' | 'rename'; value: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const preview = files.find((file) => file.id === previewId) ?? null;
  const moving = files.find((file) => file.id === movingId) ?? null;

  const move = (fileId: string, folder: Pick<DriveFolder, 'id' | 'path'>) =>
    updateFile.mutate(
      { id: fileId, folderId: folder.id },
      {
        onSuccess: () => {
          setMovingId(null);
          setPreviewId(null);
          setNotice(`Movido para ${folder.path}.`);
        },
        onError: (error) => setNotice(errorText(error, 'Não foi possível mover.')),
      },
    );

  const crumbs = useMemo(() => {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const list: DriveFolder[] = [];
    for (let at = current ?? undefined; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
      list.unshift(at);
    }
    return list;
  }, [folders, current]);

  const failedWhat = tree.isError
    ? 'as pastas do Drive'
    : inTrash
      ? 'a lixeira'
      : searching
        ? 'a busca'
        : 'os arquivos desta pasta';

  return (
    <>
      <PageHeader
        title="Drive"
        subtitle="Pastas e arquivos por departamento e cliente."
        actions={
          <Button
            type="button"
            variant="ghost"
            aria-pressed={inTrash}
            onClick={() =>
              setParams(inTrash ? (current ? { pasta: current.id } : {}) : { ver: 'lixeira' })
            }
          >
            {inTrash ? 'Voltar às pastas' : 'Lixeira'}
          </Button>
        }
      />

      {tree.data && !tree.data.storageAvailable && (
        <Alert kind="error">O armazenamento de arquivos não está configurado neste ambiente.</Alert>
      )}
      {failed && (
        <LoadFailure what={failedWhat} error={failed.error} onRetry={() => void failed.refetch()} />
      )}
      {!tree.isLoading && folders.length === 0 && !tree.isError && (
        <Alert kind="info">Nenhuma pasta do Drive está liberada para o seu perfil.</Alert>
      )}

      <div className="drive">
        <FolderTree
          folders={folders}
          currentId={inTrash ? null : (current?.id ?? null)}
          onOpen={open}
          onDropFile={(fileId, folder) => move(fileId, folder)}
          onDropComputerFiles={(picked, folder) => enqueue(picked, folder.id)}
        />

        <section
          className={`drive-main ${dropping ? 'dropping' : ''}`}
          aria-label={inTrash ? 'Lixeira' : 'Arquivos'}
          onDragOver={(event) => {
            if (inTrash || !current?.canWrite || !event.dataTransfer.types.includes('Files'))
              return;
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={onDropHere}
        >
          {inTrash ? (
            <p className="drive-crumbs">
              Lixeira. Os arquivos ficam aqui por {DRIVE_TRASH_DAYS} dias e depois são apagados.
            </p>
          ) : (
            <nav className="drive-crumbs" aria-label="Caminho">
              <ol>
                {crumbs.map((folder, index) => (
                  <li key={folder.id}>
                    {index === crumbs.length - 1 ? (
                      <span aria-current="page">{folder.name}</span>
                    ) : folder.accessible ? (
                      <button type="button" className="link-button" onClick={() => open(folder)}>
                        {folder.name}
                      </button>
                    ) : (
                      <span className="muted">{folder.name}</span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
          )}
          {!inTrash && current?.clientId && hasPermission(user ?? null, 'projects.read') && (
            <ProjectSummary clientId={current.clientId} slot={current.slot} />
          )}

          {!inTrash && (
            <div className="drive-toolbar">
              <div className="media-filters" role="search" aria-label="Busca no Drive">
                <label className="field">
                  <span className="field-label">Busca</span>
                  <input
                    className="control"
                    type="search"
                    placeholder="Nome do arquivo"
                    value={search.q ?? ''}
                    onChange={(e) => setSearch({ ...search, q: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Cliente</span>
                  <ClientSelect
                    value={search.clientId ?? ''}
                    onChange={(clientId) =>
                      setSearch({ ...search, clientId: clientId || undefined })
                    }
                    allLabel="Todos"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Tag</span>
                  <input
                    className="control"
                    value={search.tag ?? ''}
                    onChange={(e) => setSearch({ ...search, tag: e.target.value })}
                  />
                </label>
              </div>
              <div className="drive-toolbar-actions">
                <div className="drive-view" role="group" aria-label="Exibição">
                  {(['list', 'grid'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`btn btn-ghost ${view === mode ? 'active' : ''}`}
                      aria-pressed={view === mode}
                      onClick={() => chooseView(mode)}
                    >
                      {mode === 'list' ? 'Lista' : 'Grade'}
                    </button>
                  ))}
                </div>
                {current?.canWrite && !searching && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setNaming({ mode: 'new', value: '' })}
                    >
                      Nova pasta
                    </Button>
                    <label className="btn btn-primary btn-inline media-upload">
                      Enviar arquivos
                      <input
                        type="file"
                        multiple
                        className="sr-only"
                        onChange={(event) => {
                          enqueue([...(event.target.files ?? [])], current.id);
                          event.target.value = '';
                        }}
                      />
                    </label>
                  </>
                )}
              </div>
            </div>
          )}

          {current && !current.managed && current.canWrite && !inTrash && !searching && (
            <p className="drive-folder-actions">
              <button
                type="button"
                className="link-button"
                onClick={() => setNaming({ mode: 'rename', value: current.name })}
              >
                Renomear esta pasta
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  deleteFolder.mutate(current.id, {
                    onSuccess: () => setNotice('Pasta excluída.'),
                    onError: (error) => setNotice(errorText(error, 'Não foi possível excluir.')),
                  })
                }
              >
                Excluir esta pasta
              </button>
            </p>
          )}

          {notice && (
            <p className="field-hint" role="status">
              {notice}
            </p>
          )}
          {searching && (
            <p className="field-hint" role="status">
              {found.isLoading
                ? 'Buscando…'
                : found.isError && !found.data
                  ? '—'
                  : `${files.length} ${files.length === 1 ? 'arquivo encontrado' : 'arquivos encontrados'} nas pastas que você acessa.`}
            </p>
          )}

          {view === 'grid' && !inTrash ? (
            <ul className="drive-grid">
              {subfolders.map((folder) => (
                <li key={folder.id}>
                  <button type="button" className="drive-tile" onClick={() => open(folder)}>
                    <span className="drive-tile-art">
                      <FolderIcon />
                    </span>
                    <span className="drive-tile-name">{folder.name}</span>
                  </button>
                </li>
              ))}
              {files.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    className="drive-tile"
                    draggable={file.canWrite}
                    onDragStart={(event) => event.dataTransfer.setData(DRIVE_DRAG_TYPE, file.id)}
                    onClick={() => setPreviewId(file.id)}
                  >
                    <span className="drive-tile-art">
                      <FileIcon mimeType={file.mimeType} />
                    </span>
                    <span className="drive-tile-name">{file.name}</span>
                    <span className="cell-sub">{formatBytes(file.byteSize)}</span>
                  </button>
                </li>
              ))}
              {filesUnknown && (
                <li className="muted" aria-label="Arquivos indisponíveis">
                  —
                </li>
              )}
            </ul>
          ) : (
            <div className="table-wrap">
              <table className="table drive-table">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>{inTrash ? 'Apagado em' : 'Alterado em'}</th>
                    <th>Tamanho</th>
                    <th>
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {subfolders.map((folder) => (
                    <tr key={folder.id}>
                      <td colSpan={4}>
                        <button type="button" className="drive-name" onClick={() => open(folder)}>
                          <FolderIcon />
                          <span>{folder.name}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                  {files.map((file) => (
                    <tr
                      key={file.id}
                      draggable={file.canWrite && !inTrash}
                      onDragStart={(event) => event.dataTransfer.setData(DRIVE_DRAG_TYPE, file.id)}
                    >
                      <td>
                        <button
                          type="button"
                          className="drive-name"
                          onClick={() => setPreviewId(file.id)}
                        >
                          <FileIcon mimeType={file.mimeType} />
                          <span>{file.name}</span>
                        </button>
                        {(searching || inTrash) && (
                          <div className="cell-sub">{file.folderPath}</div>
                        )}
                        {file.tags.length > 0 && (
                          <div className="cell-sub">
                            {file.tags.map((tag) => (
                              <span key={tag} className="tag">
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="muted">
                        {formatDate(file.trashedAt ?? file.updatedAt)}
                        {file.purgeAt && (
                          <div className="cell-sub">some em {formatDate(file.purgeAt)}</div>
                        )}
                      </td>
                      <td className="muted">{formatBytes(file.byteSize)}</td>
                      <td>
                        <div className="drive-row-actions">
                          {inTrash ? (
                            <>
                              {file.canWrite && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  onClick={() => restoreFile.mutate(file.id)}
                                >
                                  Restaurar
                                </Button>
                              )}
                              {canManage && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  onClick={() => purgeFile.mutate(file.id)}
                                >
                                  Apagar de vez
                                </Button>
                              )}
                            </>
                          ) : (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                aria-label={`Baixar ${file.name}`}
                                onClick={() => void download(file)}
                              >
                                Baixar
                              </Button>
                              {file.canWrite && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  aria-label={`Mover ${file.name}`}
                                  onClick={() => setMovingId(file.id)}
                                >
                                  Mover
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filesUnknown && (
                    <tr>
                      <td colSpan={4} className="muted" aria-label="Arquivos indisponíveis">
                        —
                      </td>
                    </tr>
                  )}
                  {!loading && !filesUnknown && files.length === 0 && subfolders.length === 0 && (
                    <tr>
                      <td colSpan={4} className="muted">
                        {inTrash
                          ? 'A lixeira está vazia.'
                          : searching
                            ? 'Nada encontrado.'
                            : current?.canWrite
                              ? 'Pasta vazia. Arraste arquivos para cá ou use "Enviar arquivos".'
                              : 'Pasta vazia.'}
                      </td>
                    </tr>
                  )}
                  {loading && (
                    <tr>
                      <td colSpan={4} className="muted">
                        Carregando…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {queue.length > 0 && (
        <aside className="drive-queue" aria-label="Envios">
          <div className="drive-queue-head">
            <strong>
              Envios: {queue.filter((item) => item.state === 'done').length} de {queue.length}
            </strong>
            <button
              type="button"
              className="link-button"
              onClick={() =>
                setQueue((before) =>
                  before.filter((item) => item.state === 'sending' || item.state === 'waiting'),
                )
              }
            >
              Limpar concluídos
            </button>
          </div>
          <ul>
            {queue.map((item) => (
              <li key={item.id}>
                <span className="drive-queue-name">{item.file.name}</span>
                {item.state === 'conflict' ? (
                  <div className="drive-queue-conflict" role="alert">
                    <span>Já existe um arquivo com este nome nesta pasta.</span>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        patch(item.id, { state: 'waiting', replaceFileId: item.existingFileId })
                      }
                    >
                      Substituir (nova versão)
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        patch(item.id, {
                          state: 'waiting',
                          file: new File([item.file], numbered(item.file.name), {
                            type: item.file.type,
                          }),
                        })
                      }
                    >
                      Manter os dois
                    </Button>
                  </div>
                ) : item.state === 'failed' ? (
                  <span className="field-error" role="alert">
                    {item.message}
                  </span>
                ) : (
                  <div
                    className="drive-progress"
                    role="progressbar"
                    aria-label={`Envio de ${item.file.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(item.progress * 100)}
                  >
                    <span style={{ transform: `scaleX(${item.progress})` }} />
                    <em>
                      {item.state === 'done'
                        ? 'Enviado'
                        : item.state === 'waiting'
                          ? 'Na fila'
                          : item.progress >= 1
                            ? 'Conferindo…'
                            : `${Math.round(item.progress * 100)}%`}
                    </em>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </aside>
      )}

      {preview && (
        <PreviewDialog
          file={preview}
          onClose={() => setPreviewId(null)}
          onMove={() => setMovingId(preview.id)}
          onTrash={() =>
            trashFile.mutate(preview.id, {
              onSuccess: () => {
                setPreviewId(null);
                setNotice('Movido para a lixeira.');
              },
            })
          }
          onNewVersion={(picked) => {
            enqueue([picked], preview.folderId, preview.id);
            setPreviewId(null);
          }}
        />
      )}
      {moving && (
        <MoveDialog
          file={moving}
          folders={folders}
          onClose={() => setMovingId(null)}
          onMove={(folderId) => {
            const target = folders.find((folder) => folder.id === folderId);
            if (target) move(moving.id, target);
          }}
          error={updateFile.error ? errorText(updateFile.error, 'Não foi possível mover.') : null}
        />
      )}
      {naming && current && (
        <Dialog
          label={naming.mode === 'new' ? `Nova pasta em ${current.name}` : 'Renomear pasta'}
          onClose={() => setNaming(null)}
        >
          <form
            className="drive-form"
            onSubmit={(event) => {
              event.preventDefault();
              const done = { onSuccess: () => setNaming(null) };
              if (naming.mode === 'new') {
                createFolder.mutate({ parentId: current.id, name: naming.value }, done);
              } else updateFolder.mutate({ id: current.id, name: naming.value }, done);
            }}
          >
            <label className="field">
              <span className="field-label">Nome da pasta</span>
              <input
                className="control"
                autoFocus
                maxLength={120}
                value={naming.value}
                onChange={(event) => setNaming({ ...naming, value: event.target.value })}
              />
            </label>
            {(createFolder.error ?? updateFolder.error) && (
              <p className="field-error" role="alert">
                {errorText(createFolder.error ?? updateFolder.error, 'Não foi possível salvar.')}
              </p>
            )}
            <Button type="submit" disabled={naming.value.trim() === ''}>
              Salvar
            </Button>
          </form>
        </Dialog>
      )}
    </>
  );
}

/** Exposed for the test of "keep both". */
export const numberedName = numbered;
