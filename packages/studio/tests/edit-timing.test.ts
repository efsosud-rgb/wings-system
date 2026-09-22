/**
 * Edit Class Timing Resolution Tests
 *
 * Tests the timing system that resolves "auto" and "end" values to numeric seconds.
 * Covers pure resolver functions and Edit class integration for propagation.
 */

import { Edit } from "@core/edit-session";
import { PlayerType } from "@canvas/players/player";
import type { EventEmitter } from "@core/events/event-emitter";
import type { ResolvedClip } from "@schemas";
import { resolveAutoStart, resolveAutoLength, resolveEndLength, calculateTimelineEnd } from "@core/timing/resolver";
import { sec } from "@core/timing/types";

// Mock probeMediaDuration since document.createElement doesn't work in Node
vi.mock("@core/timing/resolver", async () => ({
	...(await vi.importActual("@core/timing/resolver")),
	probeMediaDuration: vi.fn().mockResolvedValue(5.0) // 5 seconds
}));

// Mock pixi-filters (must be before pixi.js since it extends pixi classes)
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

// Mock AssetLoader
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

// Mock LumaMaskController
vi.mock("@core/luma-mask-controller", () => ({
	LumaMaskController: vi.fn().mockImplementation(() => ({
		initialize: vi.fn(),
		update: vi.fn(),
		dispose: vi.fn(),
		cleanupForPlayer: vi.fn(),
		getActiveMaskCount: vi.fn().mockReturnValue(0)
	}))
}));

// Mock AlignmentGuides
vi.mock("@canvas/system/alignment-guides", () => ({
	AlignmentGuides: vi.fn().mockImplementation(() => ({
		drawCanvasGuide: vi.fn(),
		drawClipGuide: vi.fn(),
		clear: vi.fn()
	}))
}));

// Create mock container for players
const createMockPlayerContainer = () => {
	const children: unknown[] = [];
	return {
		children,
		parent: null,
		visible: true,
		zIndex: 0,
		addChild: vi.fn((child: unknown) => {
			children.push(child);
			return child;
		}),
		removeChild: vi.fn(),
		destroy: vi.fn(),
		setMask: vi.fn()
	};
};

// Mock player factory with timing intent support
const createMockPlayer = (edit: Edit, config: ResolvedClip, type: PlayerType) => {
	const container = createMockPlayerContainer();
	const contentContainer = createMockPlayerContainer();

	// Calculate initial resolved values in SECONDS (not milliseconds)
	// The timing system now operates in seconds internally
	const startSec = typeof config.start === "number" ? config.start : 0;
	const lengthSec = typeof config.length === "number" ? config.length : 3;

	let resolvedTiming = { start: startSec, length: lengthSec };

	// Mock player object - clipId will be set by reconciler after creation
	const mockPlayer: Record<string, unknown> = {
		clipConfiguration: config,
		clipId: null as string | null,
		layer: 0,
		playerType: type,
		shouldDispose: false,
		getContainer: () => container,
		getContentContainer: () => contentContainer,
		getStart: () => resolvedTiming.start,
		getLength: () => resolvedTiming.length,
		getEnd: () => resolvedTiming.start + resolvedTiming.length,
		getSize: () => ({ width: 1920, height: 1080 }),
		// Read timing intent from document (matches real Player behavior)
		getTimingIntent: () => {
			const clipId = mockPlayer["clipId"] as string | null;
			if (clipId) {
				const docClip = edit.getDocumentClipById(clipId);
				if (docClip) {
					return {
						start: docClip.start,
						length: docClip.length
					};
				}
			}
			// Fallback: use resolved values from clipConfiguration
			return {
				start: config.start,
				length: config.length
			};
		},
		getResolvedTiming: () => ({ ...resolvedTiming }),
		setResolvedTiming: vi.fn((timing: { start: number; length: number }) => {
			resolvedTiming = { ...timing };
			// Sync clipConfiguration to match real Player behavior (Option B)
			// eslint-disable-next-line no-param-reassign
			config.start = sec(timing.start);
			// eslint-disable-next-line no-param-reassign
			config.length = sec(timing.length);
		}),
		load: vi.fn().mockResolvedValue(undefined),
		draw: vi.fn(),
		update: vi.fn(),
		reconfigureAfterRestore: vi.fn(),
		reloadAsset: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn(),
		isActive: () => true,
		getExportableClip: () => {
			const exported = structuredClone(config);
			// Apply timing intent from document (matches real Player behavior)
			const intent = (mockPlayer["getTimingIntent"] as () => { start: unknown; length: unknown })();
			(exported as { start: unknown }).start = intent.start;
			(exported as { length: unknown }).length = intent.length;
			return exported;
		}
	};

	return mockPlayer;
};

// Mock all player types
vi.mock("@canvas/players/video-player", () => ({
	VideoPlayer: vi.fn().mockImplementation((edit, config) => createMockPlayer(edit, config, PlayerType.Video))
}));

vi.mock("@canvas/players/image-player", () => ({
	ImagePlayer: vi.fn().mockImplementation((edit, config) => createMockPlayer(edit, config, PlayerType.Image))
}));

vi.mock("@canvas/players/text-player", () => ({
	TextPlayer: Object.assign(
		vi.fn().mockImplementation((edit, config) => createMockPlayer(edit, config, PlayerType.Text)),
		{ resetFontCache: vi.fn() }
	)
}));

vi.mock("@canvas/players/audio-player", () => ({
	AudioPlayer: vi.fn().mockImplementation((edit, config) => createMockPlayer(edit, config, PlayerType.Audio))
}));

vi.mock("@canvas/players/html-player", () => ({
	HtmlPlayer: vi.fn().mockImplementation((edit, config) => createMockPlayer(edit, config, PlayerType.Html))
}));

vi.mock("@canvas/players/luma-player", () => ({
	LumaPlayer: vi.fn().mockImplementation((edit, config) => createMockPlayer(edit, config, PlayerType.Luma))
}));

vi.mock("@canvas/players/shape-player", () => ({
	ShapePlayer: vi.fn().mockImplementation((edit, config) => createMockPlayer(edit, config, PlayerType.Shape))
}));

vi.mock("@canvas/players/caption-player", () => ({
	CaptionPlayer: vi.fn().mockImplementation((edit, config) => createMockPlayer(edit, config, PlayerType.Caption))
}));

/**
 * Create a mock player-like object for unit testing resolver functions.
 */
function createMockPlayerForResolver(startSec: number, lengthSec: number, lengthIntent: number | "auto" | "end" = lengthSec) {
	return {
		getStart: () => startSec,
		getLength: () => lengthSec,
		getEnd: () => startSec + lengthSec,
		getTimingIntent: () => ({ start: startSec, length: lengthIntent })
	};
}

/**
 * Helper to access private Edit state.
 */
function getEditState(edit: Edit): {
	tracks: unknown[][];
	clips: unknown[];
	endLengthClips: unknown[];
	cachedTimelineEnd: number;
} {
	const anyEdit = edit as unknown as {
		tracks: Array<Array<{ getTimingIntent: () => { length: unknown } }>>;
		timingManager: { getTimelineEnd: () => number };
	};
	const allClips = anyEdit.tracks.flat();
	const endLengthClips = allClips.filter(c => c.getTimingIntent().length === "end");
	return {
		tracks: anyEdit.tracks,
		clips: allClips,
		endLengthClips,
		cachedTimelineEnd: anyEdit.timingManager.getTimelineEnd()
	};
}

/**
 * Create a video clip config.
 */
function createVideoClip(start: number | "auto", length: number | "auto" | "end"): ResolvedClip {
	return {
		asset: { type: "video", src: "https://example.com/video.mp4" },
		start,
		length,
		fit: "crop"
	} as ResolvedClip;
}

/**
 * Create a text clip config.
 */
function createTextClip(start: number | "auto", length: number | "auto" | "end", text: string = "Hello"): ResolvedClip {
	return {
		asset: { type: "text", text },
		start,
		length,
		fit: "none"
	} as unknown as ResolvedClip;
}

// ============================================================================
// UNIT TESTS: Pure Resolver Functions
// ============================================================================

describe("Timing Resolver Functions", () => {
	describe("resolveAutoStart()", () => {
		it("returns 0 for first clip on track", () => {
			const tracks = [[createMockPlayerForResolver(0, 5)]];

			const result = resolveAutoStart(0, 0, tracks as never);

			expect(result).toBe(0);
		});

		it("returns previous clip end for subsequent clips", () => {
			const tracks = [[createMockPlayerForResolver(0, 5), createMockPlayerForResolver(5, 3)]];

			const result = resolveAutoStart(0, 1, tracks as never);

			expect(result).toBe(5); // Previous clip ends at 5s
		});

		it("handles non-contiguous clips (with gaps)", () => {
			const tracks = [
				[
					createMockPlayerForResolver(0, 2),
					createMockPlayerForResolver(5, 3) // Gap from 2s to 5s
				]
			];

			const result = resolveAutoStart(0, 1, tracks as never);

			// Returns previous clip's END, not its actual position
			expect(result).toBe(2);
		});

		it("works independently across tracks", () => {
			const tracks = [[createMockPlayerForResolver(0, 10)], [createMockPlayerForResolver(0, 3)]];

			const resultTrack0 = resolveAutoStart(0, 0, tracks as never);
			const resultTrack1 = resolveAutoStart(1, 0, tracks as never);

			expect(resultTrack0).toBe(0);
			expect(resultTrack1).toBe(0);
		});
	});

	describe("resolveAutoLength()", () => {
		it("falls back to 3s for non-media assets", async () => {
			const asset = { type: "text" as const, text: "Hello" };

			const result = await resolveAutoLength(asset);

			expect(result).toBe(3);
		});

		it("falls back to 3s for assets without src", async () => {
			// Use video asset without src - cast to Asset for testing
			const asset = { type: "video" } as unknown as Parameters<typeof resolveAutoLength>[0];

			const result = await resolveAutoLength(asset);

			expect(result).toBe(3);
		});
	});

	describe("resolveEndLength()", () => {
		it("returns timeline end minus clip start", () => {
			const result = resolveEndLength(sec(2), sec(10));

			expect(result).toBe(8);
		});

		it("never returns negative value", () => {
			const result = resolveEndLength(sec(15), sec(10));

			expect(result).toBe(0);
		});

		it("returns 0 when clip starts at timeline end", () => {
			const result = resolveEndLength(sec(10), sec(10));

			expect(result).toBe(0);
		});

		it("handles clip starting at 0", () => {
			const result = resolveEndLength(sec(0), sec(5));

			expect(result).toBe(5);
		});
	});

	describe("calculateTimelineEnd()", () => {
		it("returns max end time of all clips", () => {
			const tracks = [[createMockPlayerForResolver(0, 5)], [createMockPlayerForResolver(0, 8)], [createMockPlayerForResolver(2, 3)]];

			const result = calculateTimelineEnd(tracks as never);

			expect(result).toBe(8);
		});

		it("excludes clips with length: 'end' to prevent circular dependency", () => {
			const tracks = [
				[createMockPlayerForResolver(0, 5)],
				[createMockPlayerForResolver(0, 15, "end")] // Should be excluded
			];

			const result = calculateTimelineEnd(tracks as never);

			expect(result).toBe(5); // Only the first clip counts
		});

		it("returns 0 for empty tracks", () => {
			const tracks: unknown[][] = [];

			const result = calculateTimelineEnd(tracks as never);

			expect(result).toBe(0);
		});

		it("returns 0 when all clips have length: 'end'", () => {
			const tracks = [[createMockPlayerForResolver(0, 10, "end")]];

			const result = calculateTimelineEnd(tracks as never);

			expect(result).toBe(0);
		});
	});
});

// ============================================================================
// INTEGRATION TESTS: Edit Class Timing
// ============================================================================

describe("Edit Timing Integration", () => {
	let edit: Edit;
	let events: EventEmitter;
	let emitSpy: MockInstance;

	beforeEach(async () => {
		edit = new Edit({
			timeline: {
				tracks: [{ clips: [{ asset: { type: "image", src: "https://example.com/image.jpg" }, start: 0, length: 1 }] }]
			},
			output: { size: { width: 1920, height: 1080 }, format: "mp4" }
		});
		await edit.load();

		events = edit.getInternalEvents();
		emitSpy = vi.spyOn(events, "emit");
	});

	afterEach(() => {
		edit.dispose();
		vi.clearAllMocks();
	});

	describe("start: 'auto' resolution", () => {
		it("clip with auto start resolves to end of previous clip", async () => {
			// Auto start resolves to end of previous clip (initial image: 0-1s)
			await edit.addClip(0, createVideoClip("auto", 5));

			const clip = edit.getPlayerClip(0, 1);
			expect(clip?.getStart()).toBe(1);
		});

		it("preserves timing intent for auto start clips", async () => {
			await edit.addClip(0, createVideoClip("auto", 5));

			const clip = edit.getPlayerClip(0, 1);
			expect(clip?.getTimingIntent().start).toBe("auto");
		});

		it("each track has independent first clip at 0", async () => {
			await edit.addClip(0, createVideoClip(0, 10)); // Track 0
			await edit.addClip(1, createVideoClip("auto", 5)); // Track 1 - first clip

			const clipTrack1 = edit.getPlayerClip(1, 0);
			expect(clipTrack1?.getStart()).toBe(0); // First on its track
		});
	});

	describe("length: 'auto' resolution", () => {
		it("defaults to 3s for text assets without duration", async () => {
			await edit.addClip(0, createTextClip(0, "auto"));

			const clip = edit.getPlayerClip(0, 1);
			expect(clip?.getLength()).toBe(3);
		});

		it("preserves timing intent for auto length clips", async () => {
			await edit.addClip(0, createTextClip(0, "auto"));

			const clip = edit.getPlayerClip(0, 1);
			expect(clip?.getTimingIntent().length).toBe("auto");
		});
	});

	describe("length: 'end' intent", () => {
		it("preserves 'end' in timing intent", async () => {
			await edit.addClip(0, createVideoClip(0, 5)); // Establish timeline
			await edit.addClip(1, createTextClip(0, "end"));

			const endClip = edit.getPlayerClip(1, 0);
			expect(endClip?.getTimingIntent().length).toBe("end");
		});

		it("tracks clip in endLengthClips set", async () => {
			await edit.addClip(0, createTextClip(0, "end"));

			const { endLengthClips } = getEditState(edit);
			expect(endLengthClips.length).toBe(1);
		});
	});

	describe("endLengthClips tracking", () => {
		it("adds clip to set when length is 'end'", async () => {
			await edit.addClip(0, createTextClip(0, "end"));

			const { endLengthClips } = getEditState(edit);
			expect(endLengthClips.length).toBe(1);
		});

		it("removes clip from set when deleted", async () => {
			await edit.addClip(0, createTextClip(0, "end"));
			const { endLengthClips: before } = getEditState(edit);
			expect(before.length).toBe(1);

			edit.deleteClip(0, 1);

			const { endLengthClips: after } = getEditState(edit);
			expect(after.length).toBe(0);
		});

		it("does not add fixed-length clips to set", async () => {
			await edit.addClip(0, createVideoClip(0, 5));

			const { endLengthClips } = getEditState(edit);
			expect(endLengthClips.length).toBe(0);
		});
	});

	describe("clip updates", () => {
		it("updateClip emits clip:updated event", async () => {
			await edit.addClip(0, createVideoClip(0, 5));
			emitSpy.mockClear();

			edit.updateClip(0, 0, { start: sec(1) });

			expect(emitSpy).toHaveBeenCalledWith("clip:updated", expect.anything());
		});

		it("updateClip preserves timing intent type", async () => {
			await edit.addClip(0, createVideoClip("auto", 5));

			// Updating other properties shouldn't change timing intent
			edit.updateClip(0, 1, { opacity: 0.5 });

			const clip = edit.getPlayerClip(0, 1);
			expect(clip?.getTimingIntent().start).toBe("auto");
		});
	});

	describe("duration calculations with timing", () => {
		it("totalDuration reflects max clip end (in ms)", async () => {
			await edit.addClip(0, createVideoClip(0, 5));
			await edit.addClip(1, createVideoClip(0, 8));

			expect(edit.totalDuration).toBe(8); // in seconds
		});

		it("duration reflects initial clip", () => {
			expect(edit.totalDuration).toBe(1);
		});

		it("duration updates when clip is deleted", async () => {
			await edit.addClip(0, createVideoClip(0, 5));
			await edit.addClip(1, createVideoClip(0, 8));
			expect(edit.totalDuration).toBe(8);

			edit.deleteClip(1, 0);

			expect(edit.totalDuration).toBe(5);
		});
	});

	// =========================================================================
	// REGRESSION TESTS: Auto Timing Bug Fixes
	// =========================================================================

	describe("propagateTimingChanges includes first clip (regression)", () => {
		it("first clip with auto start resolves to 0 after updateClipTiming", async () => {
			// Add clip with manual start at 5s
			await edit.addClip(0, createVideoClip(5, 3));
			expect(edit.getPlayerClip(0, 1)?.getStart()).toBe(5);

			// Change to auto start via updateClipTiming
			edit.updateClipTiming(0, 1, { start: "auto" });

			// Should resolve to 0 (first added clip, auto resolves after initial image)
			expect(edit.getPlayerClip(0, 1)?.getStart()).toBe(1);
		});

		it("second clip with auto start resolves to end of first clip", async () => {
			await edit.addClip(0, createVideoClip(0, 5));
			await edit.addClip(0, createVideoClip(10, 3)); // Manual start at 10s

			// Change third clip to auto start
			edit.updateClipTiming(0, 2, { start: "auto" });

			// Should resolve to 5 (end of second clip: video 0-5s)
			expect(edit.getPlayerClip(0, 2)?.getStart()).toBe(5);
		});
	});

	describe("clipConfiguration syncs with resolved timing (regression)", () => {
		it("clipConfiguration.length updates after auto length resolution", async () => {
			// Add text clip with manual length 5s
			await edit.addClip(0, createTextClip(0, 5));
			expect(edit.getPlayerClip(0, 1)?.clipConfiguration.length).toBe(5);

			// Change to auto length
			edit.updateClipTiming(0, 1, { length: "auto" });

			// Wait for async resolution
			await new Promise(resolve => {
				setTimeout(resolve, 50);
			});

			// clipConfiguration.length should now be 3 (default for text)
			const clip = edit.getPlayerClip(0, 1);
			expect(clip?.clipConfiguration.length).toBe(3);
		});

		it("end-length clip is tracked for updates", async () => {
			// Add video clip 0-5s
			await edit.addClip(0, createVideoClip(0, 5));
			// Add end-length clip on another track
			await edit.addClip(1, createTextClip(0, "end"));

			const endClip = edit.getPlayerClip(1, 0);
			// The intent should be preserved
			expect(endClip?.getTimingIntent().length).toBe("end");

			// Clip should be tracked in endLengthClips set
			const { endLengthClips } = getEditState(edit);
			expect(endLengthClips.length).toBe(1);
		});
	});

	describe("ClipUpdated event data integrity (regression)", () => {
		it("previous and current show different values after timing change", async () => {
			await edit.addClip(0, createTextClip(0, 5));
			emitSpy.mockClear();

			// Change length from 5s to 3s (use Seconds branded type)
			edit.updateClipTiming(0, 1, { length: sec(3) });

			const clipUpdatedCalls = emitSpy.mock.calls.filter(call => call[0] === "clip:updated");
			expect(clipUpdatedCalls.length).toBeGreaterThan(0);

			const lastCall = clipUpdatedCalls[clipUpdatedCalls.length - 1];
			const { previous, current } = lastCall[1] as { previous: { clip: { length: number } }; current: { clip: { length: number } } };

			// Previous should have old value, current should have new value
			expect(previous.clip.length).toBe(5);
			expect(current.clip.length).toBe(3);
		});

		it("nested objects in previous are not affected by mutations", async () => {
			await edit.addClip(0, createVideoClip(0, 5));
			emitSpy.mockClear();

			// Update timing (use Seconds branded type)
			edit.updateClipTiming(0, 0, { start: sec(2) });

			const clipUpdatedCalls = emitSpy.mock.calls.filter(call => call[0] === "clip:updated");
			const lastCall = clipUpdatedCalls[clipUpdatedCalls.length - 1];
			const { previous, current } = lastCall[1] as { previous: { clip: { start: number } }; current: { clip: { start: number } } };

			// Verify deep clone worked - previous should have old start
			expect(previous.clip.start).toBe(0);
			expect(current.clip.start).toBe(2);
		});
	});

	describe("timing resolution order (regression)", () => {
		it("auto start resolves correctly when changed via updateClipTiming", async () => {
			// First clip at 0-5s
			await edit.addClip(0, createVideoClip(0, 5));

			// Second clip initially at 0
			await edit.addClip(0, createTextClip(0, 3));
			expect(edit.getPlayerClip(0, 2)?.getStart()).toBe(0);

			// Change to auto start
			edit.updateClipTiming(0, 2, { start: "auto" });

			// Should now be at 5s (after video clip 0-5s)
			const secondClip = edit.getPlayerClip(0, 2);
			expect(secondClip?.getStart()).toBe(5);
			expect(secondClip?.getEnd()).toBe(8);
		});

		it("end-length calculation uses resolved start not stale value", async () => {
			// Create timeline: clip1 at 0-5s
			await edit.addClip(0, createVideoClip(0, 5));

			// Add second clip at 0 with fixed length
			await edit.addClip(0, createTextClip(0, 3));

			// Change to auto start AND end length in one call
			edit.updateClipTiming(0, 2, { start: "auto", length: "end" });

			const endClip = edit.getPlayerClip(0, 2);

			// KEY TEST: Start should be 5s (after video clip 0-5s)
			// This verifies that start is resolved BEFORE length calculations
			expect(endClip?.getStart()).toBe(5);

			// Verify intent is correctly set to "end"
			expect(endClip?.getTimingIntent().length).toBe("end");

			// Verify clip is tracked for end-length updates
			const state = getEditState(edit);
			expect(state.endLengthClips.includes(endClip!)).toBe(true);
		});
	});
});
