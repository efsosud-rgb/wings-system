/**
 * @jest-environment jsdom
 */
/* eslint-disable import/first, max-classes-per-file */

/**
 * Cross-Bundle Merge Field Regression Tests
 *
 * When ShotstackEdit is bundled separately from the SDK (e.g. different webpack
 * builds, or different npm package versions), `instanceof ShotstackEdit` fails
 * because the prototype chains don't match. The SDK uses duck typing instead:
 *
 *   if (this.edit && "mergeFields" in this.edit) { ... }
 *
 * These tests verify that merge field features work with plain objects that have
 * no ShotstackEdit prototype, and that objects without `mergeFields` correctly
 * disable those features.
 */

import type { ResolvedClip, ImageAsset } from "@schemas";
import { sec } from "@timing/types";
import type { Edit } from "@core/edit-session";

// Polyfill structuredClone for jsdom
if (typeof structuredClone === "undefined") {
	global.structuredClone = (obj: unknown) => JSON.parse(JSON.stringify(obj));
}

// Mock pixi.js before any imports that use it
vi.mock("pixi.js", () => ({}));

vi.mock("../src/components/canvas/players/player", () => ({
	Player: class MockPlayer {},
	PlayerType: {}
}));

vi.mock("../src/core/shotstack-edit", () => ({
	ShotstackEdit: class MockShotstackEdit {}
}));

vi.mock("../src/core/edit-session", () => ({}));

vi.mock("@styles/inject", () => ({
	injectShotstackStyles: vi.fn()
}));

import { MediaToolbar } from "@core/ui/media-toolbar";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createImageClip(): ResolvedClip {
	return {
		id: "clip-1",
		asset: {
			type: "image",
			src: "https://example.com/image.jpg"
		} as ImageAsset,
		start: sec(0),
		length: sec(5),
		fit: "crop",
		opacity: 1,
		scale: 1
	} as ResolvedClip;
}

/**
 * Build a plain-object edit session WITH mergeFields — simulates a cross-bundle
 * ShotstackEdit that has merge capabilities but no shared prototype.
 */
function createCrossBundleEdit() {
	const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

	const internalEvents = {
		on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(callback);
			return vi.fn();
		}),
		emit: (event: string, ...args: unknown[]) => {
			listeners[event]?.forEach(cb => cb(...args));
		}
	};

	return {
		getClipId: vi.fn().mockReturnValue("clip-1"),
		getResolvedClip: vi.fn().mockReturnValue(createImageClip()),
		getResolvedClipById: vi.fn().mockReturnValue(createImageClip()),
		getDocumentClip: vi.fn().mockReturnValue(createImageClip()),
		updateClip: vi.fn(),
		updateClipInDocument: vi.fn(),
		resolveClip: vi.fn(),
		commitClipUpdate: vi.fn(),
		deleteClip: vi.fn(),
		canDeleteClip: vi.fn(() => true),
		playbackTime: 0,
		getOutputFps: vi.fn(() => 30),
		seek: vi.fn(),
		events: { on: vi.fn(), off: vi.fn() },
		getInternalEvents: vi.fn(() => internalEvents),
		getMergeFieldForProperty: vi.fn(() => null),
		isValueCompatibleWithClipProperty: vi.fn(() => true),
		applyMergeField: vi.fn(() => Promise.resolve()),
		removeMergeField: vi.fn(() => Promise.resolve()),
		mergeFields: {
			getAll: vi.fn(() => []),
			get: vi.fn()
		},
		size: { width: 1920, height: 1080 }
	};
}

/**
 * Build a plain-object edit session WITHOUT mergeFields — simulates a plain
 * EditSession (base class) that has getInternalEvents() but no merge capabilities.
 * The duck typing check ("mergeFields" in edit) should fail, disabling merge features.
 */
function createPlainEdit() {
	const internalEvents = {
		on: vi.fn(() => vi.fn()),
		emit: vi.fn()
	};

	return {
		getClipId: vi.fn().mockReturnValue("clip-1"),
		getResolvedClip: vi.fn().mockReturnValue(createImageClip()),
		getDocumentClip: vi.fn().mockReturnValue(createImageClip()),
		updateClip: vi.fn(),
		updateClipInDocument: vi.fn(),
		resolveClip: vi.fn(),
		commitClipUpdate: vi.fn(),
		deleteClip: vi.fn(),
		canDeleteClip: vi.fn(() => true),
		playbackTime: 0,
		getOutputFps: vi.fn(() => 30),
		seek: vi.fn(),
		events: { on: vi.fn(), off: vi.fn() },
		getInternalEvents: vi.fn(() => internalEvents),
		size: { width: 1920, height: 1080 }
	};
}

function mountToolbar(edit: unknown, mergeFields: boolean): { toolbar: MediaToolbar; parent: HTMLDivElement } {
	const toolbar = new MediaToolbar(edit as Edit, { mergeFields });
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	toolbar.mount(parent);
	return { toolbar, parent };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Cross-bundle merge field duck typing", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("plain object with mergeFields property enables dynamic source toggle", () => {
		const edit = createCrossBundleEdit();
		const { toolbar, parent } = mountToolbar(edit, true);
		toolbar.show(0, 0);

		// Dynamic source section should be rendered when mergeFields option is true
		// and the edit object has a mergeFields property (duck typing passes)
		const dynamicToggle = parent.querySelector("[data-dynamic-toggle]");
		expect(dynamicToggle).toBeTruthy();

		toolbar.dispose();
	});

	it("plain object without mergeFields property keeps merge labels unbound", () => {
		const edit = createPlainEdit();
		const { toolbar, parent } = mountToolbar(edit, true);
		toolbar.show(0, 0);

		// Labels are mounted (driven by showMergeFields option), but getShotstackEdit()
		// returns null because the edit has no mergeFields property — so sync() is a
		// no-op and no labels should be in bound state.
		const mergeLabels = parent.querySelectorAll(".ss-merge-label");
		expect(mergeLabels.length).toBeGreaterThan(0);

		const boundLabels = parent.querySelectorAll(".ss-merge-label--bound");
		expect(boundLabels.length).toBe(0);

		toolbar.dispose();
	});
});
