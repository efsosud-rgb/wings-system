// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Lazy3D } from './Lazy3D.js';

function Scene() {
  return <div>cena 3D</div>;
}

describe('Lazy3D', () => {
  it('falls back to the 2D content when WebGL is missing', () => {
    // jsdom has no WebGL: getContext answers null.
    render(<Lazy3D scene={Scene} sceneProps={{}} fallback={<p>logo 2D</p>} />);
    expect(screen.getByText('logo 2D')).toBeTruthy();
    expect(screen.queryByText('cena 3D')).toBeNull();
  });

  it('does not build the scene before it is seen', () => {
    const observe = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = observe;
        disconnect = vi.fn();
      },
    );
    render(<Lazy3D scene={Scene} sceneProps={{}} fallback={<p>logo 2D</p>} />);
    expect(observe).toHaveBeenCalled();
    expect(screen.queryByText('cena 3D')).toBeNull();
    vi.unstubAllGlobals();
  });
});
