import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

const state = {
  current: {} as {
    data: { art: { url: string } | null; article: string | null } | undefined;
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  },
};

const idle = { mutate: vi.fn(), isPending: false, error: null };

vi.mock('../api/clients.js', () => ({
  useClientWhatsApp: () => state.current,
  useUploadClientArt: () => idle,
  useRemoveClientArt: () => idle,
  useSetClientArticle: () => idle,
}));

const { WhatsAppArtPanel } = await import('./WhatsAppArtPanel.js');

const panel = () => render(<WhatsAppArtPanel clientId="c1" name="Malkuth" canEdit />);

afterEach(() => {
  cleanup();
});

describe('the WhatsApp art of a brand', () => {
  it('says "—" and why when the read failed, not that the art is missing', () => {
    state.current = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError(500, {}),
      refetch: vi.fn(),
    };
    panel();

    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar a arte do WhatsApp: o servidor teve um problema (erro 500)',
    );
    expect(screen.queryByText(/Cadastre a arte/)).toBeNull();
    // Nobody replaces a picture they could not see.
    expect(
      (screen.getByRole('button', { name: 'Enviar a arte' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('asks for the art when the read answered and there is none', () => {
    state.current = {
      data: { art: null, article: null },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    panel();

    expect(screen.getByText(/Cadastre a arte do WhatsApp desta marca/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Enviar a arte' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
