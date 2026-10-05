// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { WingsLogo3D } from './WingsLogo3D.js';

afterEach(cleanup);

describe('WingsLogo3D', () => {
  it('keeps the 2D logo in place when there is no WebGL (jsdom has none)', () => {
    const { container } = render(<WingsLogo3D variant="dark" height={200} />);
    expect(screen.getByRole('img', { name: 'Wings Company' })).toBeTruthy();
    expect(container.querySelector('canvas')).toBeNull();
    // The negative logo goes on a dark background: WINGS in white.
    expect(container.innerHTML).toContain('#FFFFFF');
  });

  it('uses the principal logo on a light background', () => {
    const { container } = render(<WingsLogo3D variant="light" height={80} />);
    expect(container.innerHTML).toContain('#000000');
    expect(container.innerHTML).not.toContain('#FFFFFF');
  });
});
