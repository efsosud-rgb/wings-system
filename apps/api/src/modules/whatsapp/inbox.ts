import type { Actor, WaInboxSummary } from '@wings/shared';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { leadOwnerFilter } from '../leads/access.js';
import { reachOf, unreadMessageOf } from './thread.js';

/**
 * The reader's inbox at a glance (`WaInboxSummary`): the menu's count and the
 * stamp the screens watch. The same reach and unread rule as their list
 * (`conversationListSql`): a seller counts their own deals' conversations and
 * their own work number's chats, a full-scope reader every one, a conversation
 * with no deal included. The stamp
 * is a hash of how many conversations they reach, the newest message and change
 * of hands among them and the unread count, so it moves with each of those and
 * carries none of them. A delivery status alone does not move it: the open
 * screens' own refresh shows the ticks.
 */
export async function inboxSummaryOf(db: Database, actor: Actor): Promise<WaInboxSummary> {
  const owner = leadOwnerFilter(actor, 'leads.whatsapp');
  const { rows } = await db.execute<{ unread: number; stamp: string }>(sql`
    select s.unread, md5(concat_ws('|', s.total, s.last_at, s.state_at, s.unread)) as stamp
    from (
      select count(*)::int as total, max(c.last_message_at) as last_at,
             max(c.state_changed_at) as state_at,
             (count(*) filter (where exists (
               select 1 from wa_messages u where ${unreadMessageOf(actor.employeeId)})))::int as unread
      from wa_conversations c
      left join leads l on l.id = c.lead_id
      left join wa_numbers n on n.id = c.number_id
      where c.last_message_at is not null
        ${reachOf(owner)}
    ) s`);
  const row = rows[0];
  return { unread: Number(row?.unread ?? 0), stamp: row?.stamp ?? '' };
}
