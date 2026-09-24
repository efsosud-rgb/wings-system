import type { DriveFolder, MediaAsset, SessionUser, StudioTranscription } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_DRAG_MIME, type StudioSession } from '../session.js';

/**
 * The workspace against a stub session: every button ends in one session
 * call, drags carry one MIME, and the dock shows the timeline or the layers
 * by the mode. The session itself (the core, the Drive rule) has its own tests.
 */

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../api/client.js', async (original) => ({
  ...(await original<typeof import('../../../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    patch: vi.fn(),
    upload: vi.fn(),
  },
}));
vi.mock('../../../api/auth.js', () => ({
  useSession: () => ({ data: null as SessionUser | null, isLoading: false }),
  hasPermission: () => true,
}));
vi.mock('../../agent-chat/AgentChat.js', () => ({ AgentChat: () => <div>chat do agente</div> }));
vi.mock('../PropertiesPanel.js', () => ({ PropertiesPanel: () => <div>propriedades</div> }));
vi.mock('../LayersPanel.js', () => ({ LayersPanel: () => <div>painel de camadas</div> }));
const shortcuts = vi.fn();
vi.mock('../useStudioShortcuts.js', () => ({
  useStudioShortcuts: (session: unknown, options: unknown) => shortcuts(session, options),
}));
const current = { session: null as StudioSession | null };
vi.mock('../useStudioSession.js', () => ({ useStudioSession: () => current.session }));

const { StudioWorkspace } = await import('./StudioWorkspace.js');

const folder: DriveFolder = {
  id: '11111111-1111-4111-8111-111111111f01',
  parentId: null,
  name: 'Marketing',
  path: '/Marketing',
  department: 'marketing' as DriveFolder['department'],
  clientId: null,
  origin: 'template' as DriveFolder['origin'],
  accessible: true,
  canWrite: true,
  managed: false,
  slot: null,
};

const asset: MediaAsset = {
  id: 'asset-1',
  kind: 'image',
  origin: 'kairogen',
  mimeType: 'image/png',
  byteSize: 1000,
  width: 1080,
  height: 1080,
  aspect: '1:1',
  durationSeconds: null,
  prompt: 'Fachada ao pôr do sol',
  model: 'seedream-v4',
  credits: 4,
  clientId: '11111111-1111-4111-8111-111111111c01',
  client: 'Wings Company',
  folder: null,
  tags: [],
  ownerName: null,
  createdAt: '2026-09-22T12:00:00.000Z',
  downloadPath: '/media/assets/asset-1/file',
  driveFileId: '11111111-1111-4111-8111-111111111d01',
};

function stubSession(overrides: Partial<StudioSession> = {}): StudioSession {
  return {
    status: 'ready',
    failure: null,
    stageRef: { current: null },
    timelineRef: { current: null },
    mode: 'video',
    setMode: vi.fn(() => true),
    aspect: '16:9',
    setAspect: vi.fn(async () => undefined),
    projectName: 'Campanha RJ',
    setProjectName: vi.fn(),
    clientId: null,
    setClientId: vi.fn(),
    projectFile: null,
    lastFolder: folder,
    dirty: false,
    canUndo: false,
    canRedo: false,
    undo: vi.fn(async () => undefined),
    redo: vi.fn(async () => undefined),
    playing: false,
    playbackTime: 0,
    totalDuration: 12,
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    zoom: 0.5,
    setZoom: vi.fn(),
    zoomToFit: vi.fn(),
    selected: null,
    layers: [],
    selectClip: vi.fn(),
    clearSelection: vi.fn(),
    updateSelected: vi.fn(async () => undefined),
    deleteSelected: vi.fn(async () => undefined),
    moveSelected: vi.fn(async () => undefined),
    timelineForAgent: vi.fn(() => null),
    agentPreview: null,
    agentEditsKept: [],
    previewAgentEdit: vi.fn(async () => true),
    keepAgentEdit: vi.fn(),
    discardAgentEdit: vi.fn(async () => undefined),
    assets: [
      { id: 'a1', name: 'entrevista.mp4', mimeType: 'video/mp4', url: 'blob:x', kind: 'video' },
    ],
    addDriveFile: vi.fn(async () => undefined),
    addMediaAsset: vi.fn(async () => undefined),
    openProject: vi.fn(async () => undefined),
    newProject: vi.fn(() => true),
    addText: vi.fn(async () => undefined),
    addShape: vi.fn(async () => undefined),
    addLogo: vi.fn(async () => undefined),
    cropToAspect: vi.fn(async () => undefined),
    saveProject: vi.fn(async () => undefined),
    exportVideo: vi.fn(async () => undefined),
    exportImage: vi.fn(async () => undefined),
    browserExport: { available: true, reason: null },
    requestCaptions: vi.fn(async () => undefined),
    transcription: null,
    addCaptionsFromTranscription: vi.fn(async () => undefined),
    dismissTranscription: vi.fn(),
    render: null,
    dismissRender: vi.fn(),
    selectedImageForAi: null,
    busy: null,
    progress: null,
    cancel: vi.fn(),
    notice: null,
    setNotice: vi.fn(),
    ...overrides,
  };
}

function renderWorkspace(session: StudioSession) {
  current.session = session;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StudioWorkspace
          canGenerate
          anyAvailable
          usageLine="Kairogen 94 créditos · mês R$ 12,00 de R$ 300,00"
          getBuilderDraft={() => undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** A drag event with a data transfer jsdom does not provide. */
function dragEvent(type: string, transfer: Partial<DataTransfer> & { types?: string[] }) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      setData: vi.fn(),
      getData: vi.fn(() => ''),
      types: [],
      effectAllowed: '',
      dropEffect: '',
      ...transfer,
    },
  });
  return event;
}

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  shortcuts.mockReset();
  localStorage.clear();
  get.mockImplementation((path: string) => {
    if (path === '/clients') return Promise.resolve({ clients: [] });
    if (path.startsWith('/media/assets'))
      return Promise.resolve({ assets: [asset], storageAvailable: true });
    if (path === '/media/generations') return Promise.resolve({ generations: [] });
    if (path === '/drive/tree')
      return Promise.resolve({ folders: [folder], maxFileBytes: 1, storageAvailable: true });
    if (path.startsWith('/drive/folders/')) return Promise.resolve({ folder, files: [] });
    if (path.startsWith('/drive/search')) return Promise.resolve({ files: [] });
    if (path.startsWith('/media/models'))
      return Promise.resolve({ models: [], cachedAt: '', problems: {} });
    if (path === '/media/providers') return Promise.resolve({ providers: [], spend: {} });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});
afterEach(cleanup);

describe('the top bar', () => {
  it('shows the project, the client, the format and the mode, and changes the format', () => {
    const session = stubSession();
    renderWorkspace(session);
    expect(screen.getByRole('button', { name: 'Campanha RJ' })).toBeTruthy();
    expect(screen.getByLabelText('Para quem')).toBeTruthy();
    expect(screen.getByText('Kairogen 94 créditos · mês R$ 12,00 de R$ 300,00')).toBeTruthy();
    const formats = screen.getByRole('group', { name: 'Formato' });
    expect(within(formats).getByRole('button', { name: '16:9' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(within(formats).getByRole('button', { name: '9:16' }));
    expect(session.setAspect).toHaveBeenCalledWith('9:16');
    expect(session.cropToAspect).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole('group', { name: 'Tipo de peça' }))
        .getByRole('button', { name: 'Vídeo' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('crops instead of resizing when the piece is an image, and keeps undo off with nothing to undo', () => {
    const session = stubSession({ mode: 'image', assets: [], canUndo: false, canRedo: true });
    renderWorkspace(session);
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Formato' })).getByRole('button', { name: '4:5' }),
    );
    expect(session.cropToAspect).toHaveBeenCalledWith('4:5');
    expect(screen.getByRole('button', { name: 'Desfazer' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Refazer' })).toHaveProperty('disabled', false);
  });

  it('renames the project on Enter', () => {
    const session = stubSession();
    renderWorkspace(session);
    fireEvent.click(screen.getByRole('button', { name: 'Campanha RJ' }));
    const input = screen.getByLabelText('Nome do projeto');
    fireEvent.change(input, { target: { value: 'Campanha SP' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(session.setProjectName).toHaveBeenCalledWith('Campanha SP');
  });

  it('wires the shortcuts with a save handler', () => {
    const session = stubSession();
    renderWorkspace(session);
    expect(shortcuts).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ onSave: expect.any(Function) }),
    );
  });
});

describe('the rail and its panels', () => {
  it('opens a panel, closes it on the second click, and adds a library tile with a click', async () => {
    const session = stubSession();
    renderWorkspace(session);
    fireEvent.click(screen.getByRole('button', { name: 'Biblioteca' }));
    const panel = await screen.findByRole('region', { name: 'Biblioteca' });
    const add = await within(panel).findByRole('button', { name: 'Adicionar' });
    fireEvent.click(add);
    expect(session.addMediaAsset).toHaveBeenCalledWith(asset);
    fireEvent.click(screen.getByRole('button', { name: 'Biblioteca' }));
    expect(screen.queryByRole('region', { name: 'Biblioteca' })).toBeNull();
  });

  it('puts the tile on a drag under the studio MIME', async () => {
    renderWorkspace(stubSession());
    fireEvent.click(screen.getByRole('button', { name: 'Biblioteca' }));
    const tile = await screen.findByLabelText(/Imagem, 1080 × 1080/);
    const setData = vi.fn();
    tile.dispatchEvent(dragEvent('dragstart', { setData }));
    expect(setData).toHaveBeenCalledWith(
      STUDIO_DRAG_MIME,
      expect.stringContaining('"kind":"media-asset"'),
    );
  });

  it('adds a text preset and a shape', async () => {
    const session = stubSession();
    renderWorkspace(session);
    fireEvent.click(screen.getByRole('button', { name: 'Texto' }));
    fireEvent.click(await screen.findByRole('button', { name: /Título · 72 px/ }));
    expect(session.addText).toHaveBeenCalledWith('title');
    fireEvent.click(screen.getByRole('button', { name: 'Elementos' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retângulo' }));
    expect(session.addShape).toHaveBeenCalledWith('rect', '#e95228');
    expect(
      screen.getByText('Escolha o cliente em "Para quem" para ver os logos dele.'),
    ).toBeTruthy();
  });
});

describe('the stage', () => {
  it('takes a dropped Drive file', () => {
    const session = stubSession();
    renderWorkspace(session);
    const file = {
      id: '11111111-1111-4111-8111-111111111d02',
      name: 'clipe.mp4',
      mimeType: 'video/mp4',
    };
    const payload = JSON.stringify({ kind: 'drive-file', file, folder });
    screen
      .getByTestId('ws-stage')
      .dispatchEvent(
        dragEvent('drop', { getData: vi.fn(() => payload), types: [STUDIO_DRAG_MIME] }),
      );
    expect(session.addDriveFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: file.id }),
      folder,
    );
  });

  it('teaches where to start when the canvas is empty', () => {
    renderWorkspace(stubSession({ assets: [] }));
    const start = screen.getByRole('group', { name: 'Comece por aqui' });
    expect(within(start).getByRole('button', { name: 'Gerar com IA' })).toBeTruthy();
    fireEvent.click(within(start).getByRole('button', { name: 'Escolher da biblioteca' }));
    expect(screen.getByRole('region', { name: 'Biblioteca' })).toBeTruthy();
  });

  it('zooms through the session', () => {
    const session = stubSession();
    renderWorkspace(session);
    fireEvent.click(screen.getByRole('button', { name: 'Aumentar zoom' }));
    expect(session.setZoom).toHaveBeenCalledWith(0.67);
    fireEvent.click(screen.getByRole('button', { name: 'Ajustar' }));
    expect(session.zoomToFit).toHaveBeenCalled();
  });
});

describe('the dock', () => {
  it('shows the layers and hides the timeline for an image, keeping the host in the DOM', () => {
    renderWorkspace(stubSession({ mode: 'image', assets: [] }));
    expect(screen.getByText('painel de camadas')).toBeTruthy();
    expect(screen.getByTestId('ws-timeline').hasAttribute('hidden')).toBe(true);
    expect(screen.queryByRole('button', { name: /Legendar/ })).toBeNull();
  });

  it('asks Whisper for captions, then offers to add the SRT once it is filed', () => {
    const session = stubSession();
    const { unmount } = renderWorkspace(session);
    expect(screen.getByTestId('ws-timeline').hasAttribute('hidden')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Legendar/ }));
    const dialog = screen.getByRole('dialog', { name: 'Legendar com Whisper' });
    fireEvent.change(within(dialog).getByLabelText('Idioma'), { target: { value: 'pt' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Legendar' }));
    // A video gets the smart placement unless the box is unticked.
    expect(session.requestCaptions).toHaveBeenCalledWith('a1', 'pt', true);
    unmount();

    const done = stubSession({
      transcription: {
        id: 't1',
        state: 'done',
        error: null,
        sourceFileId: 'a1',
        file: { id: 'f1', version: 1, name: 'entrevista.srt', folderId: folder.id },
        language: 'pt',
        segments: 42,
        layout: null,
        createdAt: '2026-09-22T12:00:00.000Z',
        finishedAt: '2026-09-22T12:03:00.000Z',
      },
    });
    renderWorkspace(done);
    expect(screen.getByText('Legenda pronta')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar legenda à linha do tempo' }));
    expect(done.addCaptionsFromTranscription).toHaveBeenCalled();
  });
});

describe('smart captions', () => {
  const doneWith = (layout: StudioTranscription['layout']): StudioTranscription => ({
    id: 't1',
    state: 'done',
    error: null,
    sourceFileId: 'a1',
    file: { id: 'f1', version: 1, name: 'entrevista.srt', folderId: folder.id },
    language: 'pt',
    segments: 12,
    layout,
    createdAt: '2026-09-24T12:00:00.000Z',
    finishedAt: '2026-09-24T12:03:00.000Z',
  });

  it('offers the placement for a video, ticked, and sends it off when unticked', () => {
    const session = stubSession();
    renderWorkspace(session);
    fireEvent.click(screen.getByRole('button', { name: /Legendar/ }));
    const dialog = screen.getByRole('dialog', { name: 'Legendar com Whisper' });
    const box = within(dialog).getByRole('checkbox', { name: /fugir de rostos e de textos/ });
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).getByText(/Guarda só a posição escolhida, nunca o rosto/)).toBeTruthy();
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Legendar' }));
    expect(session.requestCaptions).toHaveBeenCalledWith('a1', undefined, false);
  });

  it('has no placement for an audio file', () => {
    renderWorkspace(
      stubSession({
        assets: [
          { id: 'a2', name: 'voz.mp3', mimeType: 'audio/mpeg', url: 'blob:y', kind: 'audio' },
        ],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Legendar/ }));
    const dialog = screen.getByRole('dialog', { name: 'Legendar com Whisper' });
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('while placing, says so and lets the person put it at the bottom without waiting', () => {
    const session = stubSession({
      transcription: doneWith({ state: 'running', error: null, files: [] }),
    });
    renderWorkspace(session);
    expect(screen.getByText(/Procurando rostos e textos no vídeo/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Adicionar legenda à linha do tempo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Não esperar: pôr embaixo' }));
    expect(session.addCaptionsFromTranscription).toHaveBeenCalledWith({ plain: true });
  });

  it('once placed, names the zones and adds them', () => {
    const session = stubSession({
      transcription: doneWith({
        state: 'done',
        error: null,
        files: [
          { id: 'z1', version: 1, name: 'entrevista.legenda-embaixo.srt', zone: 'bottom', cues: 9 },
          { id: 'z2', version: 1, name: 'entrevista.legenda-em-cima.srt', zone: 'top', cues: 3 },
        ],
      }),
    });
    renderWorkspace(session);
    expect(screen.getByText(/Posições prontas: embaixo, em cima/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar legenda à linha do tempo' }));
    expect(session.addCaptionsFromTranscription).toHaveBeenCalledWith();
  });

  it('when placing failed, says the caption goes at the bottom', () => {
    renderWorkspace(
      stubSession({
        transcription: doneWith({ state: 'failed', error: 'x: y', files: [] }),
      }),
    );
    expect(screen.getByText(/Não deu para posicionar, a legenda vai embaixo/)).toBeTruthy();
  });
});

describe('export and the agent', () => {
  it('exports an image as PNG into the chosen folder', async () => {
    const session = stubSession({ mode: 'image', assets: [] });
    renderWorkspace(session);
    fireEvent.click(screen.getByRole('button', { name: 'Exportar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar imagem para o Drive' });
    await within(dialog).findByText('Marketing');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exportar' }));
    await waitFor(() => expect(session.exportImage).toHaveBeenCalled());
    expect(vi.mocked(session.exportImage).mock.calls[0]?.[0]).toMatchObject({
      format: 'png',
      name: 'Campanha RJ.png',
      folder: expect.objectContaining({ id: folder.id }),
    });
  });

  it('folds the agent under the properties and remembers the choice', () => {
    renderWorkspace(stubSession());
    const head = screen.getByRole('button', { name: /Agente de Edição/ });
    const wasOpen = head.getAttribute('aria-expanded') === 'true';
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe(wasOpen ? 'false' : 'true');
    expect(localStorage.getItem('wings.studio.agentOpen')).toBe(wasOpen ? '0' : '1');
    expect(screen.getByText('propriedades')).toBeTruthy();
  });
});
