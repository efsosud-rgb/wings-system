import type { MediaAsset } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SelectedClip, StudioSession } from './session.js';

/**
 * The selected picture's actions against a stubbed session: "Substituir" goes
 * through the session's one-step replace, by the clip that was selected.
 */

vi.mock('../media-studio/MediaLibrary.js', () => ({
  MediaPicker: ({ onPick }: { onPick: (asset: MediaAsset) => void }) => (
    <button type="button" onClick={() => onPick(libraryImage)}>
      escolher outra.png
    </button>
  ),
}));
vi.mock('./DriveFilePicker.js', () => ({ DriveFilePicker: () => <div>seletor do Drive</div> }));

const { ImageActions } = await import('./ImageActions.js');

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '55555555-5555-4555-8555-555555555555';

const libraryImage = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'image',
  mimeType: 'image/png',
  driveFileId: '33333333-3333-4333-8333-333333333333',
  clientId: CLIENT_ID,
  aspect: '1:1',
} as MediaAsset;

const selectedImage: SelectedClip = {
  clipId: 'clip-7',
  trackIndex: 1,
  clipIndex: 0,
  assetType: 'image',
  assetName: 'imagem-11111111',
  start: 0,
  length: 5,
  opacity: 1,
  position: 'center',
  offset: { x: 0, y: 0 },
  scale: 1,
  transition: { in: 'none', out: 'none' },
  volume: null,
  text: null,
  fill: null,
  caption: null,
};

function stub(overrides: Partial<StudioSession> = {}): StudioSession {
  return {
    mode: 'image',
    busy: null,
    selected: selectedImage,
    lastFolder: null,
    selectedImageForAi: {
      driveFileId: 'drive-1',
      mediaAssetId: SOURCE_ID,
      name: 'imagem-11111111',
      clientId: CLIENT_ID,
      aspect: '1:1',
    },
    deleteSelected: vi.fn(async () => {}),
    moveSelected: vi.fn(async () => {}),
    replaceImage: vi.fn(async () => true),
    setNotice: vi.fn(),
    ...overrides,
  } as unknown as StudioSession;
}

function renderActions(session: StudioSession, canGenerate = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ImageActions session={session} canGenerate={canGenerate} />
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe('the selected picture', () => {
  it('removes it and replaces it through the session, by the clip that was selected', async () => {
    const session = stub();
    renderActions(session);
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    expect(session.deleteSelected).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Substituir' }));
    fireEvent.click(screen.getByRole('button', { name: 'Da biblioteca' }));
    fireEvent.click(screen.getByRole('button', { name: 'escolher outra.png' }));
    expect(session.replaceImage).toHaveBeenCalledWith('clip-7', {
      kind: 'media-asset',
      asset: libraryImage,
    });
  });

  it('points to the Gerar com IA panel for an AI edit, and not without the permission', () => {
    renderActions(stub());
    expect(screen.getByText(/Editar com IA: no painel Gerar com IA/)).toBeTruthy();
    cleanup();
    renderActions(stub(), false);
    expect(screen.queryByText(/Editar com IA/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Substituir' })).toBeTruthy();
  });

  it('orders the layers of an image from here, now that there is no list under the stage', () => {
    const session = stub({ selected: { ...selectedImage, trackIndex: 0 } });
    renderActions(session);
    expect(
      (screen.getByRole('button', { name: 'Trazer para frente' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar para trás' }));
    expect(session.moveSelected).toHaveBeenCalledWith('down');
  });
});
