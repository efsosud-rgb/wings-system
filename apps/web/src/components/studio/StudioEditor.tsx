import {
  STUDIO_ASPECTS,
  STUDIO_ASPECT_KEYS,
  STUDIO_BROWSER_EXPORT_MAX_SECONDS,
  STUDIO_PROJECT_MIME,
  STUDIO_PROJECT_SUFFIX,
  STUDIO_RENDER_STATE_LABEL,
  parseWingsDriveRef,
  studioProjectFileSchema,
  wingsDriveRef,
  type DriveFile,
  type DriveFolder,
  type StudioAspect,
  type StudioProjectFile,
} from '@wings/shared';
import type { Canvas, Controls, Edit, EditConfig, Timeline, VideoExporter } from '@wings/studio';
import resvgWasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url';
import hbWasmUrl from 'harfbuzzjs/hb.wasm?url';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { NameTakenError, sendFile } from '../../api/drive.js';
import { studioFileLink, useCreateRender, useRender } from '../../api/studio.js';
import { errorText } from '../drive/DriveParts.js';
import { Alert, Button } from '../ui.js';
import { DriveFilePicker, studioKindOf, type StudioFileKind } from './DriveFilePicker.js';
import { SaveToDriveDialog } from './SaveToDriveDialog.js';

/**
 * The manual editor. The core (packages/studio, a fork of Shotstack Studio
 * SDK) owns the canvas, the timeline and the keyboard; this component owns
 * the Drive: what comes in, where it goes, and the rule that a project never
 * carries an address. While editing, a clip's `src` is a link that lasts an
 * hour; saved or sent to render, it is `wings-drive://<id>` again.
 */

interface Core {
  edit: Edit;
  canvas: Canvas;
  timeline: Timeline;
  controls: Controls;
  exporter: VideoExporter;
}

/** A Drive file on the timeline, and the link it is playing through. */
interface Asset {
  id: string;
  name: string;
  mimeType: string;
  url: string;
}

type Clip = Parameters<Edit['addTrack']>[1]['clips'][number];
type Notice = { kind: 'info' | 'error' | 'success'; text: ReactNode };

const emptyEdit = (aspect: StudioAspect): EditConfig =>
  ({
    timeline: { background: '#000000', tracks: [] },
    output: { format: 'mp4', fps: 30, size: STUDIO_ASPECTS[aspect] },
  }) as unknown as EditConfig;

function clipFor(kind: StudioFileKind, src: string): Clip {
  switch (kind) {
    case 'video':
      return { asset: { type: 'video', src, volume: 1 }, start: 0, length: 'auto' } as Clip;
    case 'audio':
      return { asset: { type: 'audio', src, volume: 1 }, start: 0, length: 'auto' } as Clip;
    case 'image':
      return { asset: { type: 'image', src }, start: 0, length: 5, fit: 'contain' } as Clip;
    case 'subtitle':
      return { asset: { type: 'rich-caption', src }, start: 0, length: 'end' } as Clip;
    case 'project':
      throw new Error('a project is opened, not added');
  }
}

const textClip = (start: number): Clip =>
  ({
    asset: {
      type: 'rich-text',
      text: 'Título',
      font: { family: 'Work Sans', size: 72, weight: 600, color: '#ffffff', opacity: 1 },
      align: { horizontal: 'center', vertical: 'middle' },
    },
    start,
    length: 5,
    width: 800,
    height: 240,
  }) as Clip;

function dispose(core: Core) {
  core.exporter.dispose();
  core.controls.dispose();
  core.timeline.dispose();
  core.canvas.dispose();
  core.edit.dispose();
}

export function StudioEditor() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const coreRef = useRef<Core | null>(null);
  const assetsRef = useRef<Map<string, Asset>>(new Map());
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [aspect, setAspect] = useState<StudioAspect>('16:9');
  const [projectName, setProjectName] = useState('Novo projeto');
  const [projectFile, setProjectFile] = useState<{ id: string; folderId: string } | null>(null);
  const [lastFolder, setLastFolder] = useState<DriveFolder | null>(null);
  const [picker, setPicker] = useState<'media' | 'project' | null>(null);
  const [saving, setSaving] = useState<'project' | 'video' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; message: string } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [renderId, setRenderId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const createRender = useCreateRender();
  const render = useRender(renderId);
  const webCodecs = typeof VideoEncoder !== 'undefined';

  // The core is loaded on demand: a megabyte that only this tab needs.
  useEffect(() => {
    let cancelled = false;
    let made: Core | null = null;
    (async () => {
      const studio = await import('@wings/studio');
      studio.configureStudio({ harfbuzzWasmUrl: hbWasmUrl, resvgWasmUrl: resvgWasmUrl });
      if (cancelled || !timelineRef.current) return;
      const edit = new studio.Edit(emptyEdit('16:9'));
      const canvas = new studio.Canvas(edit);
      await canvas.load();
      await edit.load();
      const timeline = new studio.Timeline(edit, timelineRef.current, { resizable: true });
      await timeline.load();
      const controls = new studio.Controls(edit);
      await controls.load();
      const exporter = new studio.VideoExporter(edit, canvas);
      made = { edit, canvas, timeline, controls, exporter };
      if (cancelled) {
        dispose(made);
        return;
      }
      coreRef.current = made;
      setStatus('ready');
    })().catch((error: unknown) => {
      if (cancelled) return;
      setStatus('failed');
      setFailure(
        error instanceof Error && error.name === 'WebGLUnsupportedError'
          ? 'Este navegador não tem WebGL, que a prévia precisa. Tente o Chrome ou o Edge.'
          : errorText(error, 'O editor não conseguiu abrir.'),
      );
    });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      if (made) dispose(made);
      coreRef.current = null;
    };
  }, []);

  const remember = useCallback((asset: Asset) => {
    assetsRef.current.set(asset.id, asset);
    setAssets([...assetsRef.current.values()]);
  }, []);

  /** A link for one Drive file, kept so the same file is never asked for twice. */
  const resolve = useCallback(
    async (file: Pick<DriveFile, 'id' | 'name' | 'mimeType'>): Promise<Asset> => {
      const known = assetsRef.current.get(file.id);
      if (known) return known;
      const { url } = await studioFileLink(file.id);
      const asset = { id: file.id, name: file.name, mimeType: file.mimeType, url };
      remember(asset);
      return asset;
    },
    [remember],
  );

  /** The document with every link turned back into a Drive reference. */
  const serialized = useCallback((): { edit: Record<string, unknown>; ids: string[] } => {
    const core = coreRef.current;
    if (!core) throw new Error('O editor ainda não abriu.');
    const doc = JSON.parse(JSON.stringify(core.edit.getEdit())) as {
      timeline?: { tracks?: { clips?: { asset?: { src?: unknown } }[] }[] };
    };
    const byUrl = new Map([...assetsRef.current.values()].map((asset) => [asset.url, asset.id]));
    const ids = new Set<string>();
    for (const track of doc.timeline?.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        const src = clip.asset?.src;
        if (typeof src !== 'string') continue;
        const id = byUrl.get(src) ?? parseWingsDriveRef(src);
        if (!id) throw new Error('Um clipe aponta para um arquivo que não veio do Drive.');
        if (clip.asset) clip.asset.src = wingsDriveRef(id);
        ids.add(id);
      }
    }
    return { edit: doc as Record<string, unknown>, ids: [...ids] };
  }, []);

  const changeAspect = async (next: StudioAspect) => {
    const core = coreRef.current;
    if (!core) return;
    setAspect(next);
    await core.edit.setOutputSize(STUDIO_ASPECTS[next].width, STUDIO_ASPECTS[next].height);
  };

  const addText = async () => {
    const core = coreRef.current;
    if (!core) return;
    await core.edit.addTrack(0, { clips: [textClip(core.edit.playbackTime)] });
  };

  const openProject = async (file: DriveFile, folder: DriveFolder) => {
    const core = coreRef.current;
    if (!core) return;
    setBusy('Abrindo o projeto…');
    try {
      const { url } = await studioFileLink(file.id);
      const response = await fetch(url);
      if (!response.ok) throw new Error('O arquivo do projeto não pôde ser lido.');
      const parsed = studioProjectFileSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('Este arquivo não é um projeto do Studio.');
      const project: StudioProjectFile = parsed.data;
      const doc = JSON.parse(JSON.stringify(project.edit)) as {
        timeline?: { tracks?: { clips?: { asset?: { src?: unknown } }[] }[] };
      };
      for (const track of doc.timeline?.tracks ?? []) {
        for (const clip of track.clips ?? []) {
          const id = parseWingsDriveRef(clip.asset?.src);
          if (!id || !clip.asset) continue;
          const meta = project.assets[id] ?? { name: id, mimeType: 'application/octet-stream' };
          clip.asset.src = (await resolve({ id, ...meta })).url;
        }
      }
      await core.edit.loadEdit(doc as unknown as EditConfig);
      setAspect(project.aspect);
      setProjectName(project.name);
      setProjectFile({ id: file.id, folderId: folder.id });
      setLastFolder(folder);
      setNotice({ kind: 'success', text: `Projeto "${project.name}" aberto.` });
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error, 'Não deu para abrir o projeto.') });
    } finally {
      setBusy(null);
    }
  };

  const addFromDrive = async (file: DriveFile, folder: DriveFolder) => {
    setPicker(null);
    const kind = studioKindOf(file);
    if (kind === 'project') return openProject(file, folder);
    const core = coreRef.current;
    if (!core || !kind) return;
    setBusy('Abrindo o arquivo…');
    try {
      const asset = await resolve(file);
      await core.edit.addTrack(0, { clips: [clipFor(kind, asset.url)] });
      setLastFolder(folder);
      setNotice(null);
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error, 'Não deu para abrir o arquivo.') });
    } finally {
      setBusy(null);
    }
  };

  const projectBlob = (): { blob: Blob; ids: string[] } => {
    const { edit, ids } = serialized();
    const file: StudioProjectFile = {
      kind: 'wings-studio-project',
      version: 1,
      name: projectName,
      aspect,
      edit,
      assets: Object.fromEntries(
        ids.map((id) => {
          const asset = assetsRef.current.get(id);
          return [id, { name: asset?.name ?? id, mimeType: asset?.mimeType ?? '' }];
        }),
      ),
    };
    return { blob: new Blob([JSON.stringify(file)], { type: STUDIO_PROJECT_MIME }), ids };
  };

  /** Sends bytes to the Drive; a taken name offers a new version on top of the existing file. */
  const store = async (
    folder: DriveFolder,
    name: string,
    blob: Blob,
    replaceFileId: string | undefined,
    what: string,
  ) => {
    try {
      const file = await sendFile({
        folderId: folder.id,
        file: new File([blob], name, { type: blob.type }),
        replaceFileId,
        onProgress: (fraction) =>
          setProgress({ done: Math.round(fraction * 100), message: `Enviando ${what}…` }),
      });
      return file;
    } catch (error) {
      if (error instanceof NameTakenError) {
        const existing = error.existingFileId;
        setNotice({
          kind: 'info',
          text: (
            <>
              Já existe um arquivo chamado "{name}" nessa pasta.{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => void store(folder, name, blob, existing, what)}
              >
                Salvar como nova versão dele
              </button>
            </>
          ),
        });
        return null;
      }
      throw error;
    } finally {
      setProgress(null);
    }
  };

  const saveProject = async (choice: {
    folder: DriveFolder;
    name: string;
    replaceFileId?: string;
  }) => {
    setSaving(null);
    setBusy('Salvando o projeto…');
    try {
      const { blob } = projectBlob();
      const name = choice.name.endsWith(STUDIO_PROJECT_SUFFIX)
        ? choice.name
        : `${choice.name}${STUDIO_PROJECT_SUFFIX}`;
      const file = await store(choice.folder, name, blob, choice.replaceFileId, 'o projeto');
      if (file) {
        setProjectFile({ id: file.id, folderId: choice.folder.id });
        setProjectName(name.slice(0, -STUDIO_PROJECT_SUFFIX.length));
        setLastFolder(choice.folder);
        setNotice({
          kind: 'success',
          text: (
            <>
              Projeto salvo no Drive em {choice.folder.path} (versão {file.version}).{' '}
              <Link to="/drive">Abrir o Drive</Link>
            </>
          ),
        });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error, 'Não deu para salvar o projeto.') });
    } finally {
      setBusy(null);
    }
  };

  const exportInBrowser = async (choice: {
    folder: DriveFolder;
    name: string;
    replaceFileId?: string;
  }) => {
    const core = coreRef.current;
    if (!core) return;
    setSaving(null);
    const name = choice.name.toLowerCase().endsWith('.mp4') ? choice.name : `${choice.name}.mp4`;
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy('Exportando no navegador…');
    try {
      const blob = await core.exporter.render({
        signal: abort.signal,
        onProgress: (done, message) => setProgress({ done, message }),
      });
      const file = await store(choice.folder, name, blob, choice.replaceFileId, 'o vídeo');
      if (file) {
        setLastFolder(choice.folder);
        setNotice({
          kind: 'success',
          text: (
            <>
              Vídeo salvo no Drive em {choice.folder.path} (versão {file.version}).{' '}
              <Link to="/drive">Abrir o Drive</Link>
            </>
          ),
        });
      }
    } catch (error) {
      if (abort.signal.aborted) {
        setNotice({ kind: 'info', text: 'Exportação cancelada.' });
      } else {
        setNotice({
          kind: 'error',
          text: (
            <>
              A exportação no navegador falhou: {errorText(error, 'erro desconhecido')}.{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => void renderOnServer(choice)}
              >
                Renderizar no servidor
              </button>
            </>
          ),
        });
      }
    } finally {
      abortRef.current = null;
      setProgress(null);
      setBusy(null);
    }
  };

  const renderOnServer = async (choice: {
    folder: DriveFolder;
    name: string;
    replaceFileId?: string;
  }) => {
    setSaving(null);
    setBusy('Enviando para a fila de render…');
    try {
      const { edit } = serialized();
      const name = choice.name.toLowerCase().endsWith('.mp4') ? choice.name : `${choice.name}.mp4`;
      const { render: queued } = await createRender.mutateAsync({
        project: edit,
        destination: { folderId: choice.folder.id, name, replaceFileId: choice.replaceFileId },
        fps: 30,
        videoBitrate: 8_000_000,
      });
      setRenderId(queued.id);
      setLastFolder(choice.folder);
      setNotice(null);
    } catch (error) {
      setNotice({ kind: 'error', text: errorText(error, 'Não deu para pedir o render.') });
    } finally {
      setBusy(null);
    }
  };

  const duration = coreRef.current?.edit.totalDuration ?? 0;
  const longForBrowser = duration > STUDIO_BROWSER_EXPORT_MAX_SECONDS;
  const ready = status === 'ready' && busy === null;
  const replaceProject =
    projectFile && lastFolder && projectFile.folderId === lastFolder.id
      ? {
          id: projectFile.id,
          name: `${projectName}${STUDIO_PROJECT_SUFFIX}`,
          folderId: lastFolder.id,
        }
      : null;
  const current = render.data?.render ?? null;

  return (
    <div className="studio-editor">
      <div className="studio-editor-bar" role="toolbar" aria-label="Studio">
        <span className="studio-editor-title" title={projectName}>
          {projectName}
        </span>
        <Button type="button" variant="ghost" disabled={!ready} onClick={() => setPicker('media')}>
          Abrir do Drive
        </Button>
        <Button type="button" variant="ghost" disabled={!ready} onClick={() => void addText()}>
          Adicionar texto
        </Button>
        <label className="field-hint">
          Formato{' '}
          <select
            value={aspect}
            disabled={!ready}
            onChange={(event) => void changeAspect(event.target.value as StudioAspect)}
            aria-label="Formato do vídeo"
          >
            {STUDIO_ASPECT_KEYS.map((key) => (
              <option key={key} value={key}>
                {STUDIO_ASPECTS[key].label}
              </option>
            ))}
          </select>
        </label>
        <span className="studio-editor-group">
          <Button
            type="button"
            variant="ghost"
            disabled={!ready}
            onClick={() => void coreRef.current?.edit.undo()}
            aria-label="Desfazer"
            title="Desfazer (Ctrl+Z)"
          >
            ↶
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!ready}
            onClick={() => void coreRef.current?.edit.redo()}
            aria-label="Refazer"
            title="Refazer (Ctrl+Shift+Z)"
          >
            ↷
          </Button>
        </span>
        <span className="studio-editor-group">
          <Button
            type="button"
            variant="ghost"
            disabled={!ready}
            onClick={() => setSaving('project')}
          >
            Salvar projeto
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!ready}
            onClick={() => setSaving('video')}
          >
            Exportar
          </Button>
        </span>
      </div>

      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
      {status === 'failed' && <Alert kind="error">{failure}</Alert>}

      {progress && (
        <div className="studio-progress" role="status">
          <span>{progress.message}</span>
          <div className="studio-progress-bar">
            <span style={{ width: `${progress.done}%` }} />
          </div>
          <span className="mono">{progress.done}%</span>
          {abortRef.current && (
            <button type="button" className="link-button" onClick={() => abortRef.current?.abort()}>
              Cancelar
            </button>
          )}
        </div>
      )}
      {busy && !progress && (
        <p className="muted" role="status">
          {busy}
        </p>
      )}

      <div className="studio-stage" ref={stageRef}>
        <div data-shotstack-studio />
        {status === 'loading' && <div className="studio-stage-cover">Abrindo o editor…</div>}
      </div>
      <div className="studio-timeline" ref={timelineRef} />

      {assets.length > 0 && (
        <ul className="studio-assets" aria-label="Arquivos do Drive neste projeto">
          {assets.map((asset) => (
            <li key={asset.id}>{asset.name}</li>
          ))}
        </ul>
      )}

      {current && (
        <div className="studio-render" role="status">
          <strong>
            Render no servidor: {STUDIO_RENDER_STATE_LABEL[current.state]}
            {current.state === 'pending' && ' (o worker pega quando estiver livre)'}
          </strong>
          {current.state === 'failed' && <span className="muted">{current.error}</span>}
          {current.file && (
            <span>
              Salvo no Drive como "{current.destination.name}" (versão {current.file.version}).{' '}
              <Link to="/drive">Abrir o Drive</Link>
            </span>
          )}
          {current.unsupported.length > 0 && (
            <span className="muted">
              O servidor não reproduziu: {current.unsupported.join('; ')}
            </span>
          )}
          <button type="button" className="link-button" onClick={() => setRenderId(null)}>
            Fechar
          </button>
        </div>
      )}

      {picker === 'media' && (
        <DriveFilePicker
          label="Abrir do Drive"
          accept={['video', 'image', 'audio', 'subtitle', 'project']}
          initialFolderId={lastFolder?.id ?? null}
          onPick={(file, folder) => void addFromDrive(file, folder)}
          onClose={() => setPicker(null)}
        />
      )}

      {saving === 'project' && (
        <SaveToDriveDialog
          label="Salvar projeto no Drive"
          defaultName={projectName}
          defaultFolderId={lastFolder?.id ?? null}
          replace={replaceProject}
          hint={
            <p className="field-hint">
              O projeto guarda os cortes e cita os arquivos do Drive pelo id; nada é copiado.
            </p>
          }
          actions={[{ label: 'Salvar', primary: true, run: (choice) => void saveProject(choice) }]}
          onClose={() => setSaving(null)}
        />
      )}

      {saving === 'video' && (
        <SaveToDriveDialog
          label="Exportar vídeo para o Drive"
          defaultName={projectName}
          defaultFolderId={lastFolder?.id ?? null}
          replace={null}
          hint={
            <p className="field-hint">
              {!webCodecs
                ? 'Este navegador não exporta vídeo (sem WebCodecs): o servidor renderiza.'
                : longForBrowser
                  ? `Linha do tempo acima de ${STUDIO_BROWSER_EXPORT_MAX_SECONDS / 60} minutos: melhor no servidor.`
                  : 'No navegador sai na hora, em H.264 a 5 Mbps. No servidor entra numa fila e sai a 8 Mbps.'}
            </p>
          }
          actions={[
            {
              label: 'Exportar no navegador',
              primary: webCodecs && !longForBrowser,
              disabled: !webCodecs,
              run: (choice) => void exportInBrowser(choice),
            },
            {
              label: 'Renderizar no servidor',
              primary: !webCodecs || longForBrowser,
              run: (choice) => void renderOnServer(choice),
            },
          ]}
          onClose={() => setSaving(null)}
        />
      )}
    </div>
  );
}
