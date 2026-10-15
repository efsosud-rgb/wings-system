import { randomInt } from 'node:crypto';
import { generateFormRef, trackingRefOf } from '@wings/shared';
import { and, eq, gte } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leads } from '../../db/schema/index.js';

/**
 * The short reference of a site-form submission (docs/leads/formularios.md): six characters kept
 * on the lead and sent in the wa.me text right after the tracking link's code, so the first
 * WhatsApp message can be tied to the lead the form made even when it comes from another number.
 * A new submission of the same lead gets a new one; only the latest is honoured, and only for
 * `FORM_REF_VALID_DAYS`. The ref is a hint that ties a conversation to a lead, never a key to the
 * lead's data: nothing about the lead is shown to the sender because of it.
 */
export const FORM_REF_VALID_DAYS = 7;

/** From the operating system's generator: a ref made with Math.random could be guessed. */
const secureRandom = () => randomInt(0, 2 ** 32) / 2 ** 32;

export async function attachFormRef(
  db: Database,
  leadId: string,
  now: Date = new Date(),
): Promise<string | null> {
  // 32^6 values: a clash is a one-in-a-billion event, but the unique index decides, not luck.
  for (let attempt = 0; attempt < 5; attempt++) {
    const ref = generateFormRef(secureRandom);
    try {
      await db.update(leads).set({ formRef: ref, formRefAt: now }).where(eq(leads.id, leadId));
      return ref;
    } catch (error) {
      if ((error as { code?: string }).code !== '23505') throw error;
    }
  }
  return null;
}

/** The lead a message's `<code> <ref>` points to (and its phone), or null: no ref, no lead holds it, or it is older than 7 days. */
export async function leadByFormRef(
  db: Database,
  text: string | null | undefined,
  now: Date = new Date(),
): Promise<{ id: string; phone: string | null } | null> {
  const ref = trackingRefOf(text);
  if (!ref) return null;
  const since = new Date(now.getTime() - FORM_REF_VALID_DAYS * 86_400_000);
  const [lead] = await db
    .select({ id: leads.id, phone: leads.phone })
    .from(leads)
    .where(and(eq(leads.formRef, ref), gte(leads.formRefAt, since)))
    .limit(1);
  return lead ?? null;
}
