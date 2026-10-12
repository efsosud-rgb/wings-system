import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

const query = {
  current: {} as {
    data: unknown;
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  },
};

vi.mock('../api/office.js', () => ({ useOffice: () => query.current }));
// The 3D floor needs WebGL; here it only has to be told apart from the failure.
vi.mock('../components/office3d/OfficeFloor.js', () => ({
  OfficeFloor: () => <p>escritório desenhado</p>,
}));

const { OfficePage } = await import('./OfficePage.js');

afterEach(() => {
  cleanup();
});

describe('the virtual office page', () => {
  it('says "—" and why when the snapshot cannot be read', () => {
    query.current = {
      data: undefined,
      isPending: false,
      isError: true,
      error: new ApiError(500, {}),
      refetch: vi.fn(),
    };
    render(<OfficePage />);

    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar o escritório: o servidor teve um problema (erro 500)',
    );
    expect(screen.queryByText('escritório desenhado')).toBeNull();
  });

  it('draws the office once the snapshot arrived', () => {
    query.current = {
      data: { people: [] },
      isPending: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    };
    render(<OfficePage />);

    expect(screen.getByText('escritório desenhado')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
