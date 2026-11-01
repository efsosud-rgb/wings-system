import { sql } from 'drizzle-orm';
import { announceLeadReturned } from './crm-alerts.js';
import { ensureReturnTask, type Executor, type ReturnTaskResult } from './crm.js';
import { contactBlock } from './contact-block.js';

/**
 * A lead that already exists filled the site form again (docs/crm/aviso-lead-novo.md): what the
 * seller is given, and why nothing more was given when it was held back. The answer itself is on the
 * timeline before this runs; nothing here can lose it.
 */
export interface LeadReturnOutcome {
  /** Why neither task nor notice was made: the lead is marked as a robot's (docs/leads/suspeitos.md). */
  held: 'suspect' | null;
  /** The person asked not to be contacted on any channel: no task, and the notice says so. */
  blocked: boolean;
  task: ReturnTaskResult | 'held';
  notice: 'sent' | 'limit' | 'failed' | 'held';
}

/** Every channel Wings starts contact on (`CONTACT_CHANNEL_LABELS`, less the register's own `all`). */
const CHANNELS = ['whatsapp', 'phone', 'email', 'instagram'] as const;

/**
 * Decides, inside the transaction that saved the answer, what a return gives the seller, with at
 * most one return task and one return notice per lead in `RETURN_LIMIT_MS` (Eric, 29/10/2026). The
 * lead's advisory lock makes the limit and the writes one step, so two submissions at once never
 * make two (lesson 5 of the notebook); the limit itself lives in `ensureReturnTask` and
 * `announceLeadReturned`.
 *
 * - A lead marked as a robot's (`suspect_at` set, not cleared) gets neither: a burst of made-up
 *   people must not become tasks (docs/leads/suspeitos.md). A person who clears the mark ("Não é
 *   robô") turns it back on.
 * - A person who asked not to be contacted on every channel (`contactBlock`, by every key the form
 *   and the lead carry: phone and e-mail, lesson 3) gets no task, since the task is an order to
 *   contact; the owner is still told, and the limit counts that notice.
 */
export async function registerLeadReturn(
  tx: Executor,
  lead: {
    id: string;
    ownerEmployeeId: string | null;
    suspectAt: Date | null;
    suspectClearedAt: Date | null;
  },
  given: { phone: string | null; email: string | null },
  now = new Date(),
): Promise<LeadReturnOutcome> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lead:returned:${lead.id}`}))`);
  if (lead.suspectAt && !lead.suspectClearedAt)
    return { held: 'suspect', blocked: false, task: 'held', notice: 'held' };
  // Read through `tx`, one query at a time (`contactBlock`): a read through the pool would ask for a
  // second connection while this transaction holds the lead's lock on the first, and with as many
  // submissions at once as the pool has connections every one waits for another (the API stops). The
  // lead's own keys come with its id; the phone and e-mail typed this time, when they differ, are
  // added, so a block registered on either reaches the person.
  let blocked = true;
  for (const channel of CHANNELS) {
    const check = await contactBlock(tx, channel, {
      leadId: lead.id,
      phone: given.phone,
      email: given.email,
    });
    if (!check.blocked) {
      blocked = false;
      break;
    }
  }
  const task = blocked ? 'held' : await ensureReturnTask(tx, lead, now);
  const notice = await announceLeadReturned(tx, lead, { now, blocked });
  return { held: null, blocked, task, notice };
}
