import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import { LoadFailure, Unavailable } from './LoadFailure.js';

afterEach(cleanup);

describe('LoadFailure', () => {
  it('shows the dash, what did not load and why', () => {
    render(<LoadFailure what="as tarefas" error={new ApiError(500, {})} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('—');
    expect(alert.textContent).toContain(
      'Não foi possível carregar as tarefas: o servidor teve um problema (erro 500).',
    );
  });

  it('offers a retry only when it can retry', () => {
    const retry = vi.fn();
    const { rerender } = render(<LoadFailure what="os leads" error={new TypeError('x')} />);
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();

    rerender(<LoadFailure what="os leads" error={new TypeError('x')} onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('Unavailable', () => {
  it('stands in for a number with a dash and the reason, never a zero', () => {
    render(
      <p data-testid="tile">
        <Unavailable error={new ApiError(401, {})} />
      </p>,
    );
    const tile = screen.getByTestId('tile');
    expect(tile.textContent).toContain('—');
    expect(tile.textContent).toContain('sua sessão expirou');
    expect(tile.textContent).not.toMatch(/\b0\b/);
  });
});
