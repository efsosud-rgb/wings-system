import { randomInt } from 'node:crypto';
import { generateTrackingCode, type LeadLinkChannel } from '@wings/shared';
import type { Database } from '../../db/client.js';
import { leadTrackingLinks } from '../../db/schema/index.js';

export type TrackingLinkRow = typeof leadTrackingLinks.$inferSelect;

/** A draw in [0, 1) from the system's CSPRNG, for codes nobody should guess. */
export const cryptoRandom = (): number => randomInt(2 ** 32) / 2 ** 32;

/**
 * A new tracked link for the client on that number. The code is unique by
 * index; a collision (1 in a billion) just draws again, up to five times, and
 * null means every draw collided. Used by the client's screen and the seed.
 */
export async function createTrackingLink(
  db: Database,
  input: {
    clientId: string;
    channel: LeadLinkChannel;
    phone: string;
    createdBy: string | null;
  },
): Promise<TrackingLinkRow | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row] = await db
      .insert(leadTrackingLinks)
      .values({
        clientId: input.clientId,
        channel: input.channel,
        code: generateTrackingCode(cryptoRandom),
        phone: input.phone,
        createdBy: input.createdBy,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
  }
  return null;
}
