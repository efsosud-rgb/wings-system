import pkg from "../package.json";

export { Edit } from "@core/edit-session";
export { Canvas } from "@canvas/shotstack-canvas";
export { Controls } from "@core/inputs/controls";
export { VideoExporter } from "@core/export";
export { Timeline } from "@timeline/index";
export { UIController } from "@core/ui/ui-controller";
export { WebGLUnsupportedError } from "@core/webgl-support";
export { ExportError, BrowserCompatibilityError } from "@core/export/export-utils";

// Wings additions
export { configureStudio, studioConfig, type StudioConfig } from "./wings";
export type { RenderOptions } from "@core/export/export-coordinator";

export type { UIControllerOptions, ToolbarButtonConfig } from "@core/ui/ui-controller";
export type { AssetGenerationRequest, AssetGeneratorHandler, AssetGeneratorOptions } from "@core/generation/asset-generator";
export type { EditConfig } from "@core/schemas";
export type { CommandResult } from "@core/commands/types";
export type { TimelineOptions } from "@timeline/timeline";

export const VERSION = pkg.version;
/** The Shotstack Studio SDK version this package was forked from (see NOTICE.md). */
export const UPSTREAM_VERSION = "2.19.6";
