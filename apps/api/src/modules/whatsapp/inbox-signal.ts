import { EventEmitter } from 'node:events';

/**
 * "Something in the WhatsApp conversations may have changed" (a message came or
 * went, a conversation was opened), inside this process. The open streams look
 * at each reader's inbox again; the signal carries nothing about the message.
 * Every writer of `wa_messages` lives in the API, and the streams' periodic look
 * covers what does not signal (a deal changing owner, Sofia handing over).
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function notifyInboxChanged(): void {
  bus.emit('changed');
}

/** Returns the function that stops listening. */
export function onInboxChanged(listener: () => void): () => void {
  bus.on('changed', listener);
  return () => {
    bus.off('changed', listener);
  };
}
