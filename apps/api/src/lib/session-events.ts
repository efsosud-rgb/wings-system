import { EventEmitter } from 'node:events';

/**
 * Who learns that sessions ended on purpose (a logout, a deactivation, a changed
 * role), inside this process. A long-lived reply (the ringing-call stream) listens,
 * so it closes at once instead of at its next check. Carries ids only, never a token.
 */
export type SessionsEnded = { sessionId: string } | { employeeId: string };

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitSessionsEnded(ended: SessionsEnded): void {
  bus.emit('ended', ended);
}

/** Returns the function that stops listening. */
export function onSessionsEnded(listener: (ended: SessionsEnded) => void): () => void {
  bus.on('ended', listener);
  return () => {
    bus.off('ended', listener);
  };
}
