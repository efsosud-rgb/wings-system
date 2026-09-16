import { z } from 'zod';

/**
 * Invite and password-reset contract, shared by the API and the web forms so
 * both enforce the same rules.
 */

/** Lifetimes of the one-time links. */
export const INVITE_EXPIRY_DAYS = 7;
export const RESET_EXPIRY_MINUTES = 60;

export const PASSWORD_MIN_LENGTH = 12;

export const CREDENTIAL_TOKEN_PURPOSES = ['invite', 'reset'] as const;
export type CredentialTokenPurpose = (typeof CREDENTIAL_TOKEN_PURPOSES)[number];

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres`)
  .max(200, 'Senha muito longa')
  .refine(
    (value) => value.trim().length === value.length,
    'A senha não pode começar ou terminar com espaço',
  )
  .refine((value) => !/^\s*$/.test(value), 'Senha inválida');

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido').max(160),
});

export const setPasswordSchema = z.object({
  token: z.string().min(20, 'Link inválido').max(200),
  password: passwordSchema,
});

export type ForgotPasswordInput = z.output<typeof forgotPasswordSchema>;
export type SetPasswordInput = z.output<typeof setPasswordSchema>;

/**
 * Rejects passwords that are just the person's own identifiers or an obvious
 * guess. Kept in shared so the browser can warn before the request is sent.
 *
 * Deliberately narrow: a passphrase such as "minha-senha-bem-longa" is strong
 * even though it contains the word "senha", so only whole-password matches and
 * clearly guessable strings are refused.
 */
const WEAK_WHOLE_WORDS = ['senha', 'password', 'wings', 'wingssystem', 'wingscompany'];

export function passwordLooksPersonal(password: string, email: string): boolean {
  const localPart = email.split('@')[0]?.toLowerCase() ?? '';
  const lowered = password.toLowerCase();
  const letters = lowered.replace(/[^a-z0-9]/g, '');

  // Contains the account name itself.
  if (localPart.length >= 4 && lowered.includes(localPart)) return true;

  // Obvious sequences anywhere in the password.
  if (/(123456|abcdef|qwerty)/.test(letters)) return true;

  // The whole password is one weak word, optionally with a short suffix
  // ("senha", "senha123", "wings2026").
  return WEAK_WHOLE_WORDS.some(
    (weak) => letters.startsWith(weak) && letters.length <= weak.length + 4,
  );
}
