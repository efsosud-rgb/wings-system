/**
 * Output Resolution and AspectRatio Tests
 *
 * Tests the setOutputResolution() and setOutputAspectRatio() methods,
 * including size calculation, event emission, and mutual exclusivity
 * with custom size.
 */

import { Edit } from "@core/edit-session";
import { EditEvent } from "@core/events/edit-events";
import type { EditConfig } from "@schemas";

// Mock pixi-filters
vi.mock("pixi-filters", () => ({
	AdjustmentFilter: vi.fn().mockImplementation(() => ({})),
	BloomFilter: vi.fn().mockImplementation(() => ({})),
	GlowFilter: vi.fn().mockImplementation(() => ({})),
	OutlineFilter: vi.fn().mockImplementation(() => ({})),
	DropShadowFilter: vi.fn().mockImplementation(() => ({}))
}));

// Mock pixi.js
vi.mock("pixi.js", async () => {
	const createMockContainer = (): Record<string, unknown> => {
		const children: unknown[] = [];
		const self = {
			children,
			sortableChildren: true,
			parent: null as unknown,
			label: null as string | null,
			zIndex: 0,
			visible: true,
			destroyed: false,
			addChild: vi.fn((child: { parent?: unknown }) => {
				children.push(child);
				if (typeof child === "object" && child !== null) {
					Object.assign(child, { parent: self });
				}
				return child;
			}),
			removeChild: vi.fn((child: unknown) => {
				const idx = children.indexOf(child);
				if (idx !== -1) children.splice(idx, 1);
				return child;
			}),
			removeChildAt: vi.fn(),
			getChildByLabel: vi.fn(() => null),
			getChildIndex: vi.fn(() => 0),
			destroy: vi.fn(() => {
				self.destroyed = true;
			}),
			setMask: vi.fn()
		};
		return self;
	};

	const createMockGraphics = (): Record<string, unknown> => ({
		fillStyle: {},
		rect: vi.fn().mockReturnThis(),
		fill: vi.fn().mockReturnThis(),
		clear: vi.fn().mockReturnThis(),
		stroke: vi.fn().mockReturnThis(),
		strokeStyle: {},
		destroy: vi.fn()
	});

	return {
		// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
		...(await import("./helpers/pixi-mock-filters")).pixiFilterStubs,
		Container: vi.fn().mockImplementation(createMockContainer),
		Graphics: vi.fn().mockImplementation(createMockGraphics),
		Sprite: vi.fn().mockImplementation(() => ({
			texture: {},
			width: 100,
			height: 100,
			parent: null,
			anchor: { set: vi.fn() },
			scale: { set: vi.fn() },
			position: { set: vi.fn() },
			destroy: vi.fn()
		})),
		Texture: {
			from: vi.fn().mockReturnValue({ width: 100, height: 100 }),
			EMPTY: { width: 0, height: 0 }
		},
		Assets: {
			load: vi.fn().mockResolvedValue({ width: 100, height: 100 }),
			add: vi.fn(),
			get: vi.fn(),
			setPreferences: vi.fn()
		},
		Text: vi.fn().mockImplementation(() => ({
			text: "",
			style: {},
			anchor: { set: vi.fn() },
			destroy: vi.fn()
		})),
		TextStyle: vi.fn().mockImplementation(() => ({})),
		HTMLText: vi.fn().mockImplementation(() => ({
			text: "",
			style: {},
			anchor: { set: vi.fn() },
			destroy: vi.fn()
		})),
		HTMLTextStyle: vi.fn().mockImplementation(() => ({}))
	};
});


/**
 * Wings: a project starts empty. The editor's own schema must accept a timeline
 * with no track, in every format the studio offers, and the Edit must load and
 * reload such a document without throwing.
 */
const SIZES = [
	{ width: 1920, height: 1080 },
	{ width: 1080, height: 1920 },
	{ width: 1080, height: 1080 },
	{ width: 1080, height: 1350 }
];

function emptyEdit(size: { width: number; height: number }): EditConfig {
	return {
		timeline: { background: "#000000", tracks: [] },
		output: { format: "mp4", fps: 30, size }
	} as unknown as EditConfig;
}

describe("An empty edit", () => {
	it("is valid in every format", async () => {
		const edit = new Edit(emptyEdit(SIZES[0]));
		await edit.load();
		for (const size of SIZES) {
			expect(edit.validateEdit(emptyEdit(size))).toEqual({ valid: true, errors: [] });
		}
	});

	it("still refuses a size with keys the schema does not know", async () => {
		const edit = new Edit(emptyEdit(SIZES[0]));
		await edit.load();
		const withLabel = emptyEdit({ ...SIZES[0], label: "Horizontal" } as never);
		expect(edit.validateEdit(withLabel).valid).toBe(false);
	});

	it("loads, reloads and reads back with no track", async () => {
		const edit = new Edit(emptyEdit(SIZES[1]));
		await edit.load();
		expect(edit.getEdit().timeline.tracks).toEqual([]);
		await edit.loadEdit(emptyEdit(SIZES[2]));
		expect(edit.getEdit().output.size).toEqual(SIZES[2]);
		expect(edit.totalDuration).toBe(0);
	});

	it("still accepts a timeline with tracks, as before", async () => {
		const edit = new Edit(emptyEdit(SIZES[0]));
		await edit.load();
		const withTrack = {
			timeline: {
				tracks: [{ clips: [{ asset: { type: "image", src: "https://example.com/image.jpg" }, start: 0, length: 1 }] }]
			},
			output: { size: SIZES[0], format: "mp4" }
		} as unknown as EditConfig;
		expect(edit.validateEdit(withTrack)).toEqual({ valid: true, errors: [] });
	});
});
