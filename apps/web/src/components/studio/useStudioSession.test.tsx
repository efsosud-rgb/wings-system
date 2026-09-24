import type { DriveFile, DriveFolder, MediaAsset, StudioProjectFile } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioSession } from './session.js';

/**
 * The editor's brain against a scripted API and a fake core. What matters
 * here is the Drive rule: a clip plays through a link, but what is saved or
 * sent to render names the file by id and never carries an address; and the
 * new doors of part 2 (image export, captions, properties, mode) go through
 * the same core methods the real one has.
 */

const get = vi.fn();
const post = vi.fn();
vi.mock('../../api/client.js', async (original) => ({
  ...(await original<typeof import('../../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

const sendFile = vi.fn();
vi.mock('../../api/drive.js', async (original) => ({
  ...(await original<typeof import('../../api/drive.js')>()),
  sendFile: (input: unknown) => sendFile(input),
}));

interface FakeClip {
  id: string;
  asset: Record<string, unknown> & { type: string; src?: string };
  start: number | string;
  length: number | string;
  [key: string]: unknown;
}

// The core: enough of Edit to hold tracks, select clips and give them back.
const core = vi.hoisted(() => {
  type Listener = (payload?: unknown) => void;
  const state = {
    tracks: [] as { clips: FakeClip[] }[],
    size: { width: 1920, height: 1080 },
    nextId: 1,
    zoom: 0.5,
  };
  return {
    state,
    Edit: class {
      playbackTime = 0;
      totalDuration = 12;
      isPlaying = false;
      canUndo = false;
      canRedo = false;
      private listeners = new Map<string, Set<Listener>>();
      private selected: { trackIndex: number; clipIndex: number } | null = null;
      events = {
        on: (name: string, listener: Listener) => {
          const set = this.listeners.get(name) ?? new Set();
          set.add(listener);
          this.listeners.set(name, set);
          return () => set.delete(listener);
        },
      };
      constructor(public initial: unknown) {}
      emit(name: string, payload?: unknown) {
        for (const listener of this.listeners.get(name) ?? []) listener(payload);
      }
      private stamp(clip: Record<string, unknown>): FakeClip {
        const id = `clip-${state.nextId++}`;
        return { ...clip, id } as FakeClip;
      }
      async load() {}
      async addTrack(index: number, track: { clips: Record<string, unknown>[] }) {
        state.tracks.splice(index, 0, { clips: track.clips.map((clip) => this.stamp(clip)) });
        this.emit('clip:added', { trackIndex: index, clipIndex: 0 });
        this.emit('edit:changed', { source: 'test', timestamp: 0 });
        return { success: true };
      }
      async addSvgClip(
        markup: string,
        opts: { trackIndex?: number; start?: number; length?: number },
      ) {
        // The real core keeps the xmlns; anything else with an address is refused.
        if (/(src|href)="https?:/.test(markup)) throw new Error('svg with an address');
        await this.addTrack(opts.trackIndex ?? 0, {
          clips: [
            {
              asset: { type: 'svg', src: markup },
              start: opts.start ?? 0,
              length: opts.length ?? 5,
            },
          ],
        });
      }
      async setOutputSize(width: number, height: number) {
        state.size = { width, height };
        return { success: true };
      }
      getEdit() {
        return {
          timeline: { background: '#000000', tracks: state.tracks },
          output: { format: 'mp4', fps: 30, size: state.size },
        };
      }
      async loadEdit(doc: { timeline: { tracks: { clips: Record<string, unknown>[] }[] } }) {
        state.tracks = doc.timeline.tracks.map((track) => ({
          clips: track.clips.map((clip) => this.stamp(clip)),
        }));
        this.selected = null;
        this.emit('timeline:updated', { current: this.getEdit() });
      }
      private find(clipId: string) {
        for (const [trackIndex, track] of state.tracks.entries()) {
          const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);
          if (clipIndex !== -1)
            return { trackIndex, clipIndex, clip: track.clips[clipIndex] as FakeClip };
        }
        return null;
      }
      getClipId(trackIndex: number, clipIndex: number) {
        return state.tracks[trackIndex]?.clips[clipIndex]?.id ?? null;
      }
      getClipPositionById(clipId: string) {
        const found = this.find(clipId);
        return found ? { trackIndex: found.trackIndex, clipIndex: found.clipIndex } : null;
      }
      getDocumentClipById(clipId: string) {
        return this.find(clipId)?.clip ?? null;
      }
      getResolvedClipById(clipId: string) {
        const found = this.find(clipId);
        if (!found) return null;
        return {
          ...found.clip,
          start: typeof found.clip.start === 'number' ? found.clip.start : 0,
          length: typeof found.clip.length === 'number' ? found.clip.length : 5,
        };
      }
      getSelectedClipInfo() {
        return this.selected ? { ...this.selected, player: {} } : null;
      }
      selectClip(trackIndex: number, clipIndex: number) {
        this.selected = { trackIndex, clipIndex };
        this.emit('clip:selected', {
          trackIndex,
          clipIndex,
          clip: state.tracks[trackIndex]?.clips[clipIndex],
        });
      }
      clearSelection() {
        this.selected = null;
        this.emit('selection:cleared');
      }
      async updateClipById(clipId: string, updates: Record<string, unknown>) {
        const found = this.find(clipId);
        if (!found) return { success: false };
        Object.assign(found.clip, updates);
        this.emit('clip:updated', {});
        this.emit('edit:changed', { source: 'test', timestamp: 0 });
        return { success: true };
      }
      async deleteClipById(clipId: string) {
        const found = this.find(clipId);
        if (!found) return { success: false };
        state.tracks[found.trackIndex]?.clips.splice(found.clipIndex, 1);
        this.selected = null;
        this.emit('clip:deleted', {});
        return { success: true };
      }
      ensureTrackExists(trackIndex: number) {
        while (state.tracks.length <= trackIndex) state.tracks.push({ clips: [] });
      }
      async moveClipById(clipId: string, toTrackIndex: number, newStart?: number) {
        const found = this.find(clipId);
        if (!found) return { success: false };
        state.tracks[found.trackIndex]?.clips.splice(found.clipIndex, 1);
        this.ensureTrackExists(toTrackIndex);
        if (newStart !== undefined) found.clip.start = newStart;
        state.tracks[toTrackIndex]?.clips.push(found.clip);
        this.selected = {
          trackIndex: toTrackIndex,
          clipIndex: (state.tracks[toTrackIndex]?.clips.length ?? 1) - 1,
        };
        this.emit('edit:changed', { source: 'test', timestamp: 0 });
        return { success: true };
      }
      play() {
        this.isPlaying = true;
        this.emit('playback:play');
      }
      pause() {
        this.isPlaying = false;
        this.emit('playback:pause');
      }
      seek(target: number) {
        this.playbackTime = target;
      }
      async undo() {}
      async redo() {}
      dispose() {}
    },
  };
});
vi.mock('@wings/studio', () => ({
  configureStudio: vi.fn(),
  Edit: core.Edit,
  Canvas: class {
    constructor(public edit: unknown) {}
    async load() {}
    getZoom() {
      return core.state.zoom;
    }
    setZoom(zoom: number) {
      core.state.zoom = zoom;
    }
    resize() {
      /* the real one measures the stage box and refits */
    }
    zoomToFit() {
      core.state.zoom = 0.4;
    }
    async captureFrame(options: { format?: string }) {
      const type = options.format === 'jpeg' ? 'image/jpeg' : 'image/png';
      return `data:${type};base64,${btoa('frame bytes')}`;
    }
    dispose() {}
  },
  Timeline: class {
    constructor(public edit: unknown) {}
    async load() {}
    dispose() {}
  },
  Controls: class {
    constructor(public edit: unknown) {}
    async load() {}
    dispose() {}
  },
  VideoExporter: class {
    constructor(public edit: unknown) {}
    async render() {
      return new Blob(['mp4 bytes'], { type: 'video/mp4' });
    }
    dispose() {}
  },
}));
// jsdom never loads media: the probe is scripted, and the clip must carry what it answered.
const probeMediaDuration = vi.fn(async () => 84.16);
vi.mock('./media-probe.js', () => ({
  probeMediaDuration: (...args: unknown[]) => probeMediaDuration(...(args as [])),
}));
vi.mock('harfbuzzjs/hb.wasm?url', () => ({ default: '/assets/hb.wasm' }));
vi.mock('@resvg/resvg-wasm/index_bg.wasm?url', () => ({ default: '/assets/resvg.wasm' }));

const { useStudioSession } = await import('./useStudioSession.js');
const { useStudioShortcuts } = await import('./useStudioShortcuts.js');

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const IMAGE_ID = '33333333-3333-4333-8333-333333333333';
const SRT_ID = '44444444-4444-4444-8444-444444444444';
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '55555555-5555-4555-8555-555555555555';
const LINK = 'http://storage.test/drive/2026-09/abc?sig=1';

const folder: DriveFolder = {
  id: FOLDER_ID,
  parentId: null,
  name: 'Mídia',
  path: '/Formatação/Marketing/Mídia',
  department: 'marketing',
  clientId: null,
  origin: 'template',
  accessible: true,
  canWrite: true,
  managed: true,
  slot: null,
};
const baseFile = {
  folderId: FOLDER_ID,
  folderPath: folder.path,
  byteSize: 1000,
  version: 1,
  ownerId: null,
  ownerName: null,
  clientId: null,
  clientName: null,
  tags: [],
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
  trashedAt: null,
  purgeAt: null,
  canWrite: true,
};
const video = {
  ...baseFile,
  id: FILE_ID,
  name: 'entrevista.mp4',
  mimeType: 'video/mp4',
} as DriveFile;
const image = { ...baseFile, id: IMAGE_ID, name: 'capa.png', mimeType: 'image/png' } as DriveFile;

/** Renders the hook and hands its latest value to the test. */
let latest: StudioSession | null = null;
const onSave = vi.fn();
function Harness() {
  const session = useStudioSession();
  useStudioShortcuts(session, { onSave });
  latest = session;
  return (
    <>
      <div ref={session.stageRef}>
        <div data-shotstack-studio />
      </div>
      <div ref={session.timelineRef} />
      <input aria-label="nome" />
    </>
  );
}

async function mount(): Promise<StudioSession> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Harness />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(latest?.status).toBe('ready'));
  return latest as StudioSession;
}

const session = () => latest as StudioSession;

beforeEach(() => {
  Object.assign(globalThis, { VideoEncoder: class {} });
  core.state.tracks = [];
  core.state.size = { width: 1920, height: 1080 };
  core.state.nextId = 1;
  latest = null;
  onSave.mockReset();
  get.mockReset();
  post.mockReset();
  sendFile.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path === `/studio/files/${FILE_ID}/link`)
      return { url: LINK, expiresAt: '2026-09-22T11:00:00Z' };
    if (path === `/studio/files/${IMAGE_ID}/link`)
      return {
        url: 'http://storage.test/drive/2026-09/img?sig=2',
        expiresAt: '2026-09-22T11:00:00Z',
      };
    if (path === `/studio/files/${SRT_ID}/link`)
      return {
        url: 'http://storage.test/drive/2026-09/legenda.srt?sig=3',
        expiresAt: '2026-09-22T11:00:00Z',
      };
    throw new Error(`unexpected GET ${path}`);
  });
});

afterEach(() => cleanup());

const savedJson = async () => {
  const input = sendFile.mock.calls[0]?.[0] as { folderId: string; file: File };
  return { input, saved: JSON.parse(await input.file.text()) as StudioProjectFile };
};

describe('files from the Drive', () => {
  it('puts a video on a new track through the hour-long link and turns into video mode', async () => {
    await mount();
    expect(session().mode).toBe('image');
    await act(() => session().addDriveFile(video, folder));
    expect(get).toHaveBeenCalledWith(`/studio/files/${FILE_ID}/link`);
    expect(core.state.tracks[0]?.clips[0]?.asset).toMatchObject({ type: 'video', src: LINK });
    // Born with the file's real length, read by the browser first; never the core's guess.
    expect(probeMediaDuration).toHaveBeenCalledWith(LINK, 'video');
    expect(core.state.tracks[0]?.clips[0]?.length).toBe(84.16);
    await waitFor(() => expect(session().mode).toBe('video'));
    expect(session().assets.map((asset) => asset.name)).toEqual(['entrevista.mp4']);
    // Video on the timeline: it cannot become a still.
    expect(session().setMode('image')).toBe(false);
    await waitFor(() => expect(session().notice?.kind).toBe('info'));
  });

  it('keeps an image project in image mode with every layer starting at zero', async () => {
    await mount();
    await act(() => session().addDriveFile(image, folder));
    expect(session().mode).toBe('image');
    await act(() => session().addText('title'));
    const clips = core.state.tracks.flatMap((track) => track.clips);
    expect(clips.map((clip) => clip.start)).toEqual([0, 0]);
    expect(clips.map((clip) => clip.length)).toEqual([5, 5]);
    expect(session().layers.map((layer) => layer.assetType)).toEqual(['rich-text', 'image']);
  });

  it('uses a library asset by its Drive file id and refuses one that is not in the Drive', async () => {
    await mount();
    const asset = {
      id: 'asset-1',
      kind: 'image',
      mimeType: 'image/png',
      driveFileId: IMAGE_ID,
    } as MediaAsset;
    await act(() => session().addMediaAsset(asset));
    expect(get).toHaveBeenCalledWith(`/studio/files/${IMAGE_ID}/link`);
    await act(() =>
      session().addMediaAsset({ ...asset, id: 'asset-2', driveFileId: null } as MediaAsset),
    );
    expect(session().notice?.kind).toBe('error');
    expect(core.state.tracks).toHaveLength(1);
  });
});

describe('saving the project', () => {
  it('writes a JSON that names files by id and carries the client, never an address', async () => {
    await mount();
    await act(() => session().addDriveFile(video, folder));
    await act(() => session().addShape('rect'));
    act(() => session().setClientId(CLIENT_ID));
    expect(session().dirty).toBe(true);
    sendFile.mockResolvedValue({
      ...video,
      id: 'p',
      name: 'Novo projeto.wings-studio.json',
      version: 1,
    });

    await act(() => session().saveProject({ folder, name: 'Novo projeto' }));

    const { input, saved } = await savedJson();
    expect(input.folderId).toBe(FOLDER_ID);
    expect(input.file.name).toBe('Novo projeto.wings-studio.json');
    expect(saved.kind).toBe('wings-studio-project');
    expect(saved.clientId).toBe(CLIENT_ID);
    expect(saved.assets[FILE_ID]).toEqual({ name: 'entrevista.mp4', mimeType: 'video/mp4' });
    const text = JSON.stringify(saved);
    expect(text).toContain(`wings-drive://${FILE_ID}`);
    expect(text).not.toContain('storage.test');
    expect(text).not.toContain('sig=');
    // The SVG namespace is an identifier, not a link; nothing else may look like one.
    expect(text.replace(/xmlns=\\"http:\/\/www\.w3\.org\/2000\/svg\\"/g, '')).not.toContain('http');
    expect(session().dirty).toBe(false);
    expect(session().projectFile).toEqual({ id: 'p', folderId: FOLDER_ID });
  });

  it('opens a saved project, resolving each id into a link', async () => {
    await mount();
    const project: StudioProjectFile = {
      kind: 'wings-studio-project',
      version: 1,
      name: 'Corte',
      aspect: '9:16',
      clientId: CLIENT_ID,
      edit: {
        timeline: {
          background: '#000000',
          tracks: [
            {
              clips: [
                {
                  asset: { type: 'video', src: `wings-drive://${FILE_ID}` },
                  start: 0,
                  length: 'auto',
                },
              ],
            },
          ],
        },
        output: { format: 'mp4', fps: 30, size: { width: 1080, height: 1920 } },
      },
      assets: { [FILE_ID]: { name: 'entrevista.mp4', mimeType: 'video/mp4' } },
    };
    const projectFile = {
      ...baseFile,
      id: 'p1',
      name: 'Corte.wings-studio.json',
      mimeType: 'application/json',
    } as DriveFile;
    get.mockImplementation(async (path: string) => {
      if (path === '/studio/files/p1/link') return { url: 'http://storage.test/p1', expiresAt: '' };
      if (path === `/studio/files/${FILE_ID}/link`) return { url: LINK, expiresAt: '' };
      throw new Error(`unexpected GET ${path}`);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(project), { status: 200 })),
    );

    await act(() => session().openProject(projectFile, folder));

    expect(core.state.tracks[0]?.clips[0]?.asset.src).toBe(LINK);
    expect(session().projectName).toBe('Corte');
    expect(session().clientId).toBe(CLIENT_ID);
    expect(session().aspect).toBe('9:16');
    expect(session().mode).toBe('video');
    vi.unstubAllGlobals();
  });
});

describe('exporting', () => {
  it('renders in the browser and sends the MP4 to the chosen folder', async () => {
    await mount();
    await act(() => session().addDriveFile(video, folder));
    sendFile.mockResolvedValue({ ...video, id: 'v', name: 'Novo projeto.mp4', version: 1 });
    await act(() => session().exportVideo({ folder, name: 'Novo projeto' }, 'browser'));
    const input = sendFile.mock.calls[0]?.[0] as { file: File };
    expect(input.file.name).toBe('Novo projeto.mp4');
    expect(input.file.type).toBe('video/mp4');
    expect(post).not.toHaveBeenCalled();
  });

  it('asks the server to render with wings-drive references only, then follows the job', async () => {
    await mount();
    await act(() => session().addDriveFile(video, folder));
    const render = {
      id: 'job-1',
      state: 'pending',
      error: null,
      unsupported: [],
      file: null,
      destination: { folderId: FOLDER_ID, name: 'Novo projeto.mp4', replaceFileId: null },
      createdAt: '2026-09-22T10:00:00.000Z',
      finishedAt: null,
    };
    post.mockResolvedValue({ render });
    get.mockImplementation(async (path: string) => {
      if (path === '/studio/renders/job-1')
        return { render: { ...render, state: 'done', file: { id: 'f', version: 1 } } };
      if (path === '/studio/renders') return { renders: [] };
      throw new Error(`unexpected GET ${path}`);
    });

    await act(() => session().exportVideo({ folder, name: 'Novo projeto' }, 'server'));

    const [path, body] = post.mock.calls[0] as [string, { project: unknown; destination: unknown }];
    expect(path).toBe('/studio/renders');
    expect(body.destination).toEqual({
      folderId: FOLDER_ID,
      name: 'Novo projeto.mp4',
      replaceFileId: undefined,
    });
    expect(JSON.stringify(body.project)).toContain(`wings-drive://${FILE_ID}`);
    expect(JSON.stringify(body.project)).not.toContain('storage.test');
    expect(sendFile).not.toHaveBeenCalled();
    await waitFor(() => expect(session().render?.state).toBe('done'));
  });

  it('exports a still as PNG at output size and files it in the Drive', async () => {
    await mount();
    await act(() => session().addDriveFile(image, folder));
    sendFile.mockResolvedValue({ ...image, id: 'i', name: 'capa final.png', version: 1 });
    await act(() => session().exportImage({ folder, name: 'capa final', format: 'png' }));
    const input = sendFile.mock.calls[0]?.[0] as { folderId: string; file: File };
    expect(input.folderId).toBe(FOLDER_ID);
    expect(input.file.name).toBe('capa final.png');
    expect(input.file.type).toBe('image/png');
    expect(await input.file.text()).toBe('frame bytes');
    expect(session().notice?.kind).toBe('success');

    sendFile.mockClear();
    await act(() =>
      session().exportImage({ folder, name: 'capa.png', format: 'jpeg', quality: 0.8 }),
    );
    const jpeg = sendFile.mock.calls[0]?.[0] as { file: File };
    expect(jpeg.file.name).toBe('capa.jpg');
    expect(jpeg.file.type).toBe('image/jpeg');
  });
});

describe('the selected item', () => {
  it('maps a properties patch onto the core field names, one command each', async () => {
    await mount();
    await act(() => session().addText('title'));
    await act(() => session().addDriveFile(image, folder));
    // Selecting through the core (a click on the canvas would do this).
    const imageId = core.state.tracks[0]?.clips[0]?.id as string;
    act(() => session().selectClip(imageId));
    await waitFor(() => expect(session().selected?.assetType).toBe('image'));
    expect(session().selected).toMatchObject({
      position: 'center',
      opacity: 1,
      scale: 1,
      text: null,
    });

    await act(() =>
      session().updateSelected({ position: 'topRight', opacity: 0.5, offset: { x: 0.1, y: -0.2 } }),
    );
    const imageClip = core.state.tracks[0]?.clips[0] as FakeClip;
    expect(imageClip).toMatchObject({
      position: 'topRight',
      opacity: 0.5,
      offset: { x: 0.1, y: -0.2 },
    });

    const textId = core.state.tracks[1]?.clips[0]?.id as string;
    act(() => session().selectClip(textId));
    await waitFor(() => expect(session().selected?.text?.text).toBe('Título'));
    await act(() =>
      session().updateSelected({
        text: { text: 'Franquia Wings', size: 60, color: '#ff0000', horizontal: 'left' },
      }),
    );
    const textClip = core.state.tracks[1]?.clips[0] as FakeClip;
    expect(textClip.asset).toMatchObject({
      type: 'rich-text',
      text: 'Franquia Wings',
      font: { family: 'Work Sans', size: 60, color: '#ff0000', weight: 600 },
      align: { horizontal: 'left', vertical: 'middle' },
    });

    await act(() => session().moveSelected('down'));
    expect(core.state.tracks[2]?.clips[0]?.id).toBe(textId);
    await act(() => session().deleteSelected());
    expect(core.state.tracks.flatMap((track) => track.clips).map((clip) => clip.id)).toEqual([
      imageId,
    ]);
  });

  it('names the selected image for the AI panel when it came from the library', async () => {
    await mount();
    await act(() =>
      session().addMediaAsset({
        id: 'asset-9',
        kind: 'image',
        mimeType: 'image/png',
        driveFileId: IMAGE_ID,
      } as MediaAsset),
    );
    act(() => session().selectClip(core.state.tracks[0]?.clips[0]?.id as string));
    await waitFor(() =>
      expect(session().selectedImageForAi).toEqual({
        driveFileId: IMAGE_ID,
        mediaAssetId: 'asset-9',
        name: 'imagem-asset-9',
      }),
    );
  });
});

describe('shapes and captions', () => {
  it('adds a shape as inline SVG without an address and recolours it', async () => {
    await mount();
    await act(() => session().addShape('circle', '#123456'));
    const shape = core.state.tracks[0]?.clips[0] as FakeClip;
    expect(shape.asset.type).toBe('svg');
    expect(shape.asset.src).toContain('<circle');
    expect(shape.asset.src).toContain('fill="#123456"');
    expect(shape.asset.src).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    act(() => session().selectClip(shape.id));
    await waitFor(() => expect(session().selected?.fill).toBe('#123456'));
    await act(() => session().updateSelected({ fill: '#00ff00' }));
    expect((core.state.tracks[0]?.clips[0] as FakeClip).asset.src).toContain('fill="#00ff00"');
    // The saved project keeps the markup as it is: it is not a file.
    sendFile.mockResolvedValue({ ...image, id: 'p', name: 'x.wings-studio.json', version: 1 });
    await act(() => session().saveProject({ folder, name: 'x' }));
    const { saved } = await savedJson();
    expect(JSON.stringify(saved)).toContain('<circle');
  });

  it('asks Whisper for a caption file, follows the job and puts the SRT on top', async () => {
    await mount();
    await act(() => session().addDriveFile(video, folder));
    const queued = {
      id: 't-1',
      state: 'pending',
      error: null,
      sourceFileId: FILE_ID,
      file: null,
      language: null,
      segments: null,
      createdAt: '2026-09-22T10:00:00.000Z',
      finishedAt: null,
    };
    post.mockResolvedValue({ transcription: queued });
    get.mockImplementation(async (path: string) => {
      if (path === '/studio/transcriptions/t-1')
        return {
          transcription: {
            ...queued,
            state: 'done',
            file: { id: SRT_ID, version: 1, name: 'entrevista.srt', folderId: FOLDER_ID },
            language: 'pt',
            segments: 12,
          },
        };
      if (path === `/studio/files/${SRT_ID}/link`)
        return { url: 'http://storage.test/drive/2026-09/legenda.srt?sig=3', expiresAt: '' };
      if (path === `/studio/files/${FILE_ID}/link`) return { url: LINK, expiresAt: '' };
      throw new Error(`unexpected GET ${path}`);
    });

    await act(() => session().requestCaptions(FILE_ID, 'pt'));
    expect(post).toHaveBeenCalledWith('/studio/transcriptions', {
      fileId: FILE_ID,
      language: 'pt',
    });
    await waitFor(() => expect(session().transcription?.state).toBe('done'));

    await act(() => session().addCaptionsFromTranscription());
    const top = core.state.tracks[0]?.clips[0] as FakeClip;
    expect(top.asset).toMatchObject({
      type: 'rich-caption',
      src: 'http://storage.test/drive/2026-09/legenda.srt?sig=3',
    });
    expect(top.length).toBe('end');

    // Saved, the caption cites the SRT by id like any other file.
    sendFile.mockResolvedValue({ ...video, id: 'p', name: 'x.wings-studio.json', version: 1 });
    await act(() => session().saveProject({ folder, name: 'x' }));
    const { saved } = await savedJson();
    expect(JSON.stringify(saved)).toContain(`wings-drive://${SRT_ID}`);
    expect(JSON.stringify(saved)).not.toContain('legenda.srt?sig');
  });

  it('refuses captions for something that is not a video or audio of this project', async () => {
    await mount();
    await act(() => session().addDriveFile(image, folder));
    await act(() => session().requestCaptions(IMAGE_ID));
    expect(post).not.toHaveBeenCalled();
    expect(session().notice?.kind).toBe('error');
  });
});

describe('shortcuts, zoom and a new project', () => {
  it('saves on S, not while typing, and clears the selection on Escape', async () => {
    await mount();
    await act(() => session().addText('body'));
    act(() => session().selectClip(core.state.tracks[0]?.clips[0]?.id as string));
    await waitFor(() => expect(session().selected).not.toBeNull());

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    const input = document.querySelector('input[aria-label="nome"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }));
    });
    expect(onSave).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await waitFor(() => expect(session().selected).toBeNull());
  });

  it('zooms through the canvas and starts over only when allowed', async () => {
    await mount();
    act(() => session().setZoom(1.5));
    expect(core.state.zoom).toBe(1.5);
    expect(session().zoom).toBe(1.5);
    act(() => session().zoomToFit());
    expect(session().zoom).toBe(0.4);

    await act(() => session().addDriveFile(video, folder));
    expect(session().newProject({ mode: 'image' })).toBe(false);
    expect(session().newProject({ mode: 'image', aspect: '1:1', force: true })).toBe(true);
    await waitFor(() => expect(core.state.tracks).toHaveLength(0));
    await waitFor(() => expect(session().mode).toBe('image'));
    expect(session().aspect).toBe('1:1');
    expect(session().assets).toEqual([]);
    expect(session().dirty).toBe(false);
  });
});
