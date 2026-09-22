/**
 * @jest-environment jsdom
 */
/* eslint-disable import/first */
/* eslint-disable max-classes-per-file -- the two stub classes are vi.mock factories, not real types */

vi.mock("pixi.js", () => ({}));
vi.mock("../src/components/canvas/players/player", () => ({
	Player: class MockPlayer {},
	PlayerType: {}
}));
vi.mock("../src/core/edit-session", () => ({}));
vi.mock("../src/core/shotstack-edit", () => ({
	ShotstackEdit: class MockShotstackEdit {}
}));
vi.mock("@styles/inject", () => ({
	injectShotstackStyles: vi.fn()
}));

import type { Edit } from "@core/edit-session";
import { RichTextToolbar } from "@core/ui/rich-text-toolbar";

function createMockEdit(asset: Record<string, unknown>) {
	const clip = { id: "clip-1", start: 0, length: 5, asset };
	return {
		getClipId: vi.fn().mockReturnValue("clip-1"),
		getClip: vi.fn().mockReturnValue(clip),
		getPlayerClip: vi.fn().mockReturnValue(null),
		getResolvedClip: vi.fn().mockReturnValue(clip),
		getDocumentClip: vi.fn().mockReturnValue(clip),
		getDocument: vi.fn(() => ({
			getFonts: vi.fn(() => []),
			getClipBinding: vi.fn(() => null)
		})),
		updateClip: vi.fn(),
		deleteClip: vi.fn(),
		canDeleteClip: vi.fn(() => true),
		getInternalEvents: vi.fn(() => ({ on: vi.fn(), off: vi.fn() })),
		events: { on: vi.fn(), off: vi.fn() },
		getEdit: vi.fn(() => ({ timeline: { fonts: [], tracks: [] } })),
		getFontMetadata: vi.fn(() => new Map()),
		mergeFields: { getAll: vi.fn(() => []) }
	};
}

describe("RichTextToolbar text transform", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("writes textTransform on asset.style for rich-text clips", () => {
		const edit = createMockEdit({
			type: "rich-text",
			text: "Hello",
			font: { family: "Open Sans", size: 48, color: "#ffffff" },
			style: { letterSpacing: 0, lineHeight: 1.2, textTransform: "none", textDecoration: "none" }
		});
		const container = document.createElement("div");
		document.body.appendChild(container);
		const toolbar = new RichTextToolbar(edit as unknown as Edit);
		toolbar.mount(container);
		toolbar.show(0, 0);

		const btn = container.querySelector('[data-action="transform"]') as HTMLButtonElement;
		btn.click();

		expect(edit.updateClip).toHaveBeenCalledWith(
			0,
			0,
			expect.objectContaining({
				asset: expect.objectContaining({
					style: expect.objectContaining({ textTransform: "uppercase" })
				})
			})
		);

		toolbar.dispose();
	});

	it("does not write style onto text assets (Zod rejects unrecognized style)", () => {
		const edit = createMockEdit({
			type: "text",
			text: "Hello",
			font: { family: "Open Sans", size: 48, color: "#ffffff" }
		});
		const container = document.createElement("div");
		document.body.appendChild(container);
		const toolbar = new RichTextToolbar(edit as unknown as Edit);
		toolbar.mount(container);
		toolbar.show(0, 0);

		const btn = container.querySelector('[data-action="transform"]') as HTMLButtonElement;
		btn.click();

		expect(edit.updateClip).not.toHaveBeenCalled();

		toolbar.dispose();
	});
});
