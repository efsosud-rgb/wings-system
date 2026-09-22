/**
 * Wings Studio host configuration.
 *
 * The upstream SDK downloads its WASM helpers from Shotstack's and unpkg's
 * servers. Wings serves them itself, so the app tells the core where they are
 * before the first canvas is created. Nothing here is read by tests.
 */

export interface StudioConfig {
	/** Base URL (or full URL ending in `hb.wasm`) of HarfBuzz, used by rich captions. */
	harfbuzzWasmUrl?: string;
	/** Base URL (or full URL ending in `.wasm`) of resvg, used by SVG clips. */
	resvgWasmUrl?: string;
}

const config: StudioConfig = {};

export function configureStudio(next: StudioConfig): void {
	Object.assign(config, next);
}

export function studioConfig(): Readonly<StudioConfig> {
	return config;
}
