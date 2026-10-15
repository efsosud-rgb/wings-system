import { createScene } from '../src/pages/fale-com-a-wings/scene.js';

/** The OG image's scene (scripts/og-image.mjs): every particle, static, the wing formation. */
const canvas = document.querySelector<HTMLCanvasElement>('#gl');
const scene = canvas
  ? createScene({
      canvas,
      reduce: true,
      coarse: false,
      pointer: { x: 0, y: 0, active: false, t: 0 },
      gyro: { x: 0, y: 0, on: false },
      step: () => -1,
      sections: [...document.querySelectorAll<HTMLElement>('[data-form]')],
      particles: 8400,
    })
  : null;
(window as unknown as { __ogReady: boolean }).__ogReady = scene !== null;
