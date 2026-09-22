/**
 * @jest-environment jsdom
 */
/* eslint-disable import/first, max-classes-per-file */

// Mock pixi.js before any imports that use it
vi.mock("pixi.js", () => ({
	Container: vi.fn().mockImplementation(() => ({
		children: [],
		parent: null,
		addChild: vi.fn(),
		removeChild: vi.fn(),
		destroy: vi.fn()
	})),
	Sprite: vi.fn(),
	Texture: vi.fn()
}));

vi.mock("../src/components/canvas/players/player", () => {
	class MockPlayer {
		clipConfiguration = {};

		getMergeFieldBinding = vi.fn(() => null);
	}
	return {
		Player: MockPlayer,
		PlayerType: {
			Video: "video",
			Image: "image",
			Audio: "audio",
			Text: "text",
			Html: "html",
			Shape: "shape",
			Caption: "caption",
			Luma: "luma",
			RichText: "rich-text",
			Svg: "svg"
		}
	};
});

vi.mock("../src/core/shotstack-edit", () => ({
	ShotstackEdit: class MockShotstackEdit {}
}));

vi.mock("../src/core/edit-session", () => ({}));

global.IntersectionObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn()
})) as unknown as typeof IntersectionObserver;

global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn()
})) as unknown as typeof ResizeObserver;

// ============================================================================
// Helpers
// ============================================================================

function createMockEventEmitter() {
	const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
	return {
		on: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(callback);
		}),
		off: vi.fn(),
		emit: vi.fn((event: string, ...args: unknown[]) => {
			if (listeners[event]) listeners[event].forEach(cb => cb(...args));
		}),
		trigger: (event: string, ...args: unknown[]) => {
			if (listeners[event]) listeners[event].forEach(cb => cb(...args));
		}
	};
}

function createMockEdit(overrides: Record<string, unknown> = {}) {
	const events = createMockEventEmitter();
	return {
		getInternalEvents: vi.fn(() => events),
		getPlayerClip: vi.fn(() => null),
		getClip: vi.fn(() => null),
		getClipId: vi.fn<string, [number, number]>().mockReturnValue("mock-clip-id"),
		getResolvedClip: vi.fn(() => null),
		getResolvedClipById: vi.fn(() => null),
		getDocumentClip: vi.fn<Record<string, unknown> | null, [number, number?]>().mockReturnValue({ start: 0, length: 1 }),
		getCurrentTime: vi.fn(() => 0),
		getEdit: vi.fn(() => ({
			timeline: {
				fonts: [],
				tracks: [{ clips: [{ asset: { type: "rich-caption" }, start: 0, length: 5 }] }]
			}
		})),
		getDocument: vi.fn(() => ({
			getFonts: vi.fn(() => []),
			getClipBinding: vi.fn(() => null),
			getTrackCount: vi.fn(() => 0),
			getClipsInTrack: vi.fn(() => [])
		})),
		getFontMetadata: vi.fn(() => new Map()),
		getMergeFieldForProperty: vi.fn(() => null),
		selectClip: vi.fn(),
		focusClip: vi.fn(),
		blurClip: vi.fn(),
		updateClip: vi.fn(),
		updateClipInDocument: vi.fn(),
		resolveClip: vi.fn(),
		commitClipUpdate: vi.fn(),
		deleteClip: vi.fn(),
		canDeleteClip: vi.fn(() => true),
		getToolbarButtons: vi.fn(() => []),
		getSelectedClipInfo: vi.fn(() => null),
		mergeFields: {
			getAll: vi.fn(() => []),
			register: vi.fn(),
			deleteMergeFieldGlobally: vi.fn()
		},
		events,
		playbackTime: 0,
		isSrcMergeField: vi.fn(() => false),
		updateMergeFieldValueLive: vi.fn(),
		setOutputSize: vi.fn(),
		setOutputFps: vi.fn(),
		getOutputFps: vi.fn(() => 25),
		setTimelineBackground: vi.fn(),
		getTimelineBackground: vi.fn(() => "#000000"),
		size: { width: 1920, height: 1080 },
		...overrides
	};
}

function createCaptionAsset(overrides: Record<string, unknown> = {}) {
	return {
		type: "rich-caption",
		animation: { style: "karaoke", direction: "up" },
		active: {
			font: { color: "#ffff00", opacity: 1 },
			stroke: { width: 2, color: "#000000", opacity: 1 }
		},
		font: { family: "Open Sans", size: 48, color: "#ffffff", weight: 400 },
		...overrides
	};
}

function setupCaptionClip(mockEdit: ReturnType<typeof createMockEdit>, assetOverrides: Record<string, unknown> = {}) {
	const asset = createCaptionAsset(assetOverrides);
	const clip = { asset, start: 0, length: 5 };
	mockEdit.getPlayerClip.mockReturnValue({ clipConfiguration: clip, getMergeFieldBinding: vi.fn(() => null) } as never);
	mockEdit.getResolvedClip.mockReturnValue(clip as never);
	return asset;
}

function createTestContainer(): HTMLDivElement {
	const container = document.createElement("div");
	document.body.appendChild(container);
	return container;
}

function cleanupTestContainer(container: HTMLDivElement): void {
	container.remove();
}

function simulateClick(el: Element | null): void {
	el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function simulateInput(el: HTMLInputElement | null, value: string | number): void {
	if (!el) return;
	el.value = String(value); // eslint-disable-line no-param-reassign
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

// ============================================================================
// RichCaptionToolbar Tests
// ============================================================================

describe("RichCaptionToolbar", () => {
	let toolbar: InstanceType<typeof import("../src/core/ui/rich-caption-toolbar").RichCaptionToolbar>;
	let mockEdit: ReturnType<typeof createMockEdit>;
	let container: HTMLDivElement;

	beforeEach(async () => {
		mockEdit = createMockEdit();
		const { RichCaptionToolbar } = await import("../src/core/ui/rich-caption-toolbar");
		toolbar = new RichCaptionToolbar(mockEdit as never);
		container = createTestContainer();
	});

	afterEach(() => {
		toolbar.dispose();
		cleanupTestContainer(container);
	});

	// ── DOM Structure ──────────────────────────────────────────────────

	describe("injected caption controls", () => {
		beforeEach(() => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);
		});

		it("should inject Animation dropdown with animation style buttons", () => {
			const btn = container.querySelector('[data-action="caption-word-anim-toggle"]');
			expect(btn).not.toBeNull();
			expect(btn?.textContent).toBe("Animation");

			const styleButtons = container.querySelectorAll("[data-caption-word-style]");
			expect(styleButtons.length).toBe(8);

			const styles = Array.from(styleButtons).map(b => (b as HTMLElement).dataset["captionWordStyle"]);
			expect(styles).toContain("karaoke");
			expect(styles).toContain("pop");
			expect(styles).toContain("typewriter");
			expect(styles).toContain("none");
		});

		it("should inject Words dropdown with direction buttons", () => {
			const directionBtns = container.querySelectorAll("[data-caption-word-direction]");
			expect(directionBtns.length).toBe(4);

			const directions = Array.from(directionBtns).map(b => (b as HTMLElement).dataset["captionWordDirection"]);
			expect(directions).toEqual(["left", "right", "up", "down"]);
		});

		it("should inject Active Word dropdown with color, opacity, highlight controls", () => {
			const btn = container.querySelector('[data-action="active-word-toggle"]');
			expect(btn).not.toBeNull();
			expect(btn?.textContent).toBe("Active Word");

			expect(container.querySelector("[data-active-font-color]")).not.toBeNull();
			expect(container.querySelector("[data-active-font-opacity]")).not.toBeNull();
			expect(container.querySelector("[data-active-font-highlight]")).not.toBeNull();
		});

		it("should inject Active Word dropdown with stroke controls", () => {
			expect(container.querySelector("[data-active-stroke-width]")).not.toBeNull();
			expect(container.querySelector("[data-active-stroke-color]")).not.toBeNull();
			expect(container.querySelector("[data-active-stroke-opacity]")).not.toBeNull();
		});

		it("should hide irrelevant rich-text controls", () => {
			["text-edit-toggle", "animation-toggle", "transition-toggle", "effect-toggle"].forEach(action => {
				const btn = container.querySelector(`[data-action="${action}"]`);
				if (btn) {
					const dropdown = btn.closest(".ss-toolbar-dropdown") as HTMLElement | null;
					const target = dropdown ?? (btn as HTMLElement);
					expect(target.style.display).toBe("none");
				}
			});
		});
	});

	// ── Popup Toggling ─────────────────────────────────────────────────

	describe("popup management", () => {
		beforeEach(() => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);
		});

		it("should toggle Words popup on click", () => {
			const btn = container.querySelector('[data-action="caption-word-anim-toggle"]');
			simulateClick(btn);

			const popup = container.querySelector("[data-caption-word-anim-popup]");
			expect(popup?.classList.contains("visible")).toBe(true);
		});

		it("should toggle Active Word popup on click", () => {
			const btn = container.querySelector('[data-action="active-word-toggle"]');
			simulateClick(btn);

			const popup = container.querySelector("[data-active-word-popup]");
			expect(popup?.classList.contains("visible")).toBe(true);
		});
	});

	// ── State Sync ─────────────────────────────────────────────────────

	describe("syncState", () => {
		it("should sync word animation style buttons", () => {
			setupCaptionClip(mockEdit, { animation: { style: "pop" } });
			toolbar.mount(container);
			toolbar.show(0, 0);

			const popBtn = container.querySelector('[data-caption-word-style="pop"]');
			expect(popBtn?.classList.contains("active")).toBe(true);

			const karaokeBtn = container.querySelector('[data-caption-word-style="karaoke"]');
			expect(karaokeBtn?.classList.contains("active")).toBe(false);
		});

		it("should show direction section only for 'slide' animation", () => {
			setupCaptionClip(mockEdit, { animation: { style: "slide", direction: "left" } });
			toolbar.mount(container);
			toolbar.show(0, 0);

			const dirSection = container.querySelector("[data-caption-word-direction-section]") as HTMLElement;
			expect(dirSection?.style.display).toBe("");
		});

		it("should hide direction section for non-slide animations", () => {
			setupCaptionClip(mockEdit, { animation: { style: "karaoke" } });
			toolbar.mount(container);
			toolbar.show(0, 0);

			const dirSection = container.querySelector("[data-caption-word-direction-section]") as HTMLElement;
			expect(dirSection?.style.display).toBe("none");
		});

		it("should sync active word color input", () => {
			setupCaptionClip(mockEdit, { active: { font: { color: "#ff0000", opacity: 1 } } });
			toolbar.mount(container);
			toolbar.show(0, 0);

			const input = container.querySelector("[data-active-font-color]") as HTMLInputElement;
			expect(input?.value).toBe("#ff0000");
		});

		it("should sync active word opacity slider", () => {
			setupCaptionClip(mockEdit, { active: { font: { color: "#ffff00", opacity: 0.5 } } });
			toolbar.mount(container);
			toolbar.show(0, 0);

			const slider = container.querySelector("[data-active-font-opacity]") as HTMLInputElement;
			expect(slider?.value).toBe("50");

			const display = container.querySelector("[data-active-font-opacity-value]");
			expect(display?.textContent).toBe("50%");
		});

		it("should sync active stroke width slider", () => {
			setupCaptionClip(mockEdit, { active: { stroke: { width: 4, color: "#00ff00", opacity: 0.75 } } });
			toolbar.mount(container);
			toolbar.show(0, 0);

			const widthSlider = container.querySelector("[data-active-stroke-width]") as HTMLInputElement;
			expect(widthSlider?.value).toBe("4");

			const colorInput = container.querySelector("[data-active-stroke-color]") as HTMLInputElement;
			expect(colorInput?.value).toBe("#00ff00");

			const opacitySlider = container.querySelector("[data-active-stroke-opacity]") as HTMLInputElement;
			expect(opacitySlider?.value).toBe("75");
		});
	});

	// ── User Interactions ──────────────────────────────────────────────

	// Wings: an empty suite is an error in Vitest.
	describe.todo("layout controls");

	describe("word animation controls", () => {
		it("should call updateClip when animation style button is clicked", () => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);
			toolbar.show(0, 0);

			const popBtn = container.querySelector('[data-caption-word-style="pop"]');
			simulateClick(popBtn);

			expect(mockEdit.updateClip).toHaveBeenCalledWith(
				0,
				0,
				expect.objectContaining({
					asset: expect.objectContaining({
						animation: expect.objectContaining({ style: "pop" })
					})
				})
			);
		});

		it("should call updateClip when direction button is clicked", () => {
			setupCaptionClip(mockEdit, { animation: { style: "slide", direction: "up" } });
			toolbar.mount(container);
			toolbar.show(0, 0);

			const leftBtn = container.querySelector('[data-caption-word-direction="left"]');
			simulateClick(leftBtn);

			expect(mockEdit.updateClip).toHaveBeenCalledWith(
				0,
				0,
				expect.objectContaining({
					asset: expect.objectContaining({
						animation: expect.objectContaining({ direction: "left" })
					})
				})
			);
		});
	});

	describe("active word controls", () => {
		it("should call updateClip when active color changes", () => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);
			toolbar.show(0, 0);

			const input = container.querySelector("[data-active-font-color]") as HTMLInputElement;
			simulateInput(input, "#00ff00");

			expect(mockEdit.updateClip).toHaveBeenCalledWith(
				0,
				0,
				expect.objectContaining({
					asset: expect.objectContaining({
						active: expect.objectContaining({
							font: expect.objectContaining({ color: "#00ff00" })
						})
					})
				})
			);
		});

		it("should call updateClip when opacity slider changes", () => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);
			toolbar.show(0, 0);

			const slider = container.querySelector("[data-active-font-opacity]") as HTMLInputElement;
			simulateInput(slider, "75");

			expect(mockEdit.updateClip).toHaveBeenCalledWith(
				0,
				0,
				expect.objectContaining({
					asset: expect.objectContaining({
						active: expect.objectContaining({
							font: expect.objectContaining({ opacity: 0.75 })
						})
					})
				})
			);
		});

		it("should call updateClip when stroke width slider changes", () => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);
			toolbar.show(0, 0);

			const slider = container.querySelector("[data-active-stroke-width]") as HTMLInputElement;
			simulateInput(slider, "5");

			expect(mockEdit.updateClip).toHaveBeenCalledWith(
				0,
				0,
				expect.objectContaining({
					asset: expect.objectContaining({
						active: expect.objectContaining({
							stroke: expect.objectContaining({ width: 5 })
						})
					})
				})
			);
		});
	});

	// ── Source Popup ──────────────────────────────────────────────────

	describe("source popup", () => {
		it("should render Source button in caption toolbar", () => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);

			const btn = container.querySelector('[data-action="caption-source-toggle"]');
			expect(btn).not.toBeNull();
			expect(btn?.textContent?.trim()).toBe("Source");
		});

		it("should toggle Source popup on click", () => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);

			const btn = container.querySelector('[data-action="caption-source-toggle"]');
			simulateClick(btn);

			const popup = container.querySelector("[data-caption-source-popup]");
			expect(popup?.classList.contains("visible")).toBe(true);
		});

		it("should show empty state when no eligible clips exist", () => {
			setupCaptionClip(mockEdit);
			mockEdit.getDocument.mockReturnValue({
				getFonts: vi.fn(() => []),
				getClipBinding: vi.fn(() => null),
				getTrackCount: vi.fn(() => 1),
				getClipsInTrack: vi.fn(() => [{ asset: { type: "rich-caption" }, start: 0, length: 5 }])
			} as never);
			toolbar.mount(container);

			const btn = container.querySelector('[data-action="caption-source-toggle"]');
			simulateClick(btn);

			const emptyMsg = container.querySelector(".ss-source-empty");
			expect(emptyMsg).not.toBeNull();
			expect(emptyMsg?.textContent).toContain("No video, audio, or TTS clips found");
		});

		it("should list eligible clips in source popup", () => {
			setupCaptionClip(mockEdit);
			mockEdit.getDocument.mockReturnValue({
				getFonts: vi.fn(() => []),
				getClipBinding: vi.fn(() => null),
				getTrackCount: vi.fn(() => 2),
				getClipsInTrack: vi.fn((t: number) => {
					if (t === 0) return [{ asset: { type: "rich-caption" }, start: 0, length: 5 }];
					if (t === 1) return [{ asset: { type: "video" }, start: 0, length: 10 }];
					return [];
				})
			} as never);
			mockEdit.getClipId.mockImplementation((t: number, c: number) => `clip-${t}-${c}`);
			toolbar.mount(container);

			const btn = container.querySelector('[data-action="caption-source-toggle"]');
			simulateClick(btn);

			const items = container.querySelectorAll(".ss-source-item");
			// 1 video clip + 1 "None" option
			expect(items.length).toBe(2);
			expect(items[0].textContent).toContain("Video · Track 2 · Clip 1");
		});

		it("should show linked indicator when caption has source alias", () => {
			setupCaptionClip(mockEdit, { src: "alias://my_source" });
			mockEdit.getDocument.mockReturnValue({
				getFonts: vi.fn(() => []),
				getClipBinding: vi.fn(() => null),
				getTrackCount: vi.fn(() => 2),
				getClipsInTrack: vi.fn((t: number) => {
					if (t === 0) return [{ asset: { type: "rich-caption", src: "alias://my_source" }, start: 0, length: 5 }];
					if (t === 1) return [{ asset: { type: "video" }, start: 0, length: 10, alias: "my_source" }];
					return [];
				})
			} as never);
			mockEdit.getDocumentClip.mockImplementation((t: number) => {
				if (t === 0) return { asset: { type: "rich-caption", src: "alias://my_source" }, start: 0, length: 5 };
				if (t === 1) return { asset: { type: "video" }, start: 0, length: 10, alias: "my_source" };
				return null;
			});
			mockEdit.getClipId.mockImplementation((t: number, c: number) => `clip-${t}-${c}`);
			toolbar.mount(container);
			toolbar.show(0, 0);

			const dot = container.querySelector("[data-source-dot]");
			expect(dot?.classList.contains("linked")).toBe(true);
		});

		it("should not show linked indicator when caption has no source", () => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);
			toolbar.show(0, 0);

			const dot = container.querySelector("[data-source-dot]");
			expect(dot?.classList.contains("linked")).toBe(false);
		});

		it("should focus source clip on hover by calling focusClip", () => {
			setupCaptionClip(mockEdit);
			mockEdit.getDocument.mockReturnValue({
				getFonts: vi.fn(() => []),
				getClipBinding: vi.fn(() => null),
				getTrackCount: vi.fn(() => 2),
				getClipsInTrack: vi.fn((t: number) => {
					if (t === 0) return [{ asset: { type: "rich-caption" }, start: 0, length: 5 }];
					if (t === 1) return [{ asset: { type: "video" }, start: 0, length: 10 }];
					return [];
				})
			} as never);
			mockEdit.getClipId.mockImplementation((t: number, c: number) => `clip-${t}-${c}`);
			toolbar.mount(container);
			toolbar.show(0, 0);

			// Open popup
			const btn = container.querySelector('[data-action="caption-source-toggle"]');
			simulateClick(btn);

			// Hover over the video source item
			const items = container.querySelectorAll(".ss-source-item");
			items[0].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

			expect(mockEdit.focusClip).toHaveBeenCalledWith(1, 0);
		});

		it("should blur focus on mouse leave without changing selection", () => {
			setupCaptionClip(mockEdit);
			mockEdit.getDocument.mockReturnValue({
				getFonts: vi.fn(() => []),
				getClipBinding: vi.fn(() => null),
				getTrackCount: vi.fn(() => 2),
				getClipsInTrack: vi.fn((t: number) => {
					if (t === 0) return [{ asset: { type: "rich-caption" }, start: 0, length: 5 }];
					if (t === 1) return [{ asset: { type: "video" }, start: 0, length: 10 }];
					return [];
				})
			} as never);
			mockEdit.getClipId.mockImplementation((t: number, c: number) => `clip-${t}-${c}`);
			toolbar.mount(container);
			toolbar.show(0, 0);

			// Open popup
			const btn = container.querySelector('[data-action="caption-source-toggle"]');
			simulateClick(btn);

			const items = container.querySelectorAll(".ss-source-item");
			items[0].dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
			mockEdit.selectClip.mockClear();

			// Mouse leave — should blur focus, NOT call selectClip
			items[0].dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));

			expect(mockEdit.blurClip).toHaveBeenCalled();
			expect(mockEdit.selectClip).not.toHaveBeenCalled();
		});

		it("should blur on mouseleave even without preceding mouseenter (idempotent)", () => {
			setupCaptionClip(mockEdit);
			mockEdit.getDocument.mockReturnValue({
				getFonts: vi.fn(() => []),
				getClipBinding: vi.fn(() => null),
				getTrackCount: vi.fn(() => 2),
				getClipsInTrack: vi.fn((t: number) => {
					if (t === 0) return [{ asset: { type: "rich-caption" }, start: 0, length: 5 }];
					if (t === 1) return [{ asset: { type: "video" }, start: 0, length: 10 }];
					return [];
				})
			} as never);
			mockEdit.getClipId.mockImplementation((t: number, c: number) => `clip-${t}-${c}`);
			toolbar.mount(container);
			toolbar.show(0, 0);

			// Open popup
			const btn = container.querySelector('[data-action="caption-source-toggle"]');
			simulateClick(btn);

			// Directly trigger mouseleave without preceding mouseenter
			const items = container.querySelectorAll(".ss-source-item");
			items[0].dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));

			// blurClip is idempotent — always called on mouseleave
			expect(mockEdit.blurClip).toHaveBeenCalled();
		});

		it("should call updateClip with unlinked source when 'None' is clicked", () => {
			setupCaptionClip(mockEdit, { src: "alias://my_source" });
			mockEdit.getDocument.mockReturnValue({
				getFonts: vi.fn(() => []),
				getClipBinding: vi.fn(() => null),
				getTrackCount: vi.fn(() => 2),
				getClipsInTrack: vi.fn((t: number) => {
					if (t === 0) return [{ asset: { type: "rich-caption", src: "alias://my_source" }, start: 0, length: 5 }];
					if (t === 1) return [{ asset: { type: "video" }, start: 0, length: 10, alias: "my_source" }];
					return [];
				})
			} as never);
			mockEdit.getClipId.mockImplementation((t: number, c: number) => `clip-${t}-${c}`);
			toolbar.mount(container);
			toolbar.show(0, 0);

			// Open popup
			const btn = container.querySelector('[data-action="caption-source-toggle"]');
			simulateClick(btn);

			// Click the "None" option (last item)
			const items = container.querySelectorAll(".ss-source-item");
			const noneItem = items[items.length - 1];
			simulateClick(noneItem);

			expect(mockEdit.updateClip).toHaveBeenCalledWith(
				0,
				0,
				expect.objectContaining({
					asset: expect.objectContaining({
						src: "alias://"
					})
				})
			);
		});
	});

	// ── StylePanel Override ────────────────────────────────────────────

	describe("createStylePanel override", () => {
		it("should keep stroke tab visible", () => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);

			const strokeTab = container.querySelector('[data-style-tab="stroke"]') as HTMLElement;
			expect(strokeTab?.style.display).not.toBe("none");
		});
	});

	// ── Dispose ────────────────────────────────────────────────────────

	describe("dispose", () => {
		it("should null all caption-specific refs", async () => {
			setupCaptionClip(mockEdit);
			toolbar.mount(container);
			toolbar.dispose();

			// After dispose, mounting a new container should work without errors
			const newContainer = createTestContainer();
			const { RichCaptionToolbar } = await vi.importActual(
				"../src/core/ui/rich-caption-toolbar"
			) as typeof import("../src/core/ui/rich-caption-toolbar");
			const newToolbar = new RichCaptionToolbar(mockEdit as never);
			expect(() => newToolbar.mount(newContainer)).not.toThrow();
			newToolbar.dispose();
			cleanupTestContainer(newContainer);
		});
	});
});

// ============================================================================
// Word spacing exclusion (RichCaptionStyle rejects the key — never render or write it)
// ============================================================================

describe("RichCaptionToolbar spacing controls", () => {
	let toolbar: InstanceType<typeof import("../src/core/ui/rich-caption-toolbar").RichCaptionToolbar>;
	let mockEdit: ReturnType<typeof createMockEdit>;
	let container: HTMLDivElement;

	beforeEach(async () => {
		mockEdit = createMockEdit();
		const { RichCaptionToolbar } = await import("../src/core/ui/rich-caption-toolbar");
		toolbar = new RichCaptionToolbar(mockEdit as never);
		container = createTestContainer();
		setupCaptionClip(mockEdit);
		toolbar.mount(container);
	});

	afterEach(() => {
		toolbar.dispose();
		cleanupTestContainer(container);
	});

	it("does not render a word-spacing slider", () => {
		expect(container.querySelector("[data-word-spacing-slider]")).toBeNull();
		expect(container.querySelector("[data-letter-spacing-slider]")).not.toBeNull();
	});

	it("omits wordSpacing from spacing updates", () => {
		const slider = container.querySelector("[data-letter-spacing-slider]") as HTMLInputElement;
		expect(slider).not.toBeNull();
		simulateInput(slider, 5);

		expect(mockEdit.updateClip).toHaveBeenCalled();
		const lastCall = mockEdit.updateClip.mock.calls.at(-1) as unknown[];
		const updates = lastCall[2] as { asset: { style: Record<string, unknown> } };
		expect(updates.asset.style["letterSpacing"]).toBe(5);
		expect(updates.asset.style).not.toHaveProperty("wordSpacing");
	});
});

describe("RichTextToolbar spacing controls (contrast)", () => {
	it("includes wordSpacing in spacing updates for rich-text", async () => {
		const mockEdit = createMockEdit();
		const { RichTextToolbar } = await import("../src/core/ui/rich-text-toolbar");
		const toolbar = new RichTextToolbar(mockEdit as never);
		const container = createTestContainer();

		const asset = { type: "rich-text", text: "Hello", font: { family: "Open Sans", size: 48 } };
		const clip = { asset, start: 0, length: 5 };
		mockEdit.getPlayerClip.mockReturnValue({ clipConfiguration: clip, getMergeFieldBinding: vi.fn(() => null) } as never);
		mockEdit.getResolvedClip.mockReturnValue(clip as never);
		toolbar.mount(container);

		const slider = container.querySelector("[data-letter-spacing-slider]") as HTMLInputElement;
		expect(slider).not.toBeNull();
		simulateInput(slider, 5);

		expect(mockEdit.updateClip).toHaveBeenCalled();
		const lastCall = mockEdit.updateClip.mock.calls.at(-1) as unknown[];
		const updates = lastCall[2] as { asset: { style: Record<string, unknown> } };
		expect(updates.asset.style).toHaveProperty("wordSpacing");

		toolbar.dispose();
		cleanupTestContainer(container);
	});
});
