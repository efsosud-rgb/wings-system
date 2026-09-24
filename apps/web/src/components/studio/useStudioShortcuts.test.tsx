import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStudioShortcuts } from './useStudioShortcuts.js';

function Harness({
  undo,
  redo,
  dialog = false,
}: {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  dialog?: boolean;
}) {
  useStudioShortcuts(
    { status: 'ready', clearSelection: () => undefined, undo, redo },
    { onSave: () => undefined },
  );
  const field = <input aria-label="Opacidade (%)" defaultValue="100" />;
  return dialog ? <div role="dialog">{field}</div> : field;
}

afterEach(() => cleanup());

describe('Ctrl+Z with the focus in a field', () => {
  it('goes to the editor when nothing was typed in the field (staging: "Substituir" could not be undone)', () => {
    const undo = vi.fn(async () => undefined);
    const redo = vi.fn(async () => undefined);
    render(<Harness undo={undo} redo={redo} />);
    const field = screen.getByLabelText('Opacidade (%)');
    field.focus();
    fireEvent.keyDown(field, { key: 'z', ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: 'z', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(field, { key: 'y', metaKey: true });
    expect(redo).toHaveBeenCalledTimes(2);
  });

  it('leaves the text undo to the browser once something was typed', () => {
    const undo = vi.fn(async () => undefined);
    render(<Harness undo={undo} redo={vi.fn(async () => undefined)} />);
    const field = screen.getByLabelText('Opacidade (%)') as HTMLInputElement;
    field.focus();
    fireEvent.change(field, { target: { value: '50' } });
    fireEvent.keyDown(field, { key: 'z', ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
  });

  it('does nothing inside a dialog, nor without Ctrl', () => {
    const undo = vi.fn(async () => undefined);
    render(<Harness undo={undo} redo={vi.fn(async () => undefined)} dialog />);
    const field = screen.getByLabelText('Opacidade (%)');
    field.focus();
    fireEvent.keyDown(field, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(field, { key: 'z' });
    expect(undo).not.toHaveBeenCalled();
  });
});
