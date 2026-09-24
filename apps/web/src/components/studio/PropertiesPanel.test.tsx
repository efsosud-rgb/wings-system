import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LayersPanel } from './LayersPanel.js';
import { PropertiesPanel } from './PropertiesPanel.js';
import type { SelectedClip, StudioSession } from './session.js';

/**
 * The two side panels against a stubbed session: every control writes one
 * patch in the core's units, typing waits for a pause, and the empty states
 * say what to do next.
 */

const selectedText: SelectedClip = {
  clipId: 'c1',
  trackIndex: 0,
  clipIndex: 0,
  assetType: 'rich-text',
  assetName: null,
  start: 1.5,
  length: 5,
  opacity: 0.8,
  position: 'center',
  offset: { x: 0, y: 0.1 },
  scale: 1,
  transition: { in: 'none', out: 'fade' },
  volume: null,
  text: {
    text: 'Título',
    fontFamily: 'Work Sans',
    size: 72,
    weight: 600,
    color: '#ffffff',
    horizontal: 'center',
    vertical: 'middle',
  },
  fill: null,
  caption: null,
};

function stub(overrides: Partial<StudioSession>): StudioSession {
  return {
    mode: 'video',
    selected: null,
    layers: [],
    updateSelected: vi.fn(async () => {}),
    deleteSelected: vi.fn(async () => {}),
    moveSelected: vi.fn(async () => {}),
    selectClip: vi.fn(),
    ...overrides,
  } as unknown as StudioSession;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PropertiesPanel', () => {
  it('offers the text fonts for a caption and patches the one chosen', () => {
    const session = stub({
      selected: {
        ...selectedText,
        assetType: 'rich-caption',
        text: null,
        caption: {
          fontFamily: 'Work Sans',
          size: 96,
          color: '#ffffff',
          placement: 'bottom',
          backgroundColor: '#000000',
          backgroundOpacity: 0.55,
        },
      },
    });
    render(<PropertiesPanel session={session} />);
    const font = screen.getByLabelText('Fonte') as HTMLSelectElement;
    expect(font.value).toBe('Work Sans');
    expect([...font.options].map((option) => option.value)).toContain('Montserrat');
    fireEvent.change(font, { target: { value: 'Montserrat' } });
    expect(session.updateSelected).toHaveBeenCalledWith({ caption: { fontFamily: 'Montserrat' } });
  });

  it('teaches what to do when nothing is selected', () => {
    render(<PropertiesPanel session={stub({})} />);
    expect(screen.getByText(/Selecione um item na tela ou na linha do tempo/)).toBeTruthy();
  });

  it('shows the position grid with the current cell pressed and patches one field per change', () => {
    const session = stub({ selected: selectedText });
    render(<PropertiesPanel session={session} />);
    const center = screen.getByRole('button', { name: 'Centro' });
    expect(center.getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Acima à direita' }).getAttribute('aria-pressed'),
    ).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Acima à direita' }));
    expect(session.updateSelected).toHaveBeenCalledWith({ position: 'topRight' });

    const opacity = screen.getByLabelText('Opacidade (%)') as HTMLInputElement;
    expect(opacity.value).toBe('80');
    fireEvent.change(opacity, { target: { value: '55' } });
    fireEvent.blur(opacity);
    expect(session.updateSelected).toHaveBeenCalledWith({ opacity: 0.55 });

    fireEvent.change(screen.getByLabelText('Transição de saída'), {
      target: { value: 'fadeSlow' },
    });
    expect(session.updateSelected).toHaveBeenCalledWith({ transition: { out: 'fadeSlow' } });

    fireEvent.change(screen.getByLabelText('Cor'), { target: { value: '#ff0000' } });
    expect(session.updateSelected).toHaveBeenCalledWith({ text: { color: '#ff0000' } });

    // Duration is a timeline thing: only in video mode.
    expect(screen.getByLabelText('Duração (s)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    expect(session.deleteSelected).toHaveBeenCalledTimes(1);
  });

  it('waits for a pause in the typing before it writes the text', () => {
    vi.useFakeTimers();
    const session = stub({ selected: selectedText });
    render(<PropertiesPanel session={session} />);
    const text = screen.getByLabelText('Texto') as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'Fran' } });
    fireEvent.change(text, { target: { value: 'Franquia' } });
    expect(session.updateSelected).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(session.updateSelected).toHaveBeenCalledTimes(1);
    expect(session.updateSelected).toHaveBeenCalledWith({ text: { text: 'Franquia' } });
  });

  it('hides duration in image mode and offers volume only for media', () => {
    render(
      <PropertiesPanel
        session={stub({
          mode: 'image',
          selected: {
            ...selectedText,
            assetType: 'video',
            assetName: 'entrevista.mp4',
            text: null,
            volume: 1,
          },
        })}
      />,
    );
    expect(screen.queryByLabelText('Duração (s)')).toBeNull();
    expect(screen.getByLabelText('Volume (%)')).toBeTruthy();
    expect(screen.queryByLabelText('Texto')).toBeNull();
    expect(screen.getByText('entrevista.mp4')).toBeTruthy();
  });
});

describe('LayersPanel', () => {
  it('teaches what to do when the picture is empty', () => {
    render(<LayersPanel session={stub({})} />);
    expect(screen.getByText(/Abra uma imagem da biblioteca ou gere uma com IA/)).toBeTruthy();
  });

  it('lists layers top first, selects on click and moves the selected one', () => {
    const session = stub({
      layers: [
        {
          clipId: 't',
          trackIndex: 0,
          clipIndex: 0,
          assetType: 'rich-text',
          label: 'Título',
          selected: true,
        },
        {
          clipId: 'i',
          trackIndex: 1,
          clipIndex: 0,
          assetType: 'image',
          label: 'capa.png',
          selected: false,
        },
      ],
    });
    render(<LayersPanel session={session} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('Título');
    expect(rows[1]?.textContent).toContain('capa.png');
    fireEvent.click(screen.getByRole('button', { name: /capa.png/ }));
    expect(session.selectClip).toHaveBeenCalledWith('i');
    expect((screen.getByRole('button', { name: 'Subir' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Descer' }));
    expect(session.moveSelected).toHaveBeenCalledWith('down');
  });
});
