import type { EditConfig } from "@schemas";

import { type CommandResult, CommandSuccess, type EditCommand } from "./types";

/**
 * Wings: swaps the whole document for another as ONE undoable step, so a list
 * of changes made outside the editor (the editing agent's proposal) is taken
 * back by one "Desfazer". Undo loads the document as it was, clip ids
 * included; redo loads the new one again.
 */
export class ReplaceEditCommand implements EditCommand {
	readonly name = "replaceEdit";

	constructor(
		private readonly previous: EditConfig,
		private readonly next: EditConfig,
		private readonly load: (edit: EditConfig) => Promise<void>
	) {}

	async execute(): Promise<CommandResult> {
		await this.load(structuredClone(this.next));
		return CommandSuccess();
	}

	async undo(): Promise<CommandResult> {
		await this.load(structuredClone(this.previous));
		return CommandSuccess();
	}
}
