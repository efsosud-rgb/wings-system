import { EventEmitter } from 'node:events';

/**
 * "Something about the ringing calls may have changed" (a call came in, was
 * picked up, declined or ended), inside this process. The ringing-call streams
 * listen and look again; the signal carries nothing about the call. All writers
 * of `wa_calls` live in the API, so one process needs no more than this; the
 * streams' own periodic look covers anything that slips by.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function notifyCallsChanged(): void {
  bus.emit('changed');
}

/** Returns the function that stops listening. */
export function onCallsChanged(listener: () => void): () => void {
  bus.on('changed', listener);
  return () => {
    bus.off('changed', listener);
  };
}
