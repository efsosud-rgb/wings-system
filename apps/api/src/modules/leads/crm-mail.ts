import type { Env } from '../../env.js';
import { createMailer, type Mailer } from '../../lib/mailer.js';

/**
 * The transport of CRM e-mail. `test` (the default, and the only one until
 * CRM_EMAIL_MODE=smtp) sends nothing: the caller records the message in
 * `crm_email_outbox` and that is the whole delivery. `smtp` goes through the
 * Workspace account the system already has, or refuses when it is not set up.
 */
export interface CrmMailTransport {
  mode: 'test' | 'smtp';
  send(mail: { to: string; subject: string; text: string }): Promise<void>;
}

export const testTransport: CrmMailTransport = { mode: 'test', send: async () => {} };

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function createCrmMailTransport(env: Env, mailer?: Mailer): CrmMailTransport {
  if (env.CRM_EMAIL_MODE !== 'smtp') return testTransport;
  const smtp = mailer ?? createMailer(env);
  return {
    mode: 'smtp',
    send: async ({ to, subject, text }) => {
      if (!smtp.enabled) throw new Error('smtp_not_configured');
      await smtp.send({
        to,
        subject,
        text,
        html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(text)}</div>`,
      });
    },
  };
}
