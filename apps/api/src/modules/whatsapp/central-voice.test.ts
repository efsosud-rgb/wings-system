import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { leadFiles, waConversations } from '../../db/schema/index.js';
import {
  ago,
  apply,
  app,
  chatOfPerson,
  db,
  deal,
  fixtures,
  mediaUploads,
  NUMBER_TOKEN,
  owner,
  PERSON,
  resetCentral,
  sends,
  startCentral,
  stopCentral,
  WORK_ID,
} from './central-fixtures.js';
import { fakeRecording } from './voice-fixtures.js';

/**
 * A voice note recorded in a work number's conversation (docs/whatsapp/central.md): it goes up to
 * Meta and out with that number's own token, never the official one, inside that number's own
 * window, and only in a conversation a deal took (the audio is kept in the deal's files). Setup in
 * `central-fixtures.ts`; the official number's cases are in `voice-send.test.ts`.
 */

let recording: Buffer;

beforeAll(async () => {
  await startCentral();
  recording = await fakeRecording(2);
}, 60_000);
afterAll(stopCentral);
beforeEach(resetCentral);

const record = (conversationId: string) =>
  app.inject({
    method: 'POST',
    url: `/whatsapp/conversations/${conversationId}/voice`,
    cookies: owner.cookies,
    headers: { 'content-type': 'audio/webm;codecs=opus', 'idempotency-key': randomUUID() },
    payload: recording,
  });

/** The person wrote to the work number `minutesAgo`; the chat belongs to a deal of the owner. */
async function numberChat(minutesAgo: number, withDeal = true) {
  await apply(fixtures.message('wamid.VOICE1', ago(minutesAgo)));
  const chat = (await chatOfPerson())!;
  const leadId = withDeal ? await deal(PERSON, owner.id) : null;
  if (leadId)
    await db.update(waConversations).set({ leadId }).where(eq(waConversations.id, chat.id));
  return { chatId: chat.id, leadId };
}

describe("a voice note on a work number's conversation", () => {
  it("goes up and out with the number's own token, as a voice message", async () => {
    const { chatId, leadId } = await numberChat(5);
    const res = await record(chatId);
    expect(res.statusCode).toBe(201);
    expect(mediaUploads).toEqual([
      {
        url: expect.stringContaining(`/${WORK_ID}/media`),
        auth: `Bearer ${NUMBER_TOKEN}`,
        type: 'audio/ogg',
      },
    ]);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      url: expect.stringContaining(`/${WORK_ID}/messages`),
      auth: `Bearer ${NUMBER_TOKEN}`,
      body: { type: 'audio', audio: { id: 'MEDIA1', voice: true } },
    });
    expect(await db.select().from(leadFiles).where(eq(leadFiles.leadId, leadId!))).toHaveLength(1);
  });

  it("refuses outside the number's own window, and in a chat no deal took", async () => {
    const closed = await numberChat(25 * 60);
    const late = await record(closed.chatId);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: 'window_closed' });
    await resetCentral();
    const loose = await numberChat(5, false);
    const noDeal = await record(loose.chatId);
    expect(noDeal.statusCode).toBe(422);
    expect(noDeal.json()).toMatchObject({ error: 'no_deal' });
    expect(mediaUploads).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
});
