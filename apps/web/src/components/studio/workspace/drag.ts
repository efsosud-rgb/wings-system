import type { DragEvent } from 'react';
import { STUDIO_DRAG_MIME, type StudioDragItem } from '../session.js';

/** Puts one item on a drag, and reads it back on the drop. One MIME, one JSON shape. */
export function setDragItem(event: DragEvent, item: StudioDragItem): void {
  event.dataTransfer.setData(STUDIO_DRAG_MIME, JSON.stringify(item));
  event.dataTransfer.effectAllowed = 'copy';
}

export function readDragItem(event: DragEvent): StudioDragItem | null {
  try {
    const raw = event.dataTransfer.getData(STUDIO_DRAG_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StudioDragItem;
    if (parsed.kind === 'drive-file' && parsed.file?.id) return parsed;
    if (parsed.kind === 'media-asset' && parsed.asset?.id) return parsed;
    return null;
  } catch {
    return null;
  }
}

export const hasDragItem = (event: DragEvent) =>
  Array.from(event.dataTransfer.types).includes(STUDIO_DRAG_MIME);

/** `MediaAsset.driveFileId` arrives with the API of this wave; older answers have none. */
export function driveFileIdOf(asset: { driveFileId?: string | null }): string | null {
  return typeof asset.driveFileId === 'string' ? asset.driveFileId : null;
}
