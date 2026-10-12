import type { DriveFile, DriveFolder, MediaAsset } from '@wings/shared';
import { useMemo, useState } from 'react';
import { useDriveFolder, useDriveSearch, useDriveTree } from '../../../../api/drive.js';
import { useMediaAssets, type MediaAssetFilters } from '../../../../api/media.js';
import { FileIcon, FolderTree, formatBytes } from '../../../drive/DriveParts.js';
import { LoadFailure } from '../../../LoadFailure.js';
import { ClientSelect, MediaThumb, describeAsset } from '../../../media-studio/MediaLibrary.js';
import { Input } from '../../../ui.js';
import { studioKindOf } from '../../DriveFilePicker.js';
import type { StudioSession } from '../../session.js';
import { driveFileIdOf, setDragItem } from '../drag.js';

/**
 * Two ways in: the media library (what was generated or sent here) and the
 * Drive itself. A tile is dragged onto the stage or added with a click; both
 * end in the same session call, so the project rule holds either way.
 */

const KINDS = [
  { value: '', label: 'Tudo' },
  { value: 'image', label: 'Imagens' },
  { value: 'video', label: 'Vídeos' },
] as const;

function LibraryTab({ session }: { session: StudioSession }) {
  const [filters, setFilters] = useState<MediaAssetFilters>({});
  const assets = useMediaAssets(filters);
  const list = assets.data?.assets ?? [];
  const ready = session.status === 'ready' && session.busy === null;

  return (
    <>
      <div className="ws-filters">
        <Input
          type="search"
          placeholder="Buscar pelo prompt ou pela tag"
          aria-label="Buscar na biblioteca"
          value={filters.q ?? ''}
          onChange={(event) => setFilters({ ...filters, q: event.target.value || undefined })}
        />
        <select
          className="control"
          aria-label="Tipo"
          value={filters.kind ?? ''}
          onChange={(event) =>
            setFilters({
              ...filters,
              kind: (event.target.value || undefined) as MediaAssetFilters['kind'],
            })
          }
        >
          {KINDS.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>
        <ClientSelect
          value={filters.clientId ?? ''}
          allLabel="Todos os clientes"
          onChange={(clientId) => setFilters({ ...filters, clientId: clientId || undefined })}
        />
      </div>
      {assets.isError && (
        <LoadFailure
          what="a biblioteca"
          error={assets.error}
          onRetry={() => void assets.refetch()}
        />
      )}
      {assets.isLoading ? (
        <p className="muted" role="status">
          Carregando a biblioteca…
        </p>
      ) : list.length === 0 ? (
        // Empty only when the request answered; a failed one has its own line above.
        assets.isError ? null : (
          <p className="ws-empty">
            Nada na biblioteca com esses filtros. Gere uma imagem no painel ao lado ou envie um
            arquivo pelo Drive.
          </p>
        )
      ) : (
        <ul className="ws-tiles">
          {list.map((asset) => {
            const inDrive = driveFileIdOf(asset) !== null;
            return (
              <li key={asset.id}>
                <div
                  className={`ws-tile${inDrive ? '' : ' ws-tile-off'}`}
                  draggable={inDrive}
                  onDragStart={(event) => setDragItem(event, { kind: 'media-asset', asset })}
                  aria-label={describeAsset(asset)}
                >
                  <MediaThumb asset={asset} />
                  <span className="ws-tile-caption">
                    {asset.kind === 'video'
                      ? 'Vídeo'
                      : asset.aspect === 'other'
                        ? 'Imagem'
                        : asset.aspect}
                  </span>
                  {inDrive ? (
                    <button
                      type="button"
                      className="ws-tile-add"
                      disabled={!ready}
                      onClick={() => void session.addMediaAsset(asset)}
                    >
                      Adicionar
                    </button>
                  ) : (
                    <span className="ws-tile-note">sem arquivo no Drive</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

const USABLE = new Set(['video', 'image', 'audio', 'subtitle']);

export function DriveBrowser({
  session,
  accept = USABLE,
  onAdd,
}: {
  session: StudioSession;
  accept?: Set<string>;
  onAdd?: (file: DriveFile, folder: DriveFolder | null) => void;
}) {
  const tree = useDriveTree();
  const folders = useMemo(() => tree.data?.folders ?? [], [tree.data]);
  const firstAccessible = folders.find((folder) => folder.accessible)?.id ?? null;
  const [folderId, setFolderId] = useState<string | null>(session.lastFolder?.id ?? null);
  const [query, setQuery] = useState('');
  const currentId = folderId ?? firstAccessible;
  const listing = useDriveFolder(currentId);
  const search = useDriveSearch({ q: query });
  const searching = query.trim() !== '';
  const active = searching ? search : listing;
  // The tree is what the folder view stands on; the search does not need it.
  const failed = !searching && tree.isError ? tree : active.isError ? active : null;
  const files = searching ? (search.data?.files ?? []) : (listing.data?.files ?? []);
  const folder = searching ? null : (listing.data?.folder ?? null);
  const ready = session.status === 'ready' && session.busy === null;
  const add = onAdd ?? ((file, from) => void session.addDriveFile(file, from));

  return (
    <>
      <Input
        type="search"
        placeholder="Buscar no Drive pelo nome"
        aria-label="Buscar no Drive"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {!searching && (
        <div className="ws-tree">
          <FolderTree
            folders={folders}
            currentId={currentId}
            onOpen={(item) => setFolderId(item.id)}
            onDropFile={() => undefined}
            onDropComputerFiles={() => undefined}
          />
        </div>
      )}
      {failed && (
        <LoadFailure
          what={
            !searching && tree.isError
              ? 'as pastas do Drive'
              : searching
                ? 'a busca'
                : 'os arquivos desta pasta'
          }
          error={failed.error}
          onRetry={() => void failed.refetch()}
        />
      )}
      {(searching ? search.isLoading : listing.isLoading || tree.isLoading) && (
        <p className="muted" role="status">
          Carregando…
        </p>
      )}
      {files.length === 0 &&
        !failed &&
        !(searching ? search.isLoading : listing.isLoading || tree.isLoading) && (
          <p className="ws-empty">
            {searching
              ? 'Nenhum arquivo com esse nome.'
              : 'Pasta vazia. Envie arquivos pelo Drive para vê-los aqui.'}
          </p>
        )}
      <ul className="ws-files">
        {files.map((file) => {
          const kind = studioKindOf(file);
          const usable = kind !== null && accept.has(kind);
          return (
            <li key={file.id}>
              <button
                type="button"
                className="ws-file"
                disabled={!usable || !ready}
                draggable={usable}
                onDragStart={(event) => setDragItem(event, { kind: 'drive-file', file, folder })}
                onClick={() => add(file, folder)}
                title={
                  usable
                    ? 'Adicionar à tela (ou arraste)'
                    : 'O editor não abre este tipo de arquivo'
                }
              >
                <FileIcon mimeType={file.mimeType} />
                <span className="ws-file-name">{file.name}</span>
                <span className="muted">{formatBytes(file.byteSize)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function LibraryPanel({ session }: { session: StudioSession }) {
  const [tab, setTab] = useState<'library' | 'drive'>('library');
  return (
    <>
      <div className="ws-tabs" role="tablist" aria-label="Origem">
        {(['library', 'drive'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`ws-tab${tab === key ? ' ws-tab-on' : ''}`}
            onClick={() => setTab(key)}
          >
            {key === 'library' ? 'Biblioteca' : 'Drive'}
          </button>
        ))}
      </div>
      {tab === 'library' ? <LibraryTab session={session} /> : <DriveBrowser session={session} />}
    </>
  );
}

export type { MediaAsset };
