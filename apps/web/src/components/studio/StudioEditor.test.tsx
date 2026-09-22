import type { DriveFile, DriveFolder, StudioProjectFile } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The editor against a scripted API and a fake core. What matters here is
 * the Drive rule: a clip plays through a link, but what is saved or sent to
 * render names the file by id and never carries an address.
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

// The core: enough of Edit to hold tracks and give them back.
const core = vi.hoisted(() => {
  const state = { tracks: [] as unknown[], size: { width: 1920, height: 1080 } };
  return {
    state,
    Edit: class {
      playbackTime = 0;
      totalDuration = 12;
      constructor(public initial: unknown) {}
      async load() {}
      async addTrack(index: number, track: unknown) {
        state.tracks.splice(index, 0, track);
        return { success: true };
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
      async loadEdit(doc: { timeline: { tracks: unknown[] } }) {
        state.tracks = doc.timeline.tracks;
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
vi.mock('harfbuzzjs/hb.wasm?url', () => ({ default: '/assets/hb.wasm' }));
vi.mock('@resvg/resvg-wasm/index_bg.wasm?url', () => ({ default: '/assets/resvg.wasm' }));

const { StudioEditor } = await import('./StudioEditor.js');

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const FOLDER_ID = '22222222-2222-4222-8222-222222222222';

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
};
const video: DriveFile = {
  id: FILE_ID,
  folderId: FOLDER_ID,
  folderPath: folder.path,
  name: 'entrevista.mp4',
  mimeType: 'video/mp4',
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
} as DriveFile;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StudioEditor />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // jsdom has no WebCodecs; the editor offers the browser export only when it exists.
  Object.assign(globalThis, { VideoEncoder: class {} });
  core.state.tracks = [];
  core.state.size = { width: 1920, height: 1080 };
  get.mockReset();
  post.mockReset();
  sendFile.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path === '/drive/tree')
      return { folders: [folder], maxFileBytes: 1, storageAvailable: true };
    if (path === `/drive/folders/${FOLDER_ID}`) return { folder, files: [video] };
    if (path === `/studio/files/${FILE_ID}/link`) {
      return {
        url: 'http://storage.test/drive/2026-09/abc?sig=1',
        expiresAt: '2026-09-22T11:00:00Z',
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
});

afterEach(() => cleanup());

async function openVideoFromDrive() {
  mount();
  const open = await screen.findByRole('button', { name: 'Abrir do Drive' });
  await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(open);
  const dialog = await screen.findByRole('dialog', { name: 'Abrir do Drive' });
  fireEvent.click(await within(dialog).findByText('entrevista.mp4'));
  await waitFor(() => expect(core.state.tracks).toHaveLength(1));
}

describe('opening a Drive file', () => {
  it('puts the file on a new track, playing through the hour-long link', async () => {
    await openVideoFromDrive();
    expect(get).toHaveBeenCalledWith(`/studio/files/${FILE_ID}/link`);
    const track = core.state.tracks[0] as { clips: { asset: { src: string; type: string } }[] };
    expect(track.clips[0]?.asset).toMatchObject({
      type: 'video',
      src: 'http://storage.test/drive/2026-09/abc?sig=1',
    });
    expect(
      screen.getByRole('list', { name: 'Arquivos do Drive neste projeto' })?.textContent,
    ).toContain('entrevista.mp4');
  });
});

describe('saving the project', () => {
  it('writes a JSON to the Drive that names the file by id, never by address', async () => {
    await openVideoFromDrive();
    sendFile.mockResolvedValue({
      ...video,
      id: 'p',
      name: 'Novo projeto.wings-studio.json',
      version: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar projeto' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar projeto no Drive' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(sendFile).toHaveBeenCalledTimes(1));
    const input = sendFile.mock.calls[0]?.[0] as { folderId: string; file: File };
    expect(input.folderId).toBe(FOLDER_ID);
    expect(input.file.name).toBe('Novo projeto.wings-studio.json');
    const saved = JSON.parse(await input.file.text()) as StudioProjectFile;
    expect(saved.kind).toBe('wings-studio-project');
    expect(saved.assets[FILE_ID]).toEqual({ name: 'entrevista.mp4', mimeType: 'video/mp4' });
    expect(JSON.stringify(saved)).not.toContain('storage.test');
    expect(JSON.stringify(saved)).not.toContain('sig=');
    expect(JSON.stringify(saved)).toContain(`wings-drive://${FILE_ID}`);
    expect(await screen.findByText(/Projeto salvo no Drive/)).toBeTruthy();
  });
});

describe('exporting', () => {
  it('renders in the browser and sends the MP4 to the chosen folder', async () => {
    await openVideoFromDrive();
    sendFile.mockResolvedValue({ ...video, id: 'v', name: 'Novo projeto.mp4', version: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Exportar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar vídeo para o Drive' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exportar no navegador' }));

    await waitFor(() => expect(sendFile).toHaveBeenCalledTimes(1));
    const input = sendFile.mock.calls[0]?.[0] as { folderId: string; file: File };
    expect(input.file.name).toBe('Novo projeto.mp4');
    expect(input.file.type).toBe('video/mp4');
    expect(post).not.toHaveBeenCalled();
  });

  it('asks the server to render with wings-drive references only, then follows the job', async () => {
    await openVideoFromDrive();
    post.mockResolvedValue({
      render: {
        id: 'job-1',
        state: 'pending',
        error: null,
        unsupported: [],
        file: null,
        destination: { folderId: FOLDER_ID, name: 'Novo projeto.mp4', replaceFileId: null },
        createdAt: '2026-09-22T10:00:00.000Z',
        finishedAt: null,
      },
    });
    get.mockImplementation(async (path: string) => {
      if (path === '/studio/renders/job-1') {
        return {
          render: {
            id: 'job-1',
            state: 'done',
            error: null,
            unsupported: ['faixa 1, clipe 1: transition wipeLeft rendered as cut'],
            file: { id: 'f', version: 1 },
            destination: { folderId: FOLDER_ID, name: 'Novo projeto.mp4', replaceFileId: null },
            createdAt: '2026-09-22T10:00:00.000Z',
            finishedAt: '2026-09-22T10:02:00.000Z',
          },
        };
      }
      if (path === '/studio/renders') return { renders: [] };
      throw new Error(`unexpected GET ${path}`);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Exportar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar vídeo para o Drive' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Renderizar no servidor' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
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

    const status = await screen.findByText(/Render no servidor: Pronto/);
    expect(status.closest('.studio-render')?.textContent).toContain(
      'Salvo no Drive como "Novo projeto.mp4"',
    );
    expect(status.closest('.studio-render')?.textContent).toContain('wipeLeft');
  });
});
