import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../env.js';

/**
 * Transactional e-mail over Google Workspace SMTP.
 *
 * When SMTP is not configured (local development), messages are logged instead
 * of sent. The one-time link is only ever logged outside production.
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send: (mail: Mail) => Promise<void>;
  /** False when running without SMTP credentials (development fallback). */
  enabled: boolean;
}

export function createMailer(env: Env, log?: { info: (msg: string) => void }): Mailer {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.SMTP_FROM) {
    return {
      enabled: false,
      send: async (mail) => {
        if (env.NODE_ENV === 'production') {
          throw new Error('SMTP is not configured — refusing to drop a transactional e-mail');
        }
        log?.info(`[mailer disabled] would send "${mail.subject}" to ${mail.to}\n${mail.text}`);
      },
    };
  }

  const transporter: Transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Google Workspace: STARTTLS on 587, implicit TLS on 465.
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });

  return {
    enabled: true,
    send: async (mail) => {
      await transporter.sendMail({
        from: env.SMTP_FROM,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    },
  };
}

function layout(title: string, greeting: string, body: string, link: string, cta: string): string {
  return `<!doctype html>
<html lang="pt-BR"><body style="margin:0;background:#0a0a0a;color:#e5e5e5;font-family:system-ui,-apple-system,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px">
    <h1 style="color:#e95228;font-size:20px;margin:0 0 24px">Wings System</h1>
    <h2 style="font-size:16px;margin:0 0 12px">${title}</h2>
    <p style="color:#a3a3a3;font-size:14px;line-height:1.5">${greeting}</p>
    <p style="color:#a3a3a3;font-size:14px;line-height:1.5">${body}</p>
    <p style="margin:24px 0">
      <a href="${link}" style="background:#e95228;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600;font-size:14px;display:inline-block">${cta}</a>
    </p>
    <p style="color:#737373;font-size:12px;line-height:1.5">Se o botão não funcionar, copie e cole este endereço no navegador:<br>${link}</p>
  </div>
</body></html>`;
}

export function inviteMail(args: { to: string; name: string; link: string; days: number }): Mail {
  const text = `Olá, ${args.name}.

Sua conta no Wings System foi criada. Defina sua senha pelo link abaixo:

${args.link}

O link expira em ${args.days} dias e só pode ser usado uma vez.
Se você não esperava este e-mail, avise o RH.`;

  return {
    to: args.to,
    subject: 'Wings System — defina sua senha de acesso',
    text,
    html: layout(
      'Defina sua senha de acesso',
      `Olá, ${args.name}.`,
      `Sua conta no Wings System foi criada. O link abaixo expira em ${args.days} dias e só pode ser usado uma vez.`,
      args.link,
      'Definir senha',
    ),
  };
}

export function resetMail(args: { to: string; name: string; link: string; minutes: number }): Mail {
  const text = `Olá, ${args.name}.

Recebemos um pedido para redefinir sua senha do Wings System:

${args.link}

O link expira em ${args.minutes} minutos e só pode ser usado uma vez.
Se não foi você, ignore este e-mail — sua senha atual continua valendo.`;

  return {
    to: args.to,
    subject: 'Wings System — redefinição de senha',
    text,
    html: layout(
      'Redefinição de senha',
      `Olá, ${args.name}.`,
      `Recebemos um pedido para redefinir sua senha. O link expira em ${args.minutes} minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail.`,
      args.link,
      'Redefinir senha',
    ),
  };
}
