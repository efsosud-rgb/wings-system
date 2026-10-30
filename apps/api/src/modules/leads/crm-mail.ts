import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { employees } from '../../db/schema/index.js';
import type { Env } from '../../env.js';
import { createMailer, type Mailer } from '../../lib/mailer.js';
import { newMessageId, sendGmail, type MailAttachment } from '../google-workspace/gmail.js';
import { GoogleOAuthError } from '../google-workspace/oauth.js';
import {
  accessTokenFor,
  googleWorkspaceDepsOf,
  type GoogleWorkspaceDeps,
} from '../google-workspace/service.js';

/**
 * The transport of CRM e-mail, by CRM_EMAIL_MODE:
 *
 *  - `test` (the default): sends nothing; the caller records the message in
 *    `crm_email_outbox` and that is the whole delivery.
 *  - `smtp`: the company's Workspace SMTP account (SMTP_FROM), or refuses when
 *    it is not set up.
 *  - `gmail`: the sender's own Gmail (the person clicking, or the lead's owner
 *    for an automation), through their Google connection — the message leaves
 *    from their address and the reply lands in their inbox. Someone not
 *    connected falls back to SMTP when it exists, else the send is refused
 *    (`no_sender`) and recorded as failed.
 *
 * What was sent (and from where) comes back so the outbox can keep the
 * Message-ID and Gmail's thread for the day replies are read.
 */
export type CrmMailMode = 'test' | 'smtp' | 'gmail';

export interface CrmMailSent {
  mode: CrmMailMode;
  fromEmail: string | null;
  messageId: string | null;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
}

export interface CrmMailTransport {
  mode: CrmMailMode;
  send(mail: {
    to: string;
    subject: string;
    text: string;
    /** Whose Gmail the message leaves from (`gmail` mode only). */
    senderEmployeeId: string | null;
    threadId?: string | null;
    inReplyTo?: string | null;
    attachments?: MailAttachment[];
  }): Promise<CrmMailSent>;
  /** The address a message of this person would leave from; null in test mode or with nobody able to send. */
  senderOf(employeeId: string | null): Promise<string | null>;
}

const nothing: CrmMailSent = {
  mode: 'test',
  fromEmail: null,
  messageId: null,
  gmailMessageId: null,
  gmailThreadId: null,
};

export const testTransport: CrmMailTransport = {
  mode: 'test',
  send: async () => nothing,
  senderOf: async () => null,
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlOf = (text: string) =>
  `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(text)}</div>`;

const domainOf = (settings: Env) => {
  try {
    return new URL(settings.APP_BASE_URL).hostname || 'wingssystem.online';
  } catch {
    return 'wingssystem.online';
  }
};

/** The transport as the running app has it: its mailer, its database and the Google client. */
export const crmMailOf = (wings: {
  env: Env;
  db: Database;
  mailer: Mailer;
  googleFetch?: typeof fetch;
  now?: () => Date;
}): CrmMailTransport =>
  createCrmMailTransport(wings.env, {
    mailer: wings.mailer,
    db: wings.db,
    google: googleWorkspaceDepsOf(wings),
  });

export function createCrmMailTransport(
  settings: Env,
  deps: { mailer?: Mailer; db?: Database; google?: GoogleWorkspaceDeps | null } = {},
): CrmMailTransport {
  const mode = settings.CRM_EMAIL_MODE;
  if (mode !== 'smtp' && mode !== 'gmail') return testTransport;
  const smtp = deps.mailer ?? createMailer(settings);
  const domain = domainOf(settings);
  const companyFrom = settings.SMTP_FROM ?? null;

  const viaSmtp = async (mail: {
    to: string;
    subject: string;
    text: string;
    attachments?: MailAttachment[];
  }) => {
    if (!smtp.enabled) throw new Error('smtp_not_configured');
    const messageId = newMessageId(domain);
    await smtp.send({
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: htmlOf(mail.text),
      attachments: mail.attachments,
    });
    return {
      mode: 'smtp' as const,
      fromEmail: companyFrom,
      messageId,
      gmailMessageId: null,
      gmailThreadId: null,
    };
  };

  if (mode === 'smtp') {
    return {
      mode: 'smtp',
      send: viaSmtp,
      senderOf: async () => (smtp.enabled ? companyFrom : null),
    };
  }

  const { db, google } = deps;
  /** The person's Google access, or null when they cannot send through Gmail right now. */
  const gmailOf = async (employeeId: string | null) => {
    if (!db || !google || !employeeId) return null;
    try {
      const access = await accessTokenFor(google, employeeId);
      if (!access.email) return null;
      const [person] = await db
        .select({ name: employees.fullName })
        .from(employees)
        .where(eq(employees.id, employeeId));
      return { token: access.accessToken, email: access.email, name: person?.name ?? null };
    } catch (error) {
      if (error instanceof GoogleOAuthError) return null;
      throw error;
    }
  };

  return {
    mode: 'gmail',
    senderOf: async (employeeId) =>
      (await gmailOf(employeeId))?.email ?? (smtp.enabled ? companyFrom : null),
    send: async (mail) => {
      const sender = await gmailOf(mail.senderEmployeeId);
      if (!sender) {
        if (!smtp.enabled) throw new Error('no_sender');
        return viaSmtp(mail);
      }
      const messageId = newMessageId(domain);
      const sent = await sendGmail(google!.transport, sender.token, {
        from: { email: sender.email, name: sender.name },
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: htmlOf(mail.text),
        messageId,
        threadId: mail.threadId ?? null,
        inReplyTo: mail.inReplyTo ?? null,
        attachments: mail.attachments,
      });
      return { mode: 'gmail', fromEmail: sender.email, messageId, ...sent };
    },
  };
}
