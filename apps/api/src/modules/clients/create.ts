import { clientSlugOf } from '@wings/shared';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { clientContacts, clients } from '../../db/schema/index.js';
import { syncDriveFolders } from '../drive/folders.js';
import { openProjectForClient } from '../projects/service.js';

type ClientRow = typeof clients.$inferSelect;
type QuickContact = Omit<typeof clientContacts.$inferInsert, 'clientId' | 'role' | 'id'>;

/**
 * Registers a client the way "Novo cliente" does: the next `NN` under a lock,
 * the main contact when given, its project opened (Em Andamento, at 01) and
 * its Drive tree under Clientes/<NN. Nome>. Null when the name is taken.
 * Writing the audit entry is the caller's (it knows who acted).
 */
export async function createClientRecord(
  db: Database,
  input: { name: string; cnpj?: string | null; contact?: QuickContact | null },
): Promise<{ row: ClientRow; driveFoldersCreated: number } | null> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(7301, 2)`);
    const [last] = await tx
      .select({ number: sql<number | null>`max(${clients.number})` })
      .from(clients);
    const [made] = await tx
      .insert(clients)
      .values({
        name: input.name,
        slug: clientSlugOf(input.name),
        number: (last?.number ?? 0) + 1,
        cnpj: input.cnpj ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (made && input.contact) {
      await tx
        .insert(clientContacts)
        .values({ clientId: made.id, role: 'principal', ...input.contact });
    }
    if (made) await openProjectForClient(tx, made.id);
    return made;
  });
  if (!row) return null;
  const folders = await syncDriveFolders(db);
  return { row, driveFoldersCreated: folders.foldersCreated };
}
