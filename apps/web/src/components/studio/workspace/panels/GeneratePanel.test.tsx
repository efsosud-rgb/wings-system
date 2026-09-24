import type { MediaAsset } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiTarget } from '../../../media-studio/GenerationForm.js';
import type { SelectedClip, StudioSession } from '../../session.js';

/**
 * "Editar com IA" in the Studio: the form (its price first, its one click) is
 * the media page's own; what the panel adds is that an edit of a picture on
 * the canvas, once done, lands in that picture's clip, through the session's
 * one-step replace. A variation does not replace anything.
 */

const get = vi.fn();
vi.mock('../../../../api/client.js', async (original) => ({
  ...(await original<typeof import('../../../../api/client.js')>()),
  api: { get: (path: string) => get(path), post: vi.fn() },
}));
/** The form, reduced to what the panel hands it and the click that starts a generation. */
const form = { target: null as AiTarget | null };
vi.mock('../../../media-studio/GenerationForm.js', () => ({
  GenerationForm: ({
    aiTarget,
    onStarted,
  }: {
    aiTarget: AiTarget | null;
    onStarted: (id: string) => void;
  }) => {
    form.target = aiTarget;
    return (
      <button
        type="button"
        onClick={() => onStarted(aiTarget?.use === 'edit' ? 'gen-edit' : 'gen-var')}
      >
        Gerar (4 créditos)
      </button>
    );
  },
}));
vi.mock('../../../media-studio/GenerationProgress.js', () => ({
  GenerationProgress: ({ id }: { id: string }) => <div>acompanhando {id}</div>,
}));

const { GeneratePanel } = await import('./GeneratePanel.js');

const edited = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'image',
  mimeType: 'image/png',
  driveFileId: '33333333-3333-4333-8333-333333333333',
} as MediaAsset;

const selected = { clipId: 'clip-7', assetType: 'image' } as SelectedClip;

function stub(): StudioSession {
  return {
    clientId: null,
    selected,
    selectedImageForAi: {
      driveFileId: 'drive-1',
      mediaAssetId: '11111111-1111-4111-8111-111111111111',
      name: 'imagem-11111111',
      clientId: null,
      aspect: '1:1',
    },
    replaceImage: vi.fn(async () => true),
    setNotice: vi.fn(),
  } as unknown as StudioSession;
}

function renderPanel(session: StudioSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GeneratePanel session={session} canGenerate anyAvailable />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  form.target = null;
  get.mockReset();
  get.mockImplementation(async (path: string) => {
    if (path === '/media/generations') return { generations: [] };
    if (path === '/media/generations/gen-edit')
      return { generation: { id: 'gen-edit', status: 'succeeded', assetIds: [edited.id] } };
    if (path === '/media/generations/gen-var')
      return { generation: { id: 'gen-var', status: 'succeeded', assetIds: ['other'] } };
    if (path === '/media/assets?kind=image') return { assets: [edited] };
    throw new Error(`unexpected GET ${path}`);
  });
});

afterEach(() => cleanup());

describe('Editar com IA in the Studio', () => {
  it('puts the finished edit in the selected picture’s clip, once', async () => {
    const session = stub();
    renderPanel(session);
    fireEvent.click(screen.getByRole('button', { name: 'Editar com IA' }));
    expect(form.target).toMatchObject({ use: 'edit' });
    expect(screen.getByText(/o resultado entra no lugar dela na tela/)).toBeTruthy();
    // Nothing is replaced before a generation exists and ends well.
    expect(session.replaceImage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Gerar (4 créditos)' }));
    await waitFor(() =>
      expect(session.replaceImage).toHaveBeenCalledWith('clip-7', {
        kind: 'media-asset',
        asset: edited,
      }),
    );
    expect(session.replaceImage).toHaveBeenCalledTimes(1);
  });

  it('replaces nothing for a variation', async () => {
    const session = stub();
    renderPanel(session);
    fireEvent.click(screen.getByRole('button', { name: 'Gerar variação' }));
    fireEvent.click(screen.getByRole('button', { name: 'Gerar (4 créditos)' }));
    expect(await screen.findByText('acompanhando gen-var')).toBeTruthy();
    expect(session.replaceImage).not.toHaveBeenCalled();
  });
});
