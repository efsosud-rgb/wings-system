// Regenerates public/og/fale-com-a-wings.png (1200×630): the page's real 3D
// wing (src/pages/fale-com-a-wings/scene.ts, every particle, no motion) over
// white, rendered in headless Chromium with SwiftShader WebGL. No network: a
// local Vite server serves scripts/og-image.html and nothing else is allowed.
//
//   pnpm --filter @wings/landing og-image
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const OUT = resolve(root, 'public/og/fale-com-a-wings.png');
const CHROME =
  process.env.CHROME_PATH ||
  resolve(
    homedir(),
    '.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  );
const WIDTH = 1200;
const HEIGHT = 630;

const server = await createServer({
  root,
  configFile: resolve(root, 'vite.config.ts'),
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 5199, strictPort: false },
});
await server.listen();
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5199/';
const origin = new URL(base).origin;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/scripts/og-image.html`);
  await page.waitForFunction(() => window.__ogReady === true || window.__ogReady === false, null, {
    timeout: 30000,
  });
  if (!(await page.evaluate(() => window.__ogReady))) throw new Error('WebGL did not start');
  // two frames: the scene draws once on its first animation frame
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  const png = await page.screenshot({ type: 'png' });
  if (errors.length) throw new Error(errors.join(' | '));

  // not blank: enough drawn pixels, and some of them the brand's orange
  const stats = await page.evaluate(
    async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, img.width, img.height);
      let drawn = 0,
        orange = 0;
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (255 * 3 - r - g - b > 60) drawn++;
        if (r > 180 && g > 50 && g < 140 && b < 100) orange++;
      }
      return { width: img.width, height: img.height, drawn, orange, total: data.length / 4 };
    },
    `data:image/png;base64,${png.toString('base64')}`,
  );
  if (stats.width !== WIDTH || stats.height !== HEIGHT)
    throw new Error(`size ${stats.width}×${stats.height}`);
  if (stats.drawn / stats.total < 0.01 || stats.orange < 500) {
    throw new Error(`the image looks blank: ${JSON.stringify(stats)}`);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, png);
  console.warn(
    `og-image: ${WIDTH}×${HEIGHT}, ${((100 * stats.drawn) / stats.total).toFixed(1)}% drawn, ` +
      `${stats.orange} orange pixels, ${png.length} bytes → public/og/fale-com-a-wings.png`,
  );
} finally {
  await browser.close();
  await server.close();
}
