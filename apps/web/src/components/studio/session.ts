import type {
  DriveFile,
  DriveFolder,
  MediaAsset,
  StudioAspect,
  StudioPosition,
  StudioRender,
  StudioTransition,
  StudioTranscription,
} from '@wings/shared';
import type { ReactNode, RefObject } from 'react';

/**
 * The contract between the editor's brain (`useStudioSession`) and its face
 * (`workspace/`). The session owns the core (packages/studio), the Drive rule
 * (a project never carries an address) and every action that saves, exports
 * or spends; the workspace only renders state and calls these methods. Panels
 * never touch the core directly, so the rule has one door.
 */

export type StudioStatus = 'loading' | 'ready' | 'failed';

/**
 * What the person is making. Image mode hides the timeline behind a layers
 * panel and exports a still; adding a video or an audio file switches to
 * video mode by itself, and the person can switch back when nothing plays.
 */
export type StudioMode = 'video' | 'image';

export type StudioFileKind = 'video' | 'image' | 'audio' | 'subtitle' | 'project';

/** A Drive file on the canvas and the hour-long link it plays through. */
export interface StudioAsset {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  kind: StudioFileKind;
}

/** The selected clip, read from the core in the units the panel shows. */
export interface SelectedClip {
  clipId: string;
  trackIndex: number;
  clipIndex: number;
  /** `video` · `image` · `audio` · `rich-text` · `text` · `svg` · `caption` · `rich-caption`. */
  assetType: string;
  /** Drive file name for media clips; null for text and shapes. */
  assetName: string | null;
  start: number;
  length: number;
  opacity: number;
  position: StudioPosition;
  offset: { x: number; y: number };
  scale: number;
  transition: { in: StudioTransition; out: StudioTransition };
  /** Video and audio only. */
  volume: number | null;
  /** Text clips only. */
  text: {
    text: string;
    fontFamily: string;
    size: number;
    weight: number;
    color: string;
    horizontal: 'left' | 'center' | 'right';
    vertical: 'top' | 'middle' | 'bottom';
  } | null;
  /** Shapes only: the fill colour. */
  fill: string | null;
}

/** What the properties panel may change. Every field optional; each one is one undoable command. */
export interface ClipPatch {
  start?: number;
  length?: number;
  opacity?: number;
  position?: StudioPosition;
  offset?: { x: number; y: number };
  scale?: number;
  transition?: { in?: StudioTransition; out?: StudioTransition };
  volume?: number;
  text?: Partial<NonNullable<SelectedClip['text']>>;
  fill?: string;
}

/** One row of the layers panel (image mode) — top of the list is on top of the canvas. */
export interface StudioLayer {
  clipId: string;
  trackIndex: number;
  clipIndex: number;
  assetType: string;
  label: string;
  selected: boolean;
}

export interface StudioNotice {
  kind: 'info' | 'error' | 'success';
  text: ReactNode;
}

export interface SaveChoice {
  folder: DriveFolder;
  name: string;
  replaceFileId?: string;
}

export type ShapeKind = 'rect' | 'circle' | 'line';
export type TextPreset = 'title' | 'subtitle' | 'body';

/**
 * What the rail panels put on a drag: the stage and the timeline read it
 * back and call `addDriveFile` / `addMediaAsset`. One MIME, one JSON shape.
 */
export const STUDIO_DRAG_MIME = 'application/x-wings-studio-item';
export type StudioDragItem =
  | { kind: 'drive-file'; file: DriveFile; folder: DriveFolder | null }
  | { kind: 'media-asset'; asset: MediaAsset };

export interface StudioSession {
  status: StudioStatus;
  /** Why the editor did not open, in a sentence a person can act on. */
  failure: string | null;
  /** The core mounts its canvas and its timeline into these. */
  stageRef: RefObject<HTMLDivElement | null>;
  timelineRef: RefObject<HTMLDivElement | null>;

  mode: StudioMode;
  /** Refused (returns false) when video or audio is on the timeline. */
  setMode(mode: StudioMode): boolean;
  aspect: StudioAspect;
  setAspect(aspect: StudioAspect): Promise<void>;
  projectName: string;
  setProjectName(name: string): void;
  /** "Para quem". Null means Wings itself. */
  clientId: string | null;
  setClientId(clientId: string | null): void;
  /** The Drive file this project was opened from or saved to, if any. */
  projectFile: { id: string; folderId: string } | null;
  lastFolder: DriveFolder | null;
  /** Something changed since the last save. */
  dirty: boolean;

  canUndo: boolean;
  canRedo: boolean;
  undo(): Promise<void>;
  redo(): Promise<void>;

  playing: boolean;
  /** Seconds. Updated a few times a second while playing. */
  playbackTime: number;
  totalDuration: number;
  play(): void;
  pause(): void;
  seek(seconds: number): void;

  /** Canvas zoom, 1 = output pixels. */
  zoom: number;
  setZoom(zoom: number): void;
  zoomToFit(): void;

  selected: SelectedClip | null;
  layers: StudioLayer[];
  selectClip(clipId: string): void;
  clearSelection(): void;
  updateSelected(patch: ClipPatch): Promise<void>;
  deleteSelected(): Promise<void>;
  /** Layers panel: move the selected clip one track up or down (z-order). */
  moveSelected(direction: 'up' | 'down'): Promise<void>;

  /** Files on the canvas, for the "neste projeto" list and for the AI panel. */
  assets: StudioAsset[];
  /** Adds a Drive file at the playhead (or `at`), on a new track above the rest. A project file opens instead. */
  addDriveFile(
    file: DriveFile,
    folder: DriveFolder | null,
    options?: { at?: number; trackIndex?: number },
  ): Promise<void>;
  /** A library asset is a Drive file under the hood; same as `addDriveFile`. */
  addMediaAsset(asset: MediaAsset, options?: { at?: number; trackIndex?: number }): Promise<void>;
  openProject(file: DriveFile, folder: DriveFolder): Promise<void>;
  /** Clears the timeline. Refused when dirty unless `force`. Returns whether it happened. */
  newProject(options: { mode: StudioMode; aspect?: StudioAspect; force?: boolean }): boolean;

  addText(preset?: TextPreset): Promise<void>;
  addShape(kind: ShapeKind, color?: string): Promise<void>;
  /** A logo is an image clip that keeps its ratio, top-right by default. */
  addLogo(file: DriveFile, folder: DriveFolder | null): Promise<void>;
  /** Image mode: the base image fills the new format (`fit: cover`), everything else keeps its place. */
  cropToAspect(aspect: StudioAspect): Promise<void>;

  saveProject(choice: SaveChoice): Promise<void>;
  exportVideo(choice: SaveChoice, where: 'browser' | 'server'): Promise<void>;
  /** Image mode: one frame at output size, PNG or JPG, to the Drive. */
  exportImage(choice: SaveChoice & { format: 'png' | 'jpeg'; quality?: number }): Promise<void>;
  /** WebCodecs present, and the timeline short enough for the browser. */
  browserExport: { available: boolean; reason: string | null };

  /** "Legendar": queue Whisper on a video or audio file of this project; the SRT lands in the Drive. */
  requestCaptions(assetId: string, language?: string): Promise<void>;
  transcription: StudioTranscription | null;
  /** Once the SRT is filed, put it on the timeline as a caption clip. */
  addCaptionsFromTranscription(): Promise<void>;
  dismissTranscription(): void;

  render: StudioRender | null;
  dismissRender(): void;

  /** The selected image clip, if it came from the media library, for "Gerar variação" / "Editar com IA". */
  selectedImageForAi: { driveFileId: string; mediaAssetId: string | null; name: string } | null;

  busy: string | null;
  progress: { done: number; message: string } | null;
  /** Cancels a browser export in flight. */
  cancel(): void;
  notice: StudioNotice | null;
  setNotice(notice: StudioNotice | null): void;
}
