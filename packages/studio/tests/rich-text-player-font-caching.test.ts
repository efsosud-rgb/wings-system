/**
 * @jest-environment jsdom
 */

import type { Edit } from "@core/edit-session";
import type { RichTextAsset, ResolvedClip } from "@schemas";

let mockRegisterFontFromFile: Mock<Promise<void>, [string, { family: string; weight: string }]>;
let mockValidate: Mock<{ value: unknown }, [unknown]>;
let mockCreateRenderer: Mock<{ render: Mock<Promise<void>, [unknown]> }, [HTMLCanvasElement]>;
let mockRenderFrame: Mock<Promise<unknown[]>, [unknown, number, number]>;
let mockOpenTypeParse: Mock<{ tables: Record<string, unknown> }, [ArrayBuffer]>;
const mockFetch = vi.fn();

vi.mock("pixi.js", async () => {
	const createMockContainer = (): Record<string, unknown> => {
		const children: unknown[] = [];
		return {
			children,
			sortableChildren: true,
			cursor: "default",
			eventMode: "none",
			visible: true,
			label: null as string | null,
			parent: null as unknown,
			scale: { set: vi.fn() },
			pivot: { set: vi.fn() },
			position: { set: vi.fn() },
			zIndex: 0,
			angle: 0,
			alpha: 1,
			skew: { set: vi.fn() },
			addChild: vi.fn((child: { parent?: unknown }) => {
				children.push(child);
				return child;
			}),
			removeChild: vi.fn((child: unknown) => {
				const idx = children.indexOf(child);
				if (idx >= 0) {
					children.splice(idx, 1);
				}
				return child;
			}),
			destroy: vi.fn(),
			on: vi.fn(),
			setMask: vi.fn(),
			getBounds: vi.fn(() => ({ x: 0, y: 0, width: 640, height: 360 }))
		};
	};

	return {
		// eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
		...(await import("./helpers/pixi-mock-filters")).pixiFilterStubs,
		Container: vi.fn().mockImplementation(createMockContainer),
		Texture: {
			from: vi.fn().mockImplementation(() => ({
				destroy: vi.fn(),
				source: { update: vi.fn() }
			})),
			WHITE: {}
		},
		Sprite: vi.fn().mockImplementation((texture: unknown) => ({
			texture,
			anchor: { set: vi.fn() },
			position: { set: vi.fn() },
			destroy: vi.fn()
		})),
		Graphics: vi.fn().mockImplementation(() => ({
			fillStyle: {},
			rect: vi.fn().mockReturnThis(),
			fill: vi.fn().mockReturnThis(),
			clear: vi.fn().mockReturnThis(),
			moveTo: vi.fn().mockReturnThis(),
			lineTo: vi.fn().mockReturnThis(),
			stroke: vi.fn().mockReturnThis(),
			roundRect: vi.fn().mockReturnThis(),
			destroy: vi.fn()
		})),
		Text: vi.fn().mockImplementation(() => ({
			anchor: { set: vi.fn(), x: 0 },
			position: { set: vi.fn() },
			filters: [],
			text: "",
			x: 0,
			y: 0,
			width: 0,
			height: 0,
			destroy: vi.fn()
		})),
		TextStyle: vi.fn().mockImplementation(() => ({})),
		Rectangle: vi.fn().mockImplementation((x, y, w, h) => ({ x, y, width: w, height: h })),
		Assets: {
			load: vi.fn(),
			unload: vi.fn(),
			cache: { has: vi.fn().mockReturnValue(false) }
		}
	};
});

vi.mock("pixi-filters", () => ({
	AdjustmentFilter: vi.fn().mockImplementation(() => ({})),
	BloomFilter: vi.fn().mockImplementation(() => ({})),
	GlowFilter: vi.fn().mockImplementation(() => ({})),
	OutlineFilter: vi.fn().mockImplementation(() => ({})),
	DropShadowFilter: vi.fn().mockImplementation(() => ({}))
}));

vi.mock("@core/fonts/font-config", () => ({
	parseFontFamily: vi.fn().mockImplementation((family: string) => ({
		baseFontFamily: family,
		fontWeight: 400
	})),
	resolveFontPath: vi.fn().mockReturnValue(null)
}));

vi.mock("@schemas", () => ({
	RichTextAssetSchema: {
		safeParse: vi.fn().mockImplementation((asset: unknown) => ({
			success: true,
			data: asset
		}))
	}
}));

vi.mock("opentype.js", () => ({
	parse: (...args: [ArrayBuffer]) => mockOpenTypeParse(...args)
}));

vi.mock("@shotstack/shotstack-canvas", () => ({
	createTextEngine: vi.fn().mockImplementation(async () => {
		const renderer = {
			render: vi.fn().mockResolvedValue(undefined)
		};
		mockCreateRenderer = vi.fn().mockReturnValue(renderer);
		mockValidate = vi.fn().mockImplementation((asset: unknown) => ({ value: asset }));
		mockRenderFrame = vi.fn().mockResolvedValue([]);
		mockRegisterFontFromFile = vi.fn().mockResolvedValue(undefined);

		return {
			validate: mockValidate,
			createRenderer: mockCreateRenderer,
			renderFrame: mockRenderFrame,
			registerFontFromUrl: vi.fn().mockResolvedValue(undefined),
			registerFontFromFile: mockRegisterFontFromFile,
			destroy: vi.fn()
		};
	})
}));

// Import after mocks are set up
// eslint-disable-next-line import/first
import { RichTextPlayer } from "@canvas/players/rich-text-player";

interface Deferred<T> {
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
	promise: Promise<T>;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { resolve, reject, promise };
}

function createMockEdit(fontUrlsByKey: Record<string, string>): Edit {
	const fontUrls = Object.values(fontUrlsByKey);
	const events = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
	return {
		size: { width: 1280, height: 720 },
		playbackTime: 0,
		isPlaying: false,
		events,
		getInternalEvents: vi.fn(() => events),
		getTimelineFonts: vi.fn().mockReturnValue(fontUrls.map(src => ({ src }))),
		getFontMetadata: vi.fn().mockReturnValue(new Map<string, { baseFamilyName: string; weight: number }>()),
		getFontUrlByFamilyAndWeight: vi.fn().mockImplementation((family: string, weight: number) => fontUrlsByKey[`${family}|${weight}`] ?? null),
		getEdit: vi.fn().mockReturnValue({
			output: { size: { width: 1280, height: 720 } },
			timeline: { fonts: fontUrls.map(src => ({ src })) }
		})
	} as unknown as Edit;
}

function createClip(asset: RichTextAsset): ResolvedClip {
	return {
		id: "clip-1",
		start: 0,
		length: 6,
		width: 640,
		height: 360,
		asset
	} as unknown as ResolvedClip;
}

function createAsset(weight: number = 400, family: string = "Source Sans"): RichTextAsset {
	return {
		type: "rich-text",
		text: "Hello world",
		font: {
			family,
			weight,
			size: 48,
			color: "#ffffff"
		}
	} as unknown as RichTextAsset;
}

async function createReadyPlayer(
	fontUrlsByKey: Record<string, string> = { "Source Sans|400": "https://cdn.test/source-regular.ttf" }
): Promise<{ player: RichTextPlayer; asset: RichTextAsset; edit: Edit }> {
	const edit = createMockEdit(fontUrlsByKey);
	const asset = createAsset(400);
	const player = new RichTextPlayer(edit, createClip(asset));
	await player.load();
	return { player, asset, edit };
}

async function reconfigure(player: RichTextPlayer, asset: RichTextAsset): Promise<void> {
	await (player as unknown as { reconfigure: (input: RichTextAsset) => Promise<void> }).reconfigure(asset);
}

describe("RichTextPlayer font caching", () => {
	beforeEach(() => {
		mockFetch.mockReset();
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(64))
		});
		global.fetch = mockFetch as unknown as typeof fetch;

		mockOpenTypeParse = vi.fn().mockReturnValue({
			tables: {
				fvar: {
					axes: [{ tag: "wght" }]
				}
			}
		});
		(RichTextPlayer as unknown as { fontCapabilityCache: Map<string, Promise<boolean>> }).fontCapabilityCache.clear();
		(RichTextPlayer as unknown as { fontBytesCache: Map<string, Promise<ArrayBuffer>> }).fontBytesCache.clear();
	});

	it("deduplicates registration across repeated reconfigure calls for the same font key", async () => {
		const { player, asset } = await createReadyPlayer();

		await reconfigure(player, asset);
		await reconfigure(player, asset);
		await reconfigure(player, asset);

		expect(mockRegisterFontFromFile).toHaveBeenCalledTimes(1);
	});

	it("deduplicates in-flight concurrent reconfigure registration calls", async () => {
		const { player, asset } = await createReadyPlayer();
		const deferred = createDeferred<void>();
		mockRegisterFontFromFile.mockImplementationOnce(async () => deferred.promise);

		const first = reconfigure(player, asset);
		const second = reconfigure(player, asset);

		await Promise.resolve();
		expect(mockRegisterFontFromFile).toHaveBeenCalledTimes(1);

		deferred.resolve(undefined);
		await Promise.all([first, second]);
	});

	it("deduplicates capability fetch/parse for repeated reconfigure calls on the same URL", async () => {
		const { player, asset } = await createReadyPlayer();

		await reconfigure(player, asset);
		await reconfigure(player, asset);
		await reconfigure(player, asset);

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(mockOpenTypeParse).toHaveBeenCalledTimes(1);
	});

	it("caches failed registration results and does not retry on subsequent reconfigure", async () => {
		const { player, asset } = await createReadyPlayer();
		mockRegisterFontFromFile.mockRejectedValueOnce(new Error("registration failed"));

		await reconfigure(player, asset);
		await reconfigure(player, asset);

		expect(mockRegisterFontFromFile).toHaveBeenCalledTimes(1);
	});

	it("caches failed capability checks and does not refetch on subsequent reconfigure", async () => {
		const { player, asset } = await createReadyPlayer();
		mockFetch.mockRejectedValueOnce(new Error("fetch failed"));

		await reconfigure(player, asset);
		await reconfigure(player, asset);

		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("treats different URLs as unique keys and performs one registration/check per URL", async () => {
		const { player } = await createReadyPlayer({
			"Source Sans|400": "https://cdn.test/source-regular.ttf",
			"Source Serif|400": "https://cdn.test/source-serif.ttf"
		});

		const regular = createAsset(400, "Source Sans");
		const serif = createAsset(400, "Source Serif");

		await reconfigure(player, regular);
		await reconfigure(player, serif);

		expect(mockRegisterFontFromFile).toHaveBeenCalledTimes(2);
		expect(mockFetch).toHaveBeenCalledTimes(2);
	});

	it("evicts failed font bytes from cache allowing retry on subsequent load", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation();
		const fontUrl = "https://cdn.test/fresh.ttf";
		const edit = createMockEdit({ "Fresh Font|400": fontUrl });
		const asset = {
			type: "rich-text",
			text: "Hello",
			font: { family: "Fresh Font", weight: 400, size: 48, color: "#fff" }
		} as unknown as RichTextAsset;

		// Fail ALL fetches for the first player
		mockFetch.mockRejectedValue(new Error("network error"));
		const player1 = new RichTextPlayer(edit, createClip(asset));
		await player1.load();

		const failedFetchCount = mockFetch.mock.calls.length;

		// Restore fetch to succeed and clear capability cache (also cached the failure)
		mockFetch.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(64))
		});
		(RichTextPlayer as unknown as { fontCapabilityCache: Map<string, Promise<boolean>> }).fontCapabilityCache.clear();

		// Second player with same font — should retry fetch, not get cached rejection
		const player2 = new RichTextPlayer(edit, createClip(asset));
		await player2.load();

		expect(mockFetch.mock.calls.length).toBeGreaterThan(failedFetchCount);
		warnSpy.mockRestore();
	});

	it("resolves string weight 'bold' to numeric 700 for font registration", async () => {
		const edit = createMockEdit({
			"Source Sans|400": "https://cdn.test/source-regular.ttf",
			"Source Sans|700": "https://cdn.test/source-bold.ttf"
		});
		const initialAsset = createAsset(400, "Source Sans");
		const player = new RichTextPlayer(edit, createClip(initialAsset));
		await player.load();

		const boldAsset = {
			type: "rich-text",
			text: "Bold text",
			font: { family: "Source Sans", weight: "bold", size: 48, color: "#ffffff" }
		} as unknown as RichTextAsset;
		await reconfigure(player, boldAsset);

		const { calls } = mockRegisterFontFromFile.mock;
		const boldCall = calls.find(([, desc]: [unknown, { weight: string }]) => desc.weight === "700");
		expect(boldCall).toBeDefined();
	});

	it("resolves string weight '900' to numeric 900 for font registration", async () => {
		const edit = createMockEdit({
			"Source Sans|400": "https://cdn.test/source-regular.ttf",
			"Source Sans|900": "https://cdn.test/source-black.ttf"
		});
		const initialAsset = createAsset(400, "Source Sans");
		const player = new RichTextPlayer(edit, createClip(initialAsset));
		await player.load();

		const blackAsset = {
			type: "rich-text",
			text: "Black text",
			font: { family: "Source Sans", weight: "900", size: 48, color: "#ffffff" }
		} as unknown as RichTextAsset;
		await reconfigure(player, blackAsset);

		const { calls } = mockRegisterFontFromFile.mock;
		const blackCall = calls.find(([, desc]: [unknown, { weight: string }]) => desc.weight === "900");
		expect(blackCall).toBeDefined();
	});

	it("warns on unrecognized string weight and falls back to parsed weight", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation();
		const { player } = await createReadyPlayer();

		const garbageAsset = {
			type: "rich-text",
			text: "Bad weight",
			font: { family: "Source Sans", weight: "garbage", size: 48, color: "#ffffff" }
		} as unknown as RichTextAsset;
		await reconfigure(player, garbageAsset);

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unrecognized font weight "garbage"'));
		warnSpy.mockRestore();
	});

	it("deduplicates registration and capability checks when URL query/hash changes for the same font", async () => {
		const edit = createMockEdit({
			"Source Sans|400": "https://cdn.test/source.ttf?token=first"
		});
		const asset = createAsset(400, "Source Sans");
		const player = new RichTextPlayer(edit, createClip(asset));
		await player.load();

		(edit.getFontUrlByFamilyAndWeight as unknown as Mock).mockReturnValue("https://cdn.test/source.ttf?token=second#hash");

		await reconfigure(player, asset);
		await reconfigure(player, asset);

		expect(mockRegisterFontFromFile).toHaveBeenCalledTimes(1);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("re-uploads the texture source on every repaint so seek/playback shows the current frame", async () => {
		const { player } = await createReadyPlayer();
		const renderFrame = (player as unknown as { renderFrame: (t: number) => Promise<void> }).renderFrame.bind(player);
		const { texture } = player as unknown as { texture: { source: { update: Mock } } };

		// load() created the texture on its frame-0 render; repaints must flag its source dirty.
		// pixi.Texture.from(canvas) is source-cached, so without this the GPU keeps the first
		// frame (blank fade-in start for animated text) forever — the actual bug being guarded.
		expect(texture.source.update).toHaveBeenCalledTimes(0);

		await renderFrame(2.3);
		await renderFrame(4.0);

		expect(texture.source.update).toHaveBeenCalledTimes(2);
		expect((player as unknown as { texture: unknown }).texture).toBe(texture);
	});
});
