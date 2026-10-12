import {
  VIDEO_UPLOAD_PART_BYTES,
  type CreativeUpload,
  type VideoUpload,
  type VideoUploadSession,
} from '@wings/shared';
import { useCallback, useRef, useState } from 'react';
import { ApiError, api, noteUnauthorized, type ApiErrorBody } from './client.js';

/**
 * Files for the campaign builder: an image in one request, a video in parts.
 *
 * `fetch` still cannot say how much of a body has gone, so the bytes travel by
 * XMLHttpRequest and the bar on screen follows `upload.onprogress`. A video is
 * cut into parts of `VIDEO_UPLOAD_PART_BYTES`: one short request each, so no
 * single request outlives a proxy's read timeout, and a lost part is sent
 * again instead of the whole file.
 */

function sendBytes<T>(input: {
  method: 'POST' | 'PUT';
  path: string;
  body: Blob;
  contentType: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(input.method, `/api${input.path}`);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', input.contentType);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) input.onProgress?.(event.loaded / event.total);
    };
    request.onload = () => {
      let body: unknown;
      try {
        body = request.responseText ? JSON.parse(request.responseText) : {};
      } catch {
        body = {};
      }
      if (request.status >= 200 && request.status < 300) resolve(body as T);
      else {
        noteUnauthorized(request.status, input.path);
        reject(new ApiError(request.status, body as ApiErrorBody));
      }
    };
    request.onerror = () =>
      reject(new UploadInterrupted('A conexão caiu durante o envio. Tente de novo.'));
    request.onabort = () => reject(new UploadInterrupted('Envio cancelado.'));
    input.signal?.addEventListener('abort', () => request.abort());
    request.send(input.body);
  });
}

export class UploadInterrupted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadInterrupted';
  }
}

/** One image, straight to our database. */
export async function sendCreativeImage(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<CreativeUpload> {
  const { creative } = await sendBytes<{ creative: CreativeUpload }>({
    method: 'POST',
    path: '/ads/creatives',
    body: file,
    contentType: file.type || 'application/octet-stream',
    onProgress,
    signal,
  });
  return creative;
}

/** How many times a part is sent again after the connection drops. */
const PART_RETRIES = 2;

/**
 * One video, in parts: open a session, send parts 1..n in order (each retried
 * on a dropped connection), then ask the server to check and keep the file.
 * The video exists only after that last step answers.
 */
export async function sendCreativeVideo(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<VideoUpload> {
  const { upload } = await api.post<{ upload: VideoUploadSession }>('/ads/videos/uploads', {
    mimeType: file.type,
    byteSize: file.size,
  });
  const partSize = upload.partSize || VIDEO_UPLOAD_PART_BYTES;

  try {
    for (let part = upload.nextPart; part <= upload.parts; part += 1) {
      const start = (part - 1) * partSize;
      const chunk = file.slice(start, Math.min(start + partSize, file.size));
      let attempt = 0;
      for (;;) {
        try {
          await sendBytes<{ upload: VideoUploadSession }>({
            method: 'PUT',
            path: `/ads/videos/uploads/${upload.id}/parts/${part}`,
            body: chunk,
            contentType: 'application/octet-stream',
            onProgress: (fraction) => onProgress?.((start + fraction * chunk.size) / file.size),
            signal,
          });
          break;
        } catch (error) {
          const dropped =
            error instanceof UploadInterrupted && error.message !== 'Envio cancelado.';
          if (!dropped || attempt >= PART_RETRIES) throw error;
          attempt += 1;
        }
      }
    }
    onProgress?.(1);
    const { video } = await api.post<{ video: VideoUpload }>(
      `/ads/videos/uploads/${upload.id}/complete`,
    );
    return video;
  } catch (error) {
    // Nothing half-sent stays behind; the failure itself is what the caller sees.
    await api.delete(`/ads/videos/uploads/${upload.id}`).catch(() => undefined);
    throw error;
  }
}

export interface FileUploadState<T> {
  /** Starts sending; the callbacks fire once, like a mutation's. */
  mutate: (
    file: File,
    callbacks: { onSuccess: (result: T) => void; onError: (error: Error) => void },
  ) => void;
  isPending: boolean;
  /** 0 to 1 while sending. */
  progress: number;
  cancel: () => void;
}

/** A sender as a hook: pending flag, progress and a cancel, for one control. */
export function useFileUpload<T>(
  send: (file: File, onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<T>,
): FileUploadState<T> {
  const [isPending, setPending] = useState(false);
  const [progress, setProgress] = useState(0);
  const controller = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controller.current?.abort();
  }, []);

  const mutate = useCallback<FileUploadState<T>['mutate']>(
    (file, callbacks) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setPending(true);
      setProgress(0);
      send(file, setProgress, current.signal)
        .then((result) => {
          if (controller.current === current) callbacks.onSuccess(result);
        })
        .catch((error: unknown) => {
          if (controller.current !== current) return;
          callbacks.onError(error instanceof Error ? error : new Error('Falha no envio.'));
        })
        .finally(() => {
          if (controller.current === current) {
            controller.current = null;
            setPending(false);
          }
        });
    },
    [send],
  );

  return { mutate, isPending, progress, cancel };
}
