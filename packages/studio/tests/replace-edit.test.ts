/**
 * Wings: replaceEdit swaps the whole edit as one undoable step.
 */

import { Edit } from "@core/edit-session";
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
			setPreferences: vi.fn(),
			cache: { has: vi.fn(() => false) },
			unload: vi.fn()
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
 * Wings: the editing agent's proposals are applied by swapping the whole edit.
 * That swap must be ONE step of the history (one "Desfazer" takes it back),
 * keep clip ids, and refuse to touch the output, which loadEdit would change
 * through commands of its own.
 */
const SIZE = { width: 1080, height: 1920 };

function image(start: number, length: number, name: string) {
	return { asset: { type: "image", src: `https://example.com/${name}.png` }, start, length };
}

function editWith(clips: ReturnType<typeof image>[], size = SIZE): EditConfig {
	return {
		timeline: { background: "#000000", tracks: [{ clips }] },
		output: { format: "mp4", fps: 30, size }
	} as unknown as EditConfig;
}

const srcs = (edit: Edit) => edit.getEdit().timeline.tracks.flatMap(track => track.clips.map(clip => (clip.asset as { src: string }).src));

describe("replaceEdit", () => {
	it("is one step of the history, undone and redone as a whole, keeping clip ids", async () => {
		const edit = new Edit(editWith([image(0, 3, "a")]));
		await edit.load();
		const before = edit.getEdit({ includeIds: true });
		const idBefore = before.timeline.tracks[0].clips[0].id;
		expect(edit.canUndo).toBe(false);

		const next = structuredClone(before);
		next.timeline.tracks[0].clips[0].length = 2;
		next.timeline.tracks[0].clips.push(image(2, 4, "b") as never);
		next.timeline.tracks.unshift({ clips: [image(0, 1, "c") as never] });
		const result = await edit.replaceEdit(next);

		expect(result.status).toBe("success");
		expect(srcs(edit)).toEqual(["https://example.com/c.png", "https://example.com/a.png", "https://example.com/b.png"]);
		expect(edit.getEdit({ includeIds: true }).timeline.tracks[1].clips[0].id).toBe(idBefore);
		expect(edit.canUndo).toBe(true);

		await edit.undo();
		expect(srcs(edit)).toEqual(["https://example.com/a.png"]);
		expect(edit.getEdit({ includeIds: true }).timeline.tracks[0].clips[0]).toMatchObject({ id: idBefore, length: 3 });
		expect(edit.canUndo).toBe(false);

		await edit.redo();
		expect(srcs(edit)).toHaveLength(3);
	});

	it("drops tracks left empty, on the new side and on the side undo goes back to", async () => {
		const edit = new Edit(editWith([image(0, 3, "a")]));
		await edit.load();
		const withEmpty = edit.getEdit({ includeIds: true });
		withEmpty.timeline.tracks.push({ clips: [] } as never);
		withEmpty.timeline.tracks[0].clips.push(image(3, 2, "b") as never);
		expect((await edit.replaceEdit(withEmpty)).status).toBe("success");
		expect(edit.getEdit().timeline.tracks).toHaveLength(1);
		await edit.undo();
		expect(srcs(edit)).toEqual(["https://example.com/a.png"]);
	});

	it("refuses to change the output or the background, and leaves the history alone", async () => {
		const edit = new Edit(editWith([image(0, 3, "a")]));
		await edit.load();
		const resized = await edit.replaceEdit(editWith([image(0, 3, "b")], { width: 1920, height: 1080 }));
		expect(resized.status).toBe("noop");
		const recolored = editWith([image(0, 3, "b")]);
		recolored.timeline.background = "#ffffff";
		expect((await edit.replaceEdit(recolored)).status).toBe("noop");
		expect(srcs(edit)).toEqual(["https://example.com/a.png"]);
		expect(edit.canUndo).toBe(false);
	});
});
