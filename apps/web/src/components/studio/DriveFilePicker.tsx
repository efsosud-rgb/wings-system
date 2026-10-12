import { STUDIO_PROJECT_SUFFIX, type DriveFile, type DriveFolder } from '@wings/shared';
import { useMemo, useState } from 'react';
import { useDriveFolder, useDriveTree } from '../../api/drive.js';
import { Dialog, FileIcon, FolderTree, formatBytes } from '../drive/DriveParts.js';
import { LoadFailure } from '../LoadFailure.js';

/** What the editor can put on the timeline. Anything else is listed greyed out. */
export type StudioFileKind = 'video' | 'image' | 'audio' | 'subtitle' | 'project';

export function studioKindOf(file: Pick<DriveFile, 'name' | 'mimeType'>): StudioFileKind | null {
  if (file.name.endsWith(STUDIO_PROJECT_SUFFIX)) return 'project';
  if (/^video\/(mp4|webm|quicktime)$/.test(file.mimeType)) return 'video';
  if (/^image\/(png|jpeg|webp|gif|avif|svg\+xml)$/.test(file.mimeType)) return 'image';
  if (/^audio\/(mpeg|mp4|aac|wav|x-wav|ogg|webm)$/.test(file.mimeType)) return 'audio';
  if (/\.(srt|vtt)$/i.test(file.name)) return 'subtitle';
  return null;
}

const KIND_LABEL: Record<StudioFileKind, string> = {
  video: 'vídeo',
  image: 'imagem',
  audio: 'áudio',
  subtitle: 'legenda',
  project: 'projeto',
};

/**
 * A Drive file, chosen from the person's own tree. The API decides what is
 * listed; here only the kinds the editor can use are clickable.
 */
export function DriveFilePicker({
  label,
  accept,
  initialFolderId,
  onPick,
  onClose,
}: {
  label: string;
  accept: readonly StudioFileKind[];
  initialFolderId: string | null;
  onPick: (file: DriveFile, folder: DriveFolder) => void;
  onClose: () => void;
}) {
  const tree = useDriveTree();
  const folders = useMemo(() => tree.data?.folders ?? [], [tree.data]);
  const firstAccessible = folders.find((folder) => folder.accessible)?.id ?? null;
  const [folderId, setFolderId] = useState<string | null>(initialFolderId);
  const currentId = folderId ?? firstAccessible;
  const listing = useDriveFolder(currentId);
  const files = listing.data?.files ?? [];

  return (
    <Dialog label={label} onClose={onClose} wide>
      <div className="studio-picker">
        <div className="studio-picker-tree">
          <FolderTree
            folders={folders}
            currentId={currentId}
            onOpen={(folder) => setFolderId(folder.id)}
            onDropFile={() => undefined}
            onDropComputerFiles={() => undefined}
          />
        </div>
        <div className="studio-picker-files">
          {tree.isError && (
            <LoadFailure
              what="as pastas do Drive"
              error={tree.error}
              onRetry={() => void tree.refetch()}
            />
          )}
          {listing.isError && (
            <LoadFailure
              what="os arquivos desta pasta"
              error={listing.error}
              onRetry={() => void listing.refetch()}
            />
          )}
          {(tree.isLoading || listing.isLoading) && <p className="muted">Carregando…</p>}
          {listing.isSuccess && files.length === 0 && <p className="muted">Pasta vazia.</p>}
          <ul className="studio-picker-list">
            {files.map((file) => {
              const kind = studioKindOf(file);
              const usable = kind !== null && accept.includes(kind);
              return (
                <li key={file.id}>
                  <button
                    type="button"
                    className="studio-picker-row"
                    disabled={!usable}
                    onClick={() => {
                      if (listing.data) onPick(file, listing.data.folder);
                    }}
                  >
                    <FileIcon mimeType={file.mimeType} />
                    <span className="studio-picker-name">{file.name}</span>
                    <span className="muted">
                      {kind ? KIND_LABEL[kind] : '—'} · {formatBytes(file.byteSize)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}
