import type { DriveFile, DriveFolder } from '@wings/shared';
import { useMemo, useState } from 'react';
import { sendFile, useDriveSearch, useDriveTree } from '../../../../api/drive.js';
import { failureReason } from '../../../../lib/failure.js';
import { errorText } from '../../../drive/DriveParts.js';
import { LoadFailure } from '../../../LoadFailure.js';
import { Button } from '../../../ui.js';
import type { ShapeKind, StudioSession } from '../../session.js';

/**
 * Logos and shapes. A logo is a Drive file like any other clip, so the Wings
 * marks are put in the Drive once (from the app's own brand folder) and cited
 * by id from then on; the project never carries an address.
 */

const WINGS_MARKS = [
  { path: '/brand/wings-logo.png', name: 'wings-logo.png' },
  { path: '/brand/wings-logo-mark.png', name: 'wings-logo-mark.png' },
];

const SHAPES: { kind: ShapeKind; label: string }[] = [
  { kind: 'rect', label: 'Retângulo' },
  { kind: 'circle', label: 'Círculo' },
  { kind: 'line', label: 'Linha' },
];

function LogoList({
  files,
  session,
  emptyText,
}: {
  files: DriveFile[];
  session: StudioSession;
  emptyText: string;
}) {
  const ready = session.status === 'ready' && session.busy === null;
  if (files.length === 0) return <p className="ws-empty">{emptyText}</p>;
  return (
    <ul className="ws-files">
      {files.map((file) => (
        <li key={file.id}>
          <button
            type="button"
            className="ws-file"
            disabled={!ready}
            onClick={() => void session.addLogo(file, null)}
          >
            <span className="ws-file-name">{file.name}</span>
            <span className="muted">adicionar</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ElementsPanel({ session }: { session: StudioSession }) {
  const ready = session.status === 'ready' && session.busy === null;
  const tree = useDriveTree();
  const wings = useDriveSearch({ q: 'wings-logo' });
  const client = useDriveSearch(session.clientId ? { clientId: session.clientId, q: 'logo' } : {});
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [color, setColor] = useState('#e95228');

  const wingsFiles = useMemo(
    () => (wings.data?.files ?? []).filter((file) => /^image\//.test(file.mimeType)),
    [wings.data],
  );
  const clientFiles = useMemo(
    () => (client.data?.files ?? []).filter((file) => /^image\//.test(file.mimeType)),
    [client.data],
  );
  /** The first Marketing folder the person can write in: where the marks are kept. */
  const marketingFolder: DriveFolder | null =
    (tree.data?.folders ?? []).find(
      (folder) => folder.canWrite && /marketing/i.test(folder.path),
    ) ??
    (tree.data?.folders ?? []).find((folder) => folder.canWrite) ??
    null;

  const sendMarks = async () => {
    if (!marketingFolder) return;
    setSending(true);
    setProblem(null);
    try {
      for (const mark of WINGS_MARKS) {
        const response = await fetch(mark.path);
        if (!response.ok) throw new Error('O arquivo do logo não está no app.');
        const blob = await response.blob();
        await sendFile({
          folderId: marketingFolder.id,
          file: new File([blob], mark.name, { type: 'image/png' }),
          onProgress: () => undefined,
        });
      }
      await wings.refetch();
    } catch (error) {
      setProblem(errorText(error, 'Não deu para enviar o logo para o Drive.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <h3 className="ws-panel-sub">Logo da Wings</h3>
      {wings.isLoading ? (
        <p className="muted" role="status">
          Procurando no Drive…
        </p>
      ) : wingsFiles.length > 0 ? (
        <LogoList files={wingsFiles} session={session} emptyText="" />
      ) : wings.isError ? (
        // Not "the logo is not in the Drive": the search failed, and sending it again could duplicate it.
        <LoadFailure
          what="o logo da Wings"
          error={wings.error}
          onRetry={() => void wings.refetch()}
        />
      ) : (
        <div className="ws-empty">
          <p>
            O logo ainda não está no Drive. Enviar uma vez o deixa disponível para todo projeto.
          </p>
          <Button
            type="button"
            variant="ghost"
            disabled={sending || !marketingFolder}
            title={
              marketingFolder
                ? `Vai para ${marketingFolder.path}`
                : tree.isError
                  ? `Não foi possível ler as suas pastas do Drive: ${failureReason(tree.error)}`
                  : 'Você não tem pasta com permissão de escrita no Drive'
            }
            onClick={() => void sendMarks()}
          >
            {sending ? 'Enviando…' : 'Enviar o logo para o Drive'}
          </Button>
          {problem && (
            <p className="field-error" role="alert">
              {problem}
            </p>
          )}
        </div>
      )}

      <h3 className="ws-panel-sub">Logo do cliente</h3>
      {session.clientId === null ? (
        <p className="ws-empty">Escolha o cliente em "Para quem" para ver os logos dele.</p>
      ) : client.isLoading ? (
        <p className="muted" role="status">
          Procurando no Drive…
        </p>
      ) : client.isError && clientFiles.length === 0 ? (
        <LoadFailure
          what="os logos do cliente"
          error={client.error}
          onRetry={() => void client.refetch()}
        />
      ) : (
        <LogoList
          files={clientFiles}
          session={session}
          emptyText="Nenhum arquivo com “logo” no nome na pasta desse cliente. Envie pelo Drive."
        />
      )}

      <h3 className="ws-panel-sub">Formas</h3>
      <label className="ws-color">
        <span className="field-label">Cor</span>
        <input
          type="color"
          value={color}
          onChange={(event) => setColor(event.target.value)}
          aria-label="Cor da forma"
        />
      </label>
      <div className="ws-shapes">
        {SHAPES.map((shape) => (
          <button
            key={shape.kind}
            type="button"
            className={`ws-shape ws-shape-${shape.kind}`}
            disabled={!ready}
            onClick={() => void session.addShape(shape.kind, color)}
          >
            <i
              aria-hidden="true"
              style={{ background: shape.kind === 'line' ? color : undefined, borderColor: color }}
            />
            {shape.label}
          </button>
        ))}
      </div>
    </>
  );
}
