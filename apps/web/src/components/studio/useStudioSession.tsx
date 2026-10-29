import {
  STUDIO_ASPECTS,
  STUDIO_BROWSER_EXPORT_MAX_SECONDS,
  STUDIO_PROJECT_MIME,
  STUDIO_PROJECT_SUFFIX,
  checkTimelineOps,
  parseWingsDriveRef,
  studioProjectFileSchema,
  wingsDriveRef,
  type DriveFile,
  type DriveFolder,
  type MediaAsset,
  type StudioAspect,
  type StudioProjectFile,
  type StudioTimelineSnapshot,
} from '@wings/shared';
import type { Canvas, Controls, Edit, EditConfig, Timeline, VideoExporter } from '@wings/studio';
import resvgWasmUrl from '@resvg/resvg-wasm/index_bg.wasm?url';
import hbWasmUrl from 'harfbuzzjs/hb.wasm?url';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.js';
import { NameTakenError, sendFile } from '../../api/drive.js';
import {
  studioFileLink,
  useCreateRender,
  useCreateTranscription,
  useRender,
  useTranscription,
} from '../../api/studio.js';
import { errorText } from '../drive/DriveParts.js';
import { isStaleChunkError, reloadOnceForNewBuild } from '../stale-build.js';
import {
  applyTimelineOps,
  snapshotClips,
  timelineSnapshot,
  type PlacedFile,
  type TimingOf,
} from './agent-edit.js';
import { probeMediaDuration } from './media-probe.js';
import {
  captionClip,
  clipFor,
  dataUrlToBlob,
  emptyEdit,
  friendlyCoreError,
  withCleanSize,
  hasPlayableMedia,
  kindOfMime,
  layersOf,
  logoClip,
  selectedFrom,
  shapeSvg,
  textClip,
  updatesFor,
  type DocClip,
  type EditDoc,
} from './clips.js';
import type {
  ClipPatch,
  SaveChoice,
  SelectedClip,
  ShapeKind,
  StudioAsset,
  StudioFileKind,
  StudioLayer,
  StudioMode,
  StudioNotice,
  StudioSession,
  StudioStatus,
  TextPreset,
} from './session.js';

/**
 * The editor's brain. The core (packages/studio, a fork of Shotstack Studio
 * SDK) owns the canvas, the timeline and the keyboard; this hook owns the
 * Drive: what comes in, where it goes, and the rule that a project never
 * carries an address. While editing, a clip's `src` is a link that lasts an
 * hour; saved or sent to render, it is `wings-drive://<id>` again.
 *
 * The workspace renders what this returns and calls its methods; no panel
 * reaches the core on its own.
 */

interface Core {
  edit: Edit;
  canvas: Canvas;
  timeline: Timeline;
  controls: Controls;
  exporter: VideoExporter;
}

/**
 * A still is captured at the playhead, so in image mode every layer starts
 * at zero and lasts the same few seconds: they are always on screen together.
 */
const IMAGE_MODE_LENGTH = 5;
const VIDEO_TEXT_LENGTH = 5;

/** The record behind "Aplicar" on an agent's card. The timeline itself lives here, in the browser. */
function recordAgentEditKept(proposalId: string) {
  void api.post(`/agent/proposals/${proposalId}/applied`).catch(() => {
    // The edit is on the timeline either way; only the card's record missed.
  });
}

/** Edits that happen inside `replaceEdit` itself, or take it back, and do not keep a preview. */
const PREVIEW_OWN_SOURCES = /^(loadEdit|replaceEdit$|undo:replaceEdit$|redo:replaceEdit$)/;

function dispose(core: Core) {
  core.exporter.dispose();
  core.controls.dispose();
  core.timeline.dispose();
  core.canvas.dispose();
  core.edit.dispose();
}

export function useStudioSession(): StudioSession {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const coreRef = useRef<Core | null>(null);
  const assetsRef = useRef<Map<string, StudioAsset>>(new Map());
  /** Drive file id → media library asset id, for the AI panel. */
  const mediaIdsRef = useRef<Map<string, string>>(new Map());
  /** Drive file id → the library asset itself (its client and aspect), for "Editar com IA". */
  const mediaAssetsRef = useRef<Map<string, MediaAsset>>(new Map());
  const abortRef = useRef<AbortController | null>(null);

  const [status, setStatus] = useState<StudioStatus>('loading');
  const [failure, setFailure] = useState<string | null>(null);
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [mode, setModeState] = useState<StudioMode>('image');
  const [aspect, setAspectState] = useState<StudioAspect>('16:9');
  const [projectName, setProjectName] = useState('Novo projeto');
  const [clientId, setClientId] = useState<string | null>(null);
  const [projectFile, setProjectFile] = useState<{ id: string; folderId: string } | null>(null);
  const [lastFolder, setLastFolder] = useState<DriveFolder | null>(null);
  const [dirty, setDirty] = useState(false);
  /** Bumped on every core change, so what is read from the core during render is fresh. */
  const [, setRevision] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [zoom, setZoomState] = useState(1);
  const [selected, setSelected] = useState<SelectedClip | null>(null);
  const [layers, setLayers] = useState<StudioLayer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; message: string } | null>(null);
  const [notice, setNotice] = useState<StudioNotice | null>(null);
  const [renderId, setRenderId] = useState<string | null>(null);
  const [transcriptionId, setTranscriptionId] = useState<string | null>(null);
  const [agentPreview, setAgentPreview] = useState<{ proposalId: string } | null>(null);
  const [agentEditsKept, setAgentEditsKept] = useState<string[]>([]);
  /** The previewed card, read by the core's listeners, which outlive a render. */
  const previewRef = useRef<string | null>(null);

  const createRender = useCreateRender();
  const render = useRender(renderId);
  const createTranscription = useCreateTranscription();
  const transcription = useTranscription(transcriptionId);
  const webCodecs = typeof VideoEncoder !== 'undefined';

  const nameOfSrc = useCallback((src: unknown): string | null => {
    if (typeof src !== 'string') return null;
    for (const asset of assetsRef.current.values()) if (asset.url === src) return asset.name;
    return null;
  }, []);

  /** Reads selection and layers from the core after anything changed. */
  const refresh = useCallback(() => {
    const core = coreRef.current;
    if (!core) return;
    const doc = core.edit.getEdit({ includeIds: true }) as unknown as EditDoc;
    const info = core.edit.getSelectedClipInfo();
    let next: SelectedClip | null = null;
    if (info) {
      const clipId = core.edit.getClipId(info.trackIndex, info.clipIndex);
      const resolved = clipId ? core.edit.getResolvedClipById(clipId) : null;
      if (clipId && resolved) {
        next = selectedFrom(
          resolved,
          { clipId, trackIndex: info.trackIndex, clipIndex: info.clipIndex },
          nameOfSrc((resolved as unknown as DocClip).asset?.src),
        );
      }
    }
    setSelected(next);
    setLayers(layersOf(doc, (t, c) => core.edit.getClipId(t, c), nameOfSrc, next?.clipId ?? null));
    setTotalDuration(core.edit.totalDuration);
    if (hasPlayableMedia(doc)) setModeState('video');
    setRevision((value) => value + 1);
  }, [nameOfSrc]);

  // The core is loaded on demand: a megabyte that only this screen needs.
  useEffect(() => {
    let cancelled = false;
    let made: Core | null = null;
    const offs: (() => void)[] = [];
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
      const on = (name: string, listener: (payload?: unknown) => void) =>
        offs.push(
          (
            edit.events as unknown as {
              on: (n: string, l: (payload?: unknown) => void) => () => void;
            }
          ).on(name, listener),
        );
      on('clip:selected', refresh);
      on('selection:cleared', refresh);
      on('clip:added', refresh);
      on('clip:deleted', refresh);
      on('clip:updated', refresh);
      on('timeline:updated', refresh);
      on('duration:changed', refresh);
      on('edit:changed', (event) => {
        setDirty(true);
        refresh();
        // Editing on after a preview keeps it: it is one step of the history like any other.
        // Ctrl+Z on it takes it back, as "Descartar" would.
        const previewed = previewRef.current;
        const source = (event as { source?: string } | undefined)?.source ?? '';
        if (!previewed) return;
        if (source === 'undo:replaceEdit') {
          previewRef.current = null;
          setAgentPreview(null);
        } else if (!PREVIEW_OWN_SOURCES.test(source)) {
          previewRef.current = null;
          setAgentPreview(null);
          setAgentEditsKept((kept) => [...kept, previewed]);
          recordAgentEditKept(previewed);
        }
      });
      on('playback:play', () => setPlaying(true));
      on('playback:pause', () => {
        setPlaying(false);
        setPlaybackTime(edit.playbackTime);
      });
      setZoomState(canvas.getZoom());
      setStatus('ready');
    })().catch((error: unknown) => {
      if (cancelled) return;
      // The core's chunk is from the previous build: reload once, the notice stays if it cannot.
      if (isStaleChunkError(error)) reloadOnceForNewBuild();
      setStatus('failed');
      setFailure(
        error instanceof Error && error.name === 'WebGLUnsupportedError'
          ? 'Este navegador não tem WebGL, que a prévia precisa. Tente o Chrome ou o Edge.'
          : friendlyCoreError(error, 'O editor não conseguiu abrir.'),
      );
    });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      for (const off of offs) off();
      if (made) dispose(made);
      coreRef.current = null;
    };
  }, [refresh]);

  // The playhead, a few times a second while playing.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const core = coreRef.current;
      if (core) setPlaybackTime(core.edit.playbackTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // The stage box changes without a window resize (the transport and the timeline
  // appear when a piece turns into a video, a panel opens beside it). The core
  // only listens to the window, so it kept the box it measured at load and fitted
  // every later format into that: on staging a format switch left the frame off
  // the stage. Measure again whenever the box moves.
  useEffect(() => {
    if (status !== 'ready' || typeof ResizeObserver === 'undefined') return;
    const host = stageRef.current;
    if (!host) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const made = coreRef.current;
        if (!made) return;
        made.canvas.resize();
        setZoomState(made.canvas.getZoom());
      });
    });
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [status]);

  // The wheel zooms inside the core; this only keeps the number on screen honest.
  useEffect(() => {
    if (status !== 'ready') return;
    const interval = setInterval(() => {
      const core = coreRef.current;
      if (!core) return;
      const current = core.canvas.getZoom();
      setZoomState((known) => (Math.abs(known - current) > 0.001 ? current : known));
    }, 250);
    return () => clearInterval(interval);
  }, [status]);

  const remember = useCallback((asset: StudioAsset) => {
    assetsRef.current.set(asset.id, asset);
    setAssets([...assetsRef.current.values()]);
  }, []);

  /** A link for one Drive file, kept so the same file is never asked for twice. */
  const resolve = useCallback(
    async (file: Pick<DriveFile, 'id' | 'name' | 'mimeType'>): Promise<StudioAsset> => {
      const known = assetsRef.current.get(file.id);
      if (known) return known;
      const { url } = await studioFileLink(file.id);
      const asset: StudioAsset = {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        url,
        kind: kindOfMime(file.name, file.mimeType) ?? 'image',
      };
      remember(asset);
      return asset;
    },
    [remember],
  );

  /** The document with every link turned back into a Drive reference. */
  const serialized = useCallback((): { edit: Record<string, unknown>; ids: string[] } => {
    const core = coreRef.current;
    if (!core) throw new Error('O editor ainda não abriu.');
    const doc = JSON.parse(JSON.stringify(core.edit.getEdit())) as EditDoc;
    const byUrl = new Map([...assetsRef.current.values()].map((asset) => [asset.url, asset.id]));
    const ids = new Set<string>();
    for (const track of doc.timeline?.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        const src = clip.asset?.src;
        // A shape carries its own markup, not a file: nothing to translate.
        if (typeof src !== 'string' || clip.asset?.type === 'svg') continue;
        const id = byUrl.get(src) ?? parseWingsDriveRef(src);
        if (!id) throw new Error('Um clipe aponta para um arquivo que não veio do Drive.');
        if (clip.asset) clip.asset.src = wingsDriveRef(id);
        ids.add(id);
      }
    }
    return { edit: doc as Record<string, unknown>, ids: [...ids] };
  }, []);

  const core = () => {
    const made = coreRef.current;
    if (!made) throw new Error('O editor ainda não abriu.');
    return made;
  };

  const clipLength = () => (mode === 'image' ? IMAGE_MODE_LENGTH : VIDEO_TEXT_LENGTH);
  const clipStart = () => (mode === 'image' ? 0 : (coreRef.current?.edit.playbackTime ?? 0));

  const setMode = (next: StudioMode): boolean => {
    const made = coreRef.current;
    if (next === 'image' && made && hasPlayableMedia(made.edit.getEdit() as unknown as EditDoc)) {
      setNotice({
        kind: 'info',
        text: 'Este projeto tem vídeo ou áudio na linha do tempo; para virar imagem, remova-os antes.',
      });
      return false;
    }
    setModeState(next);
    return true;
  };

  const outputSize = () => {
    const made = coreRef.current;
    const size = made?.edit.size;
    return size && size.width > 0
      ? { width: size.width, height: size.height }
      : STUDIO_ASPECTS[aspect];
  };

  const setAspect = async (next: StudioAspect) => {
    setAspectState(next);
    const made = core();
    await made.edit.setOutputSize(STUDIO_ASPECTS[next].width, STUDIO_ASPECTS[next].height);
    // The core refits on its own event, but with the stage box it measured at load;
    // `resize()` measures the box again and refits, so the new frame lands centred.
    requestAnimationFrame(() => {
      coreRef.current?.canvas.resize();
      setZoomState(coreRef.current?.canvas.getZoom() ?? 1);
    });
    refresh();
  };

  const withBusy = async (message: string, fallback: string, run: () => Promise<void>) => {
    setBusy(message);
    try {
      await run();
    } catch (error) {
      setNotice({ kind: 'error', text: friendlyCoreError(error, fallback) });
    } finally {
      setBusy(null);
    }
  };

  const addClip = async (
    clip: Parameters<Edit['addTrack']>[1]['clips'][number],
    trackIndex = 0,
  ) => {
    await core().edit.addTrack(trackIndex, { clips: [clip] });
    refresh();
  };

  const openProject = async (file: DriveFile, folder: DriveFolder) =>
    withBusy('Abrindo o projeto…', 'Não deu para abrir o projeto.', async () => {
      const { url } = await studioFileLink(file.id);
      const response = await fetch(url);
      if (!response.ok) throw new Error('O arquivo do projeto não pôde ser lido.');
      const parsed = studioProjectFileSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('Este arquivo não é um projeto do Studio.');
      const project: StudioProjectFile = parsed.data;
      const doc = JSON.parse(JSON.stringify(project.edit)) as EditDoc;
      for (const track of doc.timeline?.tracks ?? []) {
        for (const clip of track.clips ?? []) {
          const id = parseWingsDriveRef(clip.asset?.src);
          if (!id || !clip.asset) continue;
          const meta = project.assets[id] ?? { name: id, mimeType: 'application/octet-stream' };
          clip.asset.src = (await resolve({ id, ...meta })).url;
        }
      }
      await core().edit.loadEdit(withCleanSize(doc) as unknown as EditConfig);
      setAspectState(project.aspect);
      setProjectName(project.name);
      setClientId(project.clientId);
      setProjectFile({ id: file.id, folderId: folder.id });
      setLastFolder(folder);
      setModeState(hasPlayableMedia(doc) ? 'video' : 'image');
      setDirty(false);
      refresh();
      setNotice({ kind: 'success', text: `Projeto "${project.name}" aberto.` });
    });

  const addDriveFile: StudioSession['addDriveFile'] = async (file, folder, options) => {
    const kind = kindOfMime(file.name, file.mimeType);
    if (kind === 'project') {
      if (!folder) {
        setNotice({ kind: 'error', text: 'Abra o projeto pela pasta do Drive em que ele está.' });
        return;
      }
      return openProject(file, folder);
    }
    if (!kind) {
      setNotice({ kind: 'error', text: 'Este arquivo não é vídeo, imagem, áudio nem legenda.' });
      return;
    }
    await withBusy('Abrindo o arquivo…', 'Não deu para abrir o arquivo.', async () => {
      const asset = await resolve(file);
      const start = options?.at ?? clipStart();
      // A video or audio clip is born with the file's real length, read here first.
      const durationSeconds =
        kind === 'video' || kind === 'audio' ? await probeMediaDuration(asset.url, kind) : null;
      const clip = clipFor(kind, asset.url, start, { durationSeconds, output: outputSize() });
      if (mode === 'image' && kind === 'image')
        (clip as { length: unknown }).length = IMAGE_MODE_LENGTH;
      await addClip(clip, options?.trackIndex ?? 0);
      if (folder) setLastFolder(folder);
      setNotice(
        (kind === 'video' || kind === 'audio') && durationSeconds === null
          ? {
              kind: 'info',
              text: 'Não deu para ler a duração deste arquivo no navegador; o editor usou uma estimativa. Ajuste a duração em Propriedades.',
            }
          : null,
      );
    });
  };

  const addMediaAsset: StudioSession['addMediaAsset'] = async (asset, options) => {
    const driveFileId = (asset as MediaAsset & { driveFileId?: string | null }).driveFileId ?? null;
    if (!driveFileId) {
      setNotice({
        kind: 'error',
        text: 'Este item da biblioteca ainda não está no Drive. Rode a migração da biblioteca ou salve-o no Drive antes.',
      });
      return;
    }
    mediaIdsRef.current.set(driveFileId, asset.id);
    mediaAssetsRef.current.set(driveFileId, asset);
    const name = `${asset.kind === 'video' ? 'video' : 'imagem'}-${asset.id.slice(0, 8)}`;
    await addDriveFile(
      { id: driveFileId, name, mimeType: asset.mimeType } as DriveFile,
      null,
      options,
    );
  };

  const replaceImage: StudioSession['replaceImage'] = async (clipId, item) => {
    const made = coreRef.current;
    const clip = made ? (made.edit.getDocumentClipById(clipId) as DocClip | null) : null;
    if (!made || !clip || clip.asset?.type !== 'image') {
      setNotice({ kind: 'error', text: 'A imagem a trocar não está mais na tela.' });
      return false;
    }
    let file: Pick<DriveFile, 'id' | 'name' | 'mimeType'>;
    if (item.kind === 'media-asset') {
      const { asset } = item;
      if (asset.kind !== 'image') {
        setNotice({ kind: 'error', text: 'Uma imagem só pode ser trocada por outra imagem.' });
        return false;
      }
      if (!asset.driveFileId) {
        setNotice({
          kind: 'error',
          text: 'Este item da biblioteca ainda não está no Drive. Rode a migração da biblioteca ou salve-o no Drive antes.',
        });
        return false;
      }
      mediaIdsRef.current.set(asset.driveFileId, asset.id);
      mediaAssetsRef.current.set(asset.driveFileId, asset);
      file = {
        id: asset.driveFileId,
        name: `imagem-${asset.id.slice(0, 8)}`,
        mimeType: asset.mimeType,
      };
    } else {
      if (kindOfMime(item.file.name, item.file.mimeType) !== 'image') {
        setNotice({ kind: 'error', text: 'Uma imagem só pode ser trocada por outra imagem.' });
        return false;
      }
      file = item.file;
      if (item.folder) setLastFolder(item.folder);
    }
    let done = false;
    await withBusy('Trocando a imagem…', 'Não deu para trocar a imagem.', async () => {
      const next = await resolve(file);
      // Only the source moves: position, size, layer and timing stay, and the
      // core records it as one command, so Ctrl+Z brings the old picture back.
      const result = await made.edit.updateClipById(clipId, {
        asset: { ...clip.asset, src: next.url },
      } as never);
      done = result.status !== 'noop';
      refresh();
    });
    return done;
  };

  const newProject: StudioSession['newProject'] = ({
    mode: nextMode,
    aspect: nextAspect,
    force,
  }) => {
    if (dirty && !force) return false;
    const made = coreRef.current;
    if (!made) return false;
    const chosen = nextAspect ?? aspect;
    void made.edit.loadEdit(emptyEdit(chosen)).then(() => {
      assetsRef.current.clear();
      mediaIdsRef.current.clear();
      mediaAssetsRef.current.clear();
      setAssets([]);
      setAspectState(chosen);
      setProjectName('Novo projeto');
      setProjectFile(null);
      setModeState(nextMode);
      setDirty(false);
      setNotice(null);
      refresh();
    });
    return true;
  };

  const addText = async (preset: TextPreset = 'title') =>
    addClip(textClip(preset, clipStart(), clipLength()));

  const addShape = async (kind: ShapeKind, color?: string) => {
    await core().edit.addSvgClip(shapeSvg(kind, color), {
      trackIndex: 0,
      start: clipStart() as never,
      length: clipLength() as never,
    });
    refresh();
  };

  const addLogo: StudioSession['addLogo'] = async (file, folder) =>
    withBusy('Abrindo o logo…', 'Não deu para abrir o logo.', async () => {
      const asset = await resolve(file);
      await addClip(logoClip(asset.url, clipStart(), clipLength()));
      if (folder) setLastFolder(folder);
    });

  const cropToAspect = async (next: StudioAspect) => {
    await setAspect(next);
    // The base image is the bottom track's first image clip: it fills the new frame.
    const made = core();
    const doc = made.edit.getEdit({ includeIds: true }) as unknown as EditDoc;
    const tracks = doc.timeline?.tracks ?? [];
    for (let trackIndex = tracks.length - 1; trackIndex >= 0; trackIndex -= 1) {
      const clips = tracks[trackIndex]?.clips ?? [];
      const clipIndex = clips.findIndex((clip) => clip.asset?.type === 'image');
      if (clipIndex === -1) continue;
      const clipId = clips[clipIndex]?.id ?? made.edit.getClipId(trackIndex, clipIndex);
      if (clipId) await made.edit.updateClipById(clipId, { fit: 'cover' } as never);
      break;
    }
    refresh();
  };

  const selectClip = (clipId: string) => {
    const made = coreRef.current;
    const where = made?.edit.getClipPositionById(clipId);
    if (made && where) made.edit.selectClip(where.trackIndex, where.clipIndex);
  };

  const clearSelection = () => coreRef.current?.edit.clearSelection();

  const updateSelected = async (patch: ClipPatch) => {
    const made = core();
    if (!selected) return;
    const current = (made.edit.getDocumentClipById(selected.clipId) ?? {}) as DocClip;
    await made.edit.updateClipById(selected.clipId, updatesFor(patch, current, outputSize()));
    refresh();
  };

  const deleteSelected = async () => {
    if (!selected) return;
    await core().edit.deleteClipById(selected.clipId);
    refresh();
  };

  const moveSelected = async (direction: 'up' | 'down') => {
    if (!selected) return;
    const made = core();
    const target = direction === 'up' ? selected.trackIndex - 1 : selected.trackIndex + 1;
    if (target < 0) return;
    made.edit.ensureTrackExists(target);
    await made.edit.moveClipById(selected.clipId, target, selected.start as never);
    refresh();
  };

  const projectBlob = (): { blob: Blob; ids: string[] } => {
    const { edit, ids } = serialized();
    const file: StudioProjectFile = {
      kind: 'wings-studio-project',
      version: 1,
      name: projectName,
      aspect,
      clientId,
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
    onStored: (file: DriveFile) => void,
  ): Promise<void> => {
    try {
      const file = await sendFile({
        folderId: folder.id,
        file: new File([blob], name, { type: blob.type }),
        replaceFileId,
        onProgress: (fraction) =>
          setProgress({ done: Math.round(fraction * 100), message: `Enviando ${what}…` }),
      });
      onStored(file);
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
                onClick={() => void store(folder, name, blob, existing, what, onStored)}
              >
                Salvar como nova versão dele
              </button>
            </>
          ),
        });
        return;
      }
      throw error;
    } finally {
      setProgress(null);
    }
  };

  const savedNotice = (what: string, folder: DriveFolder, version: number) => ({
    kind: 'success' as const,
    text: (
      <>
        {what} no Drive em {folder.path} (versão {version}). <a href="/drive">Abrir o Drive</a>
      </>
    ),
  });

  const saveProject = async (choice: SaveChoice) =>
    withBusy('Salvando o projeto…', 'Não deu para salvar o projeto.', async () => {
      const { blob } = projectBlob();
      const name = choice.name.endsWith(STUDIO_PROJECT_SUFFIX)
        ? choice.name
        : `${choice.name}${STUDIO_PROJECT_SUFFIX}`;
      await store(choice.folder, name, blob, choice.replaceFileId, 'o projeto', (file) => {
        setProjectFile({ id: file.id, folderId: choice.folder.id });
        setProjectName(name.slice(0, -STUDIO_PROJECT_SUFFIX.length));
        setLastFolder(choice.folder);
        setDirty(false);
        setNotice(savedNotice('Projeto salvo', choice.folder, file.version));
      });
    });

  const exportInBrowser = async (choice: SaveChoice) => {
    const made = core();
    const name = choice.name.toLowerCase().endsWith('.mp4') ? choice.name : `${choice.name}.mp4`;
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy('Exportando no navegador…');
    try {
      const blob = await made.exporter.render({
        signal: abort.signal,
        onProgress: (done, message) => setProgress({ done, message }),
      });
      await store(choice.folder, name, blob, choice.replaceFileId, 'o vídeo', (file) => {
        setLastFolder(choice.folder);
        setNotice(savedNotice('Vídeo salvo', choice.folder, file.version));
      });
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

  const renderOnServer = async (choice: SaveChoice) =>
    withBusy('Enviando para a fila de render…', 'Não deu para pedir o render.', async () => {
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
    });

  const exportVideo: StudioSession['exportVideo'] = (choice, where) =>
    where === 'browser' ? exportInBrowser(choice) : renderOnServer(choice);

  const exportImage: StudioSession['exportImage'] = async (choice) =>
    withBusy('Exportando a imagem…', 'Não deu para exportar a imagem.', async () => {
      const made = core();
      const extension = choice.format === 'png' ? '.png' : '.jpg';
      const name = /\.(png|jpe?g)$/i.test(choice.name)
        ? choice.name.replace(/\.(png|jpe?g)$/i, extension)
        : `${choice.name}${extension}`;
      made.edit.seek(playbackTime);
      const dataUrl = await made.canvas.captureFrame({
        format: choice.format,
        quality: choice.quality ?? 0.92,
      });
      const blob = dataUrlToBlob(dataUrl);
      await store(choice.folder, name, blob, choice.replaceFileId, 'a imagem', (file) => {
        setLastFolder(choice.folder);
        setNotice(savedNotice('Imagem salva', choice.folder, file.version));
      });
    });

  const requestCaptions: StudioSession['requestCaptions'] = async (assetId, language) =>
    withBusy('Pedindo a legenda…', 'Não deu para pedir a legenda.', async () => {
      const asset = assetsRef.current.get(assetId);
      if (!asset || (asset.kind !== 'video' && asset.kind !== 'audio')) {
        throw new Error('Escolha um vídeo ou um áudio deste projeto para legendar.');
      }
      const { transcription: queued } = await createTranscription.mutateAsync({
        fileId: asset.id,
        ...(language ? { language } : {}),
      });
      setTranscriptionId(queued.id);
      setNotice(null);
    });

  const addCaptionsFromTranscription = async () =>
    withBusy('Colocando a legenda…', 'Não deu para colocar a legenda.', async () => {
      const done = transcription.data?.transcription;
      if (!done?.file) throw new Error('A legenda ainda não está pronta.');
      const asset = await resolve({
        id: done.file.id,
        name: done.file.name,
        mimeType: 'application/x-subrip',
      });
      await addClip(captionClip(asset.url, outputSize()));
      setModeState('video');
      setNotice({ kind: 'success', text: 'Legenda colocada na linha do tempo, por cima de tudo.' });
    });

  /** Where each clip sits in time as the core resolved it: `auto` and `end` in seconds. */
  const timingOf =
    (edit: Edit): TimingOf =>
    (clipId) => {
      const resolved = edit.getResolvedClipById(clipId) as {
        start?: unknown;
        length?: unknown;
      } | null;
      if (!resolved) return null;
      const start = Number(resolved.start);
      const length = Number(resolved.length);
      return Number.isFinite(start) && Number.isFinite(length) ? { start, length } : null;
    };

  const timelineForAgent = (): StudioTimelineSnapshot | null => {
    const made = coreRef.current;
    if (!made) return null;
    const info = made.edit.getSelectedClipInfo();
    return timelineSnapshot({
      doc: made.edit.getEdit({ includeIds: true }) as unknown as EditDoc,
      timing: timingOf(made.edit),
      assets: [...assetsRef.current.values()],
      aspect,
      mode,
      durationSeconds: made.edit.totalDuration,
      playheadSeconds: made.edit.playbackTime,
      selectedClipId: info ? made.edit.getClipId(info.trackIndex, info.clipIndex) : null,
    });
  };

  const discardAgentEdit = async () => {
    if (!previewRef.current) return;
    previewRef.current = null;
    setAgentPreview(null);
    await coreRef.current?.edit.undo();
    refresh();
  };

  const keepAgentEdit = () => {
    const previewed = previewRef.current;
    if (!previewed) return;
    previewRef.current = null;
    setAgentPreview(null);
    setAgentEditsKept((kept) => [...kept, previewed]);
    recordAgentEditKept(previewed);
  };

  const previewAgentEdit: StudioSession['previewAgentEdit'] = async (card) => {
    const made = coreRef.current;
    if (!made) return false;
    // One preview at a time: another card's goes back first.
    if (previewRef.current) await discardAgentEdit();
    setBusy('Preparando a prévia…');
    try {
      const doc = made.edit.getEdit({ includeIds: true }) as unknown as EditDoc;
      const timing = timingOf(made.edit);
      const byUrl = new Map([...assetsRef.current.values()].map((asset) => [asset.url, asset]));
      const files: Record<string, { name: string; kind: StudioFileKind }> = {};
      for (const asset of assetsRef.current.values()) files[asset.id] = asset;
      for (const [id, file] of Object.entries(card.payload.files)) files[id] = file;
      // Checked again against the timeline as it is now: it may have changed since the proposal.
      const { problems } = checkTimelineOps(
        card.payload.ops,
        {
          clips: snapshotClips(doc, timing, (src) =>
            typeof src === 'string' ? (byUrl.get(src) ?? null) : null,
          ),
        },
        files as Record<string, { name: string; kind: 'video' | 'audio' | 'image' | 'subtitle' }>,
      );
      if (problems.length > 0) {
        setNotice({
          kind: 'error',
          text: `A linha do tempo mudou desde a proposta (${problems[0]}). Peça de novo ao agente.`,
        });
        return false;
      }
      const placed: Record<string, PlacedFile> = {};
      for (const [id, file] of Object.entries(card.payload.files)) {
        const asset = await resolve({ id, name: file.name, mimeType: file.mimeType });
        placed[id] = {
          url: asset.url,
          kind: file.kind,
          durationSeconds:
            file.kind === 'video' || file.kind === 'audio'
              ? await probeMediaDuration(asset.url, file.kind)
              : null,
        };
      }
      const next = applyTimelineOps(doc, card.payload.ops, {
        timing,
        output: outputSize(),
        placed,
      });
      const result = await made.edit.replaceEdit(withCleanSize(next) as unknown as EditConfig);
      if (result.status !== 'success') {
        setNotice({
          kind: 'error',
          text: 'O editor não aceitou a prévia. Peça de novo ao agente.',
        });
        return false;
      }
      previewRef.current = card.id;
      setAgentPreview({ proposalId: card.id });
      if (hasPlayableMedia(next)) setModeState('video');
      setNotice(null);
      refresh();
      return true;
    } catch (error) {
      setNotice({ kind: 'error', text: friendlyCoreError(error, 'Não deu para pré-visualizar.') });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const selectedImageForAi = (() => {
    if (!selected || selected.assetType !== 'image') return null;
    const made = coreRef.current;
    const clip = made ? (made.edit.getDocumentClipById(selected.clipId) as DocClip | null) : null;
    const src = clip?.asset?.src;
    if (typeof src !== 'string') return null;
    const asset = [...assetsRef.current.values()].find((item) => item.url === src);
    if (!asset) return null;
    const library = mediaAssetsRef.current.get(asset.id) ?? null;
    return {
      driveFileId: asset.id,
      mediaAssetId: mediaIdsRef.current.get(asset.id) ?? null,
      name: asset.name,
      clientId: library?.clientId ?? null,
      aspect: library?.aspect ?? null,
    };
  })();

  const duration = coreRef.current?.edit.totalDuration ?? totalDuration;
  const browserExport = !webCodecs
    ? {
        available: false,
        reason: 'Este navegador não exporta vídeo (sem WebCodecs): o servidor renderiza.',
      }
    : duration > STUDIO_BROWSER_EXPORT_MAX_SECONDS
      ? {
          available: true,
          reason: `Linha do tempo acima de ${STUDIO_BROWSER_EXPORT_MAX_SECONDS / 60} minutos: melhor no servidor.`,
        }
      : { available: true, reason: null };

  return {
    status,
    failure,
    stageRef,
    timelineRef,
    mode,
    setMode,
    aspect,
    setAspect,
    projectName,
    setProjectName,
    clientId,
    setClientId,
    projectFile,
    lastFolder,
    dirty,
    canUndo: coreRef.current?.edit.canUndo ?? false,
    canRedo: coreRef.current?.edit.canRedo ?? false,
    undo: async () => {
      await coreRef.current?.edit.undo();
      refresh();
    },
    redo: async () => {
      await coreRef.current?.edit.redo();
      refresh();
    },
    playing,
    playbackTime,
    totalDuration: duration,
    play: () => coreRef.current?.edit.play(),
    pause: () => coreRef.current?.edit.pause(),
    seek: (seconds) => {
      coreRef.current?.edit.seek(seconds);
      setPlaybackTime(seconds);
    },
    zoom,
    setZoom: (value) => {
      coreRef.current?.canvas.setZoom(value);
      setZoomState(value);
    },
    zoomToFit: () => {
      const made = coreRef.current;
      if (!made) return;
      made.canvas.zoomToFit();
      setZoomState(made.canvas.getZoom());
    },
    selected,
    layers,
    selectClip,
    clearSelection,
    updateSelected,
    deleteSelected,
    moveSelected,
    assets,
    addDriveFile,
    addMediaAsset,
    replaceImage,
    openProject,
    newProject,
    addText,
    addShape,
    addLogo,
    cropToAspect,
    saveProject,
    exportVideo,
    exportImage,
    browserExport,
    requestCaptions,
    transcription: transcription.data?.transcription ?? null,
    addCaptionsFromTranscription,
    dismissTranscription: () => setTranscriptionId(null),
    render: render.data?.render ?? null,
    dismissRender: () => setRenderId(null),
    timelineForAgent,
    agentPreview,
    agentEditsKept,
    previewAgentEdit,
    keepAgentEdit,
    discardAgentEdit,
    selectedImageForAi,
    busy,
    progress,
    cancel: () => abortRef.current?.abort(),
    notice,
    setNotice,
  };
}
