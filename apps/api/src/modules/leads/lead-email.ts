import {
  EMAIL_ATTACHMENTS_MAX_BYTES,
  emailAttachmentRefusal,
  normalizeEmail,
  type LeadEmailAttachment,
} from '@wings/shared';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { crmContacts, driveFiles, leadContacts } from '../../db/schema/index.js';
import type { ObjectStorage } from '../../lib/storage/index.js';
import type { DriveAccess } from '../drive/access.js';
import { DriveError, fileFor, type DriveDeps } from '../drive/service.js';
import type { MailAttachment } from '../google-workspace/gmail.js';
import { leadHasFile } from './files.js';

/**
 * Free-text e-mail from the deal (t081): who it may go to, and which of the
 * deal's files may go with it. The sending itself is `sendToLead`, the same as
 * a template's. Nothing here logs an address or a file name.
 */

export interface DealAddress {
  email: string;
  name: string | null;
  primary: boolean;
}

/** The deal's own e-mail first, then its contacts' (primary first); each address once. */
export async function dealAddressesOf(
  db: Database,
  lead: { id: string; email: string | null; name: string | null },
): Promise<DealAddress[]> {
  const contacts = await db
    .select({ email: crmContacts.email, name: crmContacts.name, primary: leadContacts.primary })
    .from(leadContacts)
    .innerJoin(crmContacts, eq(crmContacts.id, leadContacts.contactId))
    .where(and(eq(leadContacts.leadId, lead.id), isNull(crmContacts.mergedIntoId)))
    .orderBy(desc(leadContacts.primary), asc(leadContacts.createdAt));
  const seen = new Set<string>();
  const out: DealAddress[] = [];
  for (const entry of [{ email: lead.email, name: lead.name, primary: true }, ...contacts]) {
    const email = normalizeEmail(entry.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: entry.name, primary: out.length === 0 });
  }
  return out;
}

export type AttachmentRefusal = 'file_not_found' | 'file_type' | 'too_large';

/**
 * The deal's files asked for, checked before anything is sent: each one of
 * this deal's own and one the sender may open (as the deal's link route asks),
 * no program or script, 20 MB all together. `files` reads the bytes, only
 * when a message really leaves.
 */
export async function attachmentsFor(
  deps: DriveDeps,
  access: DriveAccess,
  leadId: string,
  fileIds: string[],
): Promise<
  | { ok: true; attachments: LeadEmailAttachment[]; files: () => Promise<MailAttachment[]> }
  | { ok: false; reason: AttachmentRefusal }
> {
  const found: (typeof driveFiles.$inferSelect)[] = [];
  for (const fileId of new Set(fileIds)) {
    const row = (await leadHasFile(deps.db, leadId, fileId))
      ? await fileFor(deps, access, fileId).catch((error: unknown) => {
          if (error instanceof DriveError) return null;
          throw error;
        })
      : null;
    if (!row || row.file.trashedAt) return { ok: false, reason: 'file_not_found' };
    if (emailAttachmentRefusal(row.file.name, row.file.mimeType))
      return { ok: false, reason: 'file_type' };
    found.push(row.file);
  }
  const total = found.reduce((sum, file) => sum + file.byteSize, 0);
  if (total > EMAIL_ATTACHMENTS_MAX_BYTES) return { ok: false, reason: 'too_large' };
  return {
    ok: true,
    attachments: found.map((file) => ({
      fileId: file.id,
      name: file.name,
      byteSize: file.byteSize,
    })),
    files: () => readAll(deps.storage, found),
  };
}

async function readAll(
  storage: ObjectStorage | null,
  files: { storageKey: string; name: string; mimeType: string }[],
): Promise<MailAttachment[]> {
  if (files.length === 0) return [];
  if (!storage) throw new Error('storage_unavailable');
  return Promise.all(
    files.map(async (file) => {
      const content = await storage.get(file.storageKey);
      if (!content) throw new Error('attachment_missing');
      return { filename: file.name, contentType: file.mimeType, content };
    }),
  );
}
