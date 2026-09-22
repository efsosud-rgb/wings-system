import { convertThemeColors, convertThemeColorsGeneric } from "./theme-utils";
import { TimelineTheme, TimelineThemeOptions, DeepPartial, TimelineThemeInput } from "./theme.types";

// Default theme embedded directly in code.
// Wings: the palette of apps/web/src/index.css (black surfaces, #e95228 accent).
const DEFAULT_THEME_DATA: TimelineThemeInput = {
	timeline: {
		background: "#0a0a0a",
		divider: "#0a0a0a",
		toolbar: {
			background: "#0a0a0a",
			surface: "#121212",
			hover: "#262626",
			active: "#e95228",
			divider: "#262626",
			icon: "#a3a3a3",
			text: "#e5e5e5",
			height: 36
		},
		ruler: {
			background: "#121212",
			text: "#e5e5e5",
			markers: "#737373",
			height: 40
		},
		tracks: {
			surface: "#121212",
			surfaceAlt: "#0f0f0f",
			border: "#262626",
			height: 60
		},
		clips: {
			video: "#3b82f6",
			audio: "#34d399",
			image: "#f5a623",
			text: "#e95228",
			shape: "#a78bfa",
			html: "#2dd4bf",
			luma: "#a3e635",
			default: "#737373",
			selected: "#e95228",
			radius: 4
		},
		playhead: "#e95228",
		snapGuide: "#a3a3a3",
		dropZone: "#34d399",
		trackInsertion: "#34d399"
	}
};

// Default theme converted once at module load
const DEFAULT_THEME: TimelineTheme = convertThemeColors(DEFAULT_THEME_DATA);

export class TimelineThemeResolver {
	public static resolveTheme(options?: TimelineThemeOptions): TimelineTheme {
		if (!options || !options.theme) {
			return this.deepClone(DEFAULT_THEME);
		}

		// Convert hex colors to PIXI numbers
		const convertedTheme = convertThemeColorsGeneric(options.theme) as DeepPartial<TimelineTheme>;

		// Start with default theme and merge with provided theme
		const baseTheme = this.deepClone(DEFAULT_THEME);
		const resolvedTheme = this.deepMerge(baseTheme, convertedTheme);

		return resolvedTheme;
	}

	public static validateTheme(theme: TimelineTheme): boolean {
		try {
			// Basic structure validation
			if (!theme.timeline) return false;

			const { timeline } = theme;

			// Validate timeline root properties
			if (typeof timeline.background !== "number") return false;
			if (typeof timeline.divider !== "number") return false;
			if (typeof timeline.playhead !== "number") return false;
			if (typeof timeline.snapGuide !== "number") return false;
			if (typeof timeline.dropZone !== "number") return false;
			if (typeof timeline.trackInsertion !== "number") return false;

			// Validate toolbar
			if (!timeline.toolbar) return false;
			const { toolbar } = timeline;
			if (typeof toolbar.background !== "number") return false;
			if (typeof toolbar.surface !== "number") return false;
			if (typeof toolbar.hover !== "number") return false;
			if (typeof toolbar.active !== "number") return false;
			if (typeof toolbar.divider !== "number") return false;
			if (typeof toolbar.icon !== "number") return false;
			if (typeof toolbar.text !== "number") return false;
			if (typeof toolbar.height !== "number" || toolbar.height <= 0) return false;

			// Validate ruler
			if (!timeline.ruler) return false;
			const { ruler } = timeline;
			if (typeof ruler.background !== "number") return false;
			if (typeof ruler.text !== "number") return false;
			if (typeof ruler.markers !== "number") return false;
			if (typeof ruler.height !== "number" || ruler.height <= 0) return false;

			// Validate tracks
			if (!timeline.tracks) return false;
			const { tracks } = timeline;
			if (typeof tracks.surface !== "number") return false;
			if (typeof tracks.surfaceAlt !== "number") return false;
			if (typeof tracks.border !== "number") return false;
			if (typeof tracks.height !== "number" || tracks.height <= 0) return false;

			// Validate clips
			if (!timeline.clips) return false;
			const { clips } = timeline;
			const clipColors = ["video", "audio", "image", "text", "shape", "html", "luma", "default", "selected"];
			for (const color of clipColors) {
				if (typeof clips[color as keyof typeof clips] !== "number") return false;
			}
			if (typeof clips.radius !== "number" || clips.radius < 0) return false;

			return true;
		} catch (error) {
			console.error("Theme validation error:", error);
			return false;
		}
	}

	private static deepClone<T>(obj: T): T {
		if (obj === null || typeof obj !== "object") {
			return obj;
		}

		if (obj instanceof Array) {
			return obj.map(item => this.deepClone(item)) as unknown as T;
		}

		const cloned = {} as T;
		for (const key in obj) {
			if (Object.prototype.hasOwnProperty.call(obj, key)) {
				cloned[key] = this.deepClone(obj[key]);
			}
		}

		return cloned;
	}

	private static deepMerge<T>(target: T, source: DeepPartial<T>): T {
		const result = { ...target };

		for (const key in source) {
			if (Object.prototype.hasOwnProperty.call(source, key)) {
				const sourceValue = source[key];
				const targetValue = result[key];

				if (sourceValue !== undefined) {
					if (
						typeof sourceValue === "object" &&
						sourceValue !== null &&
						!Array.isArray(sourceValue) &&
						typeof targetValue === "object" &&
						targetValue !== null &&
						!Array.isArray(targetValue)
					) {
						result[key] = this.deepMerge(targetValue, sourceValue);
					} else {
						result[key] = sourceValue as T[Extract<keyof T, string>];
					}
				}
			}
		}

		return result;
	}
}
