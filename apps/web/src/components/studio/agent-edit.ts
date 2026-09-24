import {
  STUDIO_POSITIONS,
  STUDIO_TIMELINE_MAX_CLIPS,
  STUDIO_TIMELINE_MAX_FILES,
  STUDIO_TIMED_MEDIA_TYPES,
  STUDIO_TEXT_TYPES,
  type StudioAspect,
  type StudioPosition,
  type StudioTimelineClip,
  type StudioTimelineFile,
  type StudioTimelineOp,
  type StudioTimelineSnapshot,
} from '@wings/shared';
import { clipFor, textClip, updatesFor, type DocClip, type EditDoc } from './clips.js';
import type { ClipPatch, StudioAsset, StudioFileKind } from './session.js';

/**
 * The editing agent's side of the timeline (Studio parte 3 a).
 *
 * `timelineSnapshot` is what goes to the agent with a message: ids, types,
 * times and Drive file ids, never a link. `applyTimelineOps` turns a card's
 * operations into the next document, which the session hands to the core's
 * `replaceEdit` as one undoable step. Both are pure: the core is not touched
 * here.
 */

/** Where a clip sits in time, resolved: `auto` and `end` already in seconds. */
export type TimingOf = (clipId: string) => { start: number; length: number } | null;

const round = (value: number) => Math.round(value * 100) / 100;
const numberOr = <T>(value: unknown, fallback: T): number | T =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isTimedMedia = (type: string) =>
  (STUDIO_TIMED_MEDIA_TYPES as readonly string[]).includes(type);
const isText = (type: string) => (STUDIO_TEXT_TYPES as readonly string[]).includes(type);

const AGENT_FILE_KINDS = new Set<StudioFileKind>(['video', 'audio', 'image', 'subtitle']);

/** The clips of a document as the agent sees them, top track first. */
export function snapshotClips(
  doc: EditDoc,
  timing: TimingOf,
  assetOf: (src: unknown) => StudioAsset | null,
): StudioTimelineClip[] {
  const clips: StudioTimelineClip[] = [];
  (doc.timeline?.tracks ?? []).forEach((track, trackIndex) => {
    for (const clip of track.clips ?? []) {
      if (typeof clip.id !== 'string' || clips.length >= STUDIO_TIMELINE_MAX_CLIPS) continue;
      const type = clip.asset?.type ?? 'unknown';
      const resolved = timing(clip.id);
      const file = type === 'svg' ? null : assetOf(clip.asset?.src);
      const position = STUDIO_POSITIONS.includes(clip.position as StudioPosition)
        ? (clip.position as StudioPosition)
        : null;
      const text = isText(type) && typeof clip.asset?.text === 'string' ? clip.asset.text : null;
      clips.push({
        id: clip.id.slice(0, 64),
        track: Math.min(trackIndex, 99),
        type: type.slice(0, 40),
        fileId: file?.id ?? null,
        name: file?.name.slice(0, 200) ?? null,
        start: round(numberOr(clip.start, resolved?.start ?? 0)),
        length: round(numberOr(clip.length, resolved?.length ?? 0)),
        trim: isTimedMedia(type) ? round(numberOr(clip.asset?.trim, 0)) : null,
        text: text?.slice(0, 2000) ?? null,
        position,
        opacity: clip.opacity === undefined ? 1 : clamp(numberOr(clip.opacity, 1), 0, 1),
        volume: isTimedMedia(type) ? clamp(numberOr(clip.asset?.volume, 1), 0, 1) : null,
      });
    }
  });
  return clips;
}

export function timelineSnapshot(input: {
  doc: EditDoc;
  timing: TimingOf;
  assets: StudioAsset[];
  aspect: StudioAspect;
  mode: 'image' | 'video';
  durationSeconds: number;
  playheadSeconds: number;
  selectedClipId: string | null;
}): StudioTimelineSnapshot {
  const byUrl = new Map(input.assets.map((asset) => [asset.url, asset]));
  const files: StudioTimelineFile[] = input.assets
    .filter((asset) => AGENT_FILE_KINDS.has(asset.kind))
    .slice(0, STUDIO_TIMELINE_MAX_FILES)
    .map((asset) => ({
      fileId: asset.id,
      name: asset.name.slice(0, 200),
      mimeType: asset.mimeType.slice(0, 120),
      kind: asset.kind as StudioTimelineFile['kind'],
    }));
  return {
    aspect: input.aspect,
    mode: input.mode,
    durationSeconds: round(clamp(input.durationSeconds, 0, 36_000)),
    playheadSeconds: round(clamp(input.playheadSeconds, 0, 36_000)),
    selectedClipId: input.selectedClipId?.slice(0, 64) ?? null,
    clips: snapshotClips(input.doc, input.timing, (src) =>
      typeof src === 'string' ? (byUrl.get(src) ?? null) : null,
    ),
    files,
  };
}

/** A file an `add_file` places, with the link it plays from and its measured length. */
export interface PlacedFile {
  url: string;
  kind: StudioFileKind;
  durationSeconds: number | null;
}

/**
 * The next document after the operations, in order. The operations were
 * checked by the server against the timeline sent with the message and are
 * checked again against the timeline now (`checkTimelineOps`) before this
 * runs; here a clip that cannot be found is an error, never skipped.
 */
export function applyTimelineOps(
  doc: EditDoc,
  ops: StudioTimelineOp[],
  context: {
    timing: TimingOf;
    output: { width: number; height: number };
    placed: Record<string, PlacedFile>;
  },
): EditDoc {
  const next = structuredClone(doc);
  next.timeline = next.timeline ?? {};
  const tracks = (next.timeline.tracks = next.timeline.tracks ?? []);

  const find = (clipId: string) => {
    for (const track of tracks) {
      const clips = track.clips ?? [];
      const index = clips.findIndex((clip) => clip.id === clipId);
      if (index !== -1) return { clips, index, clip: clips[index] as DocClip };
    }
    throw new Error(`clip ${clipId} is not on the timeline`);
  };
  /** `auto` and `end` become seconds before anything is measured against them. */
  const timed = (clip: DocClip) => {
    const resolved = typeof clip.id === 'string' ? context.timing(clip.id) : null;
    clip.start = numberOr(clip.start, resolved?.start ?? 0);
    clip.length = numberOr(clip.length, resolved?.length ?? 0);
    return { start: clip.start as number, length: clip.length as number };
  };

  for (const op of ops) {
    switch (op.op) {
      case 'remove': {
        const { clips, index } = find(op.clipId);
        clips.splice(index, 1);
        break;
      }
      case 'set_timing': {
        const { clip } = find(op.clipId);
        timed(clip);
        if (op.start !== undefined) clip.start = round(op.start);
        if (op.length !== undefined) clip.length = round(op.length);
        if (op.trim !== undefined && clip.asset) clip.asset.trim = round(op.trim);
        break;
      }
      case 'split': {
        const { clips, index, clip } = find(op.clipId);
        const { start, length } = timed(clip);
        const offset = round(op.at - start);
        const second = structuredClone(clip);
        delete second.id;
        clip.length = offset;
        second.start = round(op.at);
        second.length = round(length - offset);
        if (second.asset && isTimedMedia(String(second.asset.type))) {
          second.asset.trim = round(numberOr(clip.asset?.trim, 0) + offset);
        }
        // The cut is a straight cut: the entrance stays with the first half, the exit with the second.
        const transition = clip.transition as { in?: string; out?: string } | undefined;
        if (transition) {
          clip.transition = transition.in ? { in: transition.in } : undefined;
          second.transition = transition.out ? { out: transition.out } : undefined;
          if (!clip.transition) delete clip.transition;
          if (!second.transition) delete second.transition;
        }
        clips.splice(index + 1, 0, second);
        break;
      }
      case 'style': {
        const { clip } = find(op.clipId);
        const patch: ClipPatch = {};
        if (op.position) patch.position = op.position;
        if (op.opacity !== undefined) patch.opacity = op.opacity;
        if (op.scale !== undefined) patch.scale = op.scale;
        if (op.volume !== undefined) patch.volume = op.volume;
        if (op.transitionIn || op.transitionOut) {
          patch.transition = {
            ...(op.transitionIn ? { in: op.transitionIn } : {}),
            ...(op.transitionOut ? { out: op.transitionOut } : {}),
          };
        }
        if (op.text) {
          patch.text = {
            ...(op.text.content !== undefined ? { text: op.text.content } : {}),
            ...(op.text.fontFamily !== undefined ? { fontFamily: op.text.fontFamily } : {}),
            ...(op.text.size !== undefined ? { size: op.text.size } : {}),
            ...(op.text.color !== undefined ? { color: op.text.color } : {}),
          };
        }
        if (op.caption) patch.caption = op.caption;
        Object.assign(clip, updatesFor(patch, clip, context.output));
        break;
      }
      case 'add_text': {
        const clip = textClip(op.preset, round(op.start), round(op.length)) as unknown as DocClip;
        if (clip.asset) clip.asset.text = op.text;
        if (op.position) clip.position = op.position;
        tracks.unshift({ clips: [clip] });
        break;
      }
      case 'add_file': {
        const placed = op.fileId ? context.placed[op.fileId] : undefined;
        if (!placed) throw new Error('file to place was not resolved');
        const clip = clipFor(placed.kind, placed.url, round(op.start), {
          durationSeconds: placed.durationSeconds,
          output: context.output,
        }) as unknown as DocClip;
        if (placed.kind === 'image' && op.length !== undefined) clip.length = round(op.length);
        tracks.unshift({ clips: [clip] });
        break;
      }
    }
  }
  return next;
}
