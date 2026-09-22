/**
 * @jest-environment jsdom
 */
/* eslint-disable import/first -- toolbar imports must follow the Pixi and edit-session mocks in this jsdom test. */

import type { Edit } from "@core/edit-session";
import type { ResolvedClip } from "@schemas";

if (typeof structuredClone === "undefined") {
	global.structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
}
if (typeof CSS === "undefined") {
	Object.defineProperty(global, "CSS", { value: { escape: (value: string) => value } });
}

vi.mock("pixi.js", () => ({}));
vi.mock("../src/components/canvas/players/player", () => ({ Player: class MockPlayer {}, PlayerType: {} }));
vi.mock("../src/core/edit-session", () => ({}));
vi.mock("@styles/inject", () => ({ injectShotstackStyles: vi.fn() }));

import { TextToSpeechToolbar } from "@core/ui/text-to-speech-toolbar";

function createMockEdit(clip: ResolvedClip) {
	return {
		getClipId: vi.fn(() => "clip-tts-1"),
		getResolvedClip: vi.fn(() => clip),
		updateClip: vi.fn(),
		updateClipInDocument: vi.fn(),
		resolveClip: vi.fn(),
		commitClipUpdate: vi.fn(),
		deleteClip: vi.fn(),
		canDeleteClip: vi.fn(() => true),
		events: { on: vi.fn(), off: vi.fn() }
	};
}

describe("TextToSpeechToolbar", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("keeps keyframed volume read-only", () => {
		const clip = {
			id: "clip-tts-1",
			asset: {
				type: "text-to-speech",
				text: "Hello",
				voice: "Matthew",
				volume: [{ from: 0, to: 1, start: 0, length: 1, interpolation: "linear" }]
			},
			start: 0,
			length: 5
		} as unknown as ResolvedClip;
		const edit = createMockEdit(clip);
		const toolbar = new TextToSpeechToolbar(edit as unknown as Edit);
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		toolbar.mount(parent);
		toolbar.show(0, 0);

		const button = parent.querySelector<HTMLButtonElement>('[data-action="volume"]')!;
		const range = parent.querySelector<HTMLInputElement>("[data-volume-slider]")!;
		const value = parent.querySelector<HTMLInputElement>("[data-volume-display]")!;
		expect(button.disabled).toBe(true);
		expect(button.title).toBe("Keyframed values cannot be edited with this control");
		expect(range.disabled).toBe(true);
		expect(value.disabled).toBe(true);

		range.value = "50";
		range.dispatchEvent(new Event("input", { bubbles: true }));

		expect(edit.updateClip).not.toHaveBeenCalled();
		expect(edit.updateClipInDocument).not.toHaveBeenCalled();
		toolbar.dispose();
	});
});
