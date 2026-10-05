import type { WebGLRenderer, WebGLRenderTarget } from 'three';

export function buildStudioEnvironment(
  renderer: WebGLRenderer,
  variant?: 'light' | 'dark',
): WebGLRenderTarget;
