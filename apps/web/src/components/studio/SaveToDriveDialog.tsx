import type { DriveFolder } from '@wings/shared';
import { useMemo, useState, type ReactNode } from 'react';
import { useDriveTree } from '../../api/drive.js';
import { Dialog, FolderTree } from '../drive/DriveParts.js';
import { LoadFailure } from '../LoadFailure.js';
import { Button, Field, Input } from '../ui.js';

/**
 * Where in the Drive, and under what name. The tree is the person's own; a
 * folder they cannot write in is shown but not chosen. `replaceName` is the
 * file the result may go on top of, as a new version.
 */
export function SaveToDriveDialog({
  label,
  defaultName,
  defaultFolderId,
  replace,
  hint,
  actions,
  onClose,
}: {
  label: string;
  defaultName: string;
  defaultFolderId: string | null;
  /** A file to put a new version on; the person may still choose a new file instead. */
  replace: { id: string; name: string; folderId: string } | null;
  hint?: ReactNode;
  /** Buttons for what to do with the choice; each gets the folder, name and (maybe) the file to replace. */
  actions: {
    label: string;
    primary?: boolean;
    disabled?: boolean;
    run: (choice: { folder: DriveFolder; name: string; replaceFileId?: string }) => void;
  }[];
  onClose: () => void;
}) {
  const tree = useDriveTree();
  const folders = useMemo(() => tree.data?.folders ?? [], [tree.data]);
  const [folderId, setFolderId] = useState<string | null>(defaultFolderId);
  const [name, setName] = useState(defaultName);
  const [asVersion, setAsVersion] = useState(replace !== null);
  const folder = folders.find((item) => item.id === folderId) ?? null;
  const replacing = asVersion && replace && replace.folderId === folder?.id ? replace : null;
  const ready =
    folder !== null && folder.canWrite && (replacing !== null || name.trim().length > 0);

  return (
    <Dialog label={label} onClose={onClose} wide>
      <div className="studio-save">
        <div className="studio-picker-tree">
          <FolderTree
            folders={folders}
            currentId={folderId}
            onOpen={(item) => setFolderId(item.id)}
            onDropFile={() => undefined}
            onDropComputerFiles={() => undefined}
          />
        </div>
        <div className="studio-save-form">
          {tree.isError && (
            <LoadFailure
              what="as pastas do Drive"
              error={tree.error}
              onRetry={() => void tree.refetch()}
            />
          )}
          <p className="muted">
            Pasta: <strong>{folder ? folder.path : 'escolha uma pasta'}</strong>
            {folder && !folder.canWrite && ' (sem permissão de escrita)'}
          </p>
          {replace && replace.folderId === folder?.id && (
            <label className="field-hint">
              <input
                type="checkbox"
                checked={asVersion}
                onChange={(event) => setAsVersion(event.target.checked)}
              />{' '}
              Salvar como nova versão de <strong>{replace.name}</strong>
            </label>
          )}
          {!replacing && (
            <Field label="Nome do arquivo">
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
          )}
          {hint}
          <div className="studio-save-actions">
            {actions.map((action) => (
              <Button
                key={action.label}
                type="button"
                variant={action.primary ? 'primary' : 'ghost'}
                disabled={!ready || action.disabled}
                onClick={() => {
                  if (!folder) return;
                  action.run({
                    folder,
                    name: replacing ? replacing.name : name.trim(),
                    replaceFileId: replacing?.id,
                  });
                }}
              >
                {action.label}
              </Button>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
