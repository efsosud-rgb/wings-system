import { resolve } from 'node:path';

/** The upstream path aliases, kept so the vendored sources stay diffable against the SDK. */
export function aliases(dirname: string): Record<string, string> {
  return {
    '@core': resolve(dirname, 'src/core'),
    '@canvas': resolve(dirname, 'src/components/canvas'),
    '@timeline': resolve(dirname, 'src/components/timeline'),
    '@shared': resolve(dirname, 'src/core/shared'),
    '@schemas': resolve(dirname, 'src/core/schemas'),
    '@timing': resolve(dirname, 'src/core/timing'),
    '@layouts': resolve(dirname, 'src/core/layouts'),
    '@animations': resolve(dirname, 'src/core/animations'),
    '@events': resolve(dirname, 'src/core/events'),
    '@inputs': resolve(dirname, 'src/core/inputs'),
    '@loaders': resolve(dirname, 'src/core/loaders'),
    '@export': resolve(dirname, 'src/core/export'),
    '@styles': resolve(dirname, 'src/styles'),
    '@shotstack/shotstack-canvas': resolve(
      dirname,
      'node_modules/@shotstack/shotstack-canvas/dist/entry.web.js',
    ),
  };
}
