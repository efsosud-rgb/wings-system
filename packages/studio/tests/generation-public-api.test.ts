import { Edit } from "@core/edit-session";
import { EditEvent } from "@core/events/edit-events";

import type { Clip } from "@schemas";

// A prompt-bearing clip has no src, so PlayerFactory routes it to a pending
// placeholder player. Constructing one for real still needs pixi.js mocked —
// see edit-clip-operations.test.ts for the fuller player-mock pattern.
vi.mock("pixi-filters", () => ({
	AdjustmentFilter: vi.fn().mockImplementation(() => ({})),
	BloomFilter: vi.fn().mockImplementation(() => ({})),
	GlowFilter: vi.fn().mockImplementation(() => ({})),
	OutlineFilter: vi.fn().mockImplementation(() => ({})),
	DropShadowFilter: vi.fn().mockImplementation(() => ({}))
}));

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
					// eslint-disable-next-line no-param-reassign -- Intentional mock of Pixi.js Container behavior
					child.parent = self;
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
		Texture: { from: vi.fn() },
		Assets: { load: vi.fn().mockResolvedValue({}), unload: vi.fn(), cache: { has: vi.fn().mockReturnValue(false) } },
		ColorMatrixFilter: vi.fn(() => ({ negative: vi.fn() })),
		Rectangle: vi.fn()
	};
});

vi.mock("@loaders/asset-loader", () => ({
	AssetLoader: vi.fn().mockImplementation(() => ({
		load: vi.fn().mockResolvedValue({}),
		unload: vi.fn(),
		getProgress: vi.fn().mockReturnValue(100),
		incrementRef: vi.fn(),
		decrementRef: vi.fn().mockReturnValue(true),
		loadTracker: { on: vi.fn(), off: vi.fn() }
	}))
}));

vi.mock("@core/luma-mask-controller", () => ({
	LumaMaskController: vi.fn().mockImplementation(() => ({
		initialize: vi.fn(),
		update: vi.fn(),
		dispose: vi.fn(),
		cleanupForPlayer: vi.fn(),
		getActiveMaskCount: vi.fn().mockReturnValue(0)
	}))
}));

const editWithPromptClip = async (): Promise<Edit> => {
	const edit = new Edit({
		timeline: {
			tracks: [
				{
					clips: [{ asset: { type: "audio", prompt: "a calm harbour at dusk" }, start: 0, length: 5 }]
				}
			]
		},
		output: { size: { width: 1920, height: 1080 }, format: "mp4" }
	});
	await edit.load();
	return edit;
};

const clipIdOf = (edit: Edit): string =>
	(edit.getEdit({ includeIds: true }).timeline.tracks[0]?.clips[0] as Clip & { id: string }).id;

describe("generation through the public API", () => {
	it("reports started then completed when the host handler resolves", async () => {
		const edit = await editWithPromptClip();
		const seen: string[] = [];
		edit.events.on(EditEvent.ClipGenerationStarted, () => seen.push("started"));
		edit.events.on(EditEvent.ClipGenerationCompleted, () => seen.push("completed"));
		edit.registerAssetGenerator(async () => ({ url: "https://cdn.example.com/harbour.mp3" }));

		await edit.generateClip(clipIdOf(edit));

		expect(seen).toEqual(["started", "completed"]);
		edit.dispose();
	});

	it("reports the handler's message on failure, and resolves rather than rejecting", async () => {
		const edit = await editWithPromptClip();
		const failures: Array<{ clipId: string; error: string }> = [];
		edit.events.on(EditEvent.ClipGenerationFailed, payload => failures.push(payload));
		edit.registerAssetGenerator(async () => {
			throw new Error("provider refused the prompt");
		});

		await expect(edit.generateClip(clipIdOf(edit))).resolves.toBeUndefined();

		expect(failures).toHaveLength(1);
		expect(failures[0]?.error).toBe("provider refused the prompt");
		expect(failures[0]?.clipId).toBe(clipIdOf(edit));
		edit.dispose();
	});

	it("rejects when no handler is registered", async () => {
		const edit = await editWithPromptClip();
		await expect(edit.generateClip(clipIdOf(edit))).rejects.toThrow(/No asset generator registered/);
		edit.dispose();
	});
});
