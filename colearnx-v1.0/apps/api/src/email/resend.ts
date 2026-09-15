import { env } from '../config/env.js';

export class EmailDeliveryError extends Error {
  constructor() {
    super('Verification email delivery failed.');
  }
}

type VerificationEmail = {
  to: string;
  code: string;
  expiresInMinutes: number;
};
type PasswordResetEmail = {
  to: string;
  resetUrl: string;
  expiresInMinutes: number;
};

export async function sendVerificationEmail({ to, code, expiresInMinutes }: VerificationEmail) {
  if (env.EMAIL_PROVIDER !== 'resend') throw new EmailDeliveryError();

  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [to],
        subject: 'Your CoLearnX email verification code',
        text: `Your CoLearnX verification code is ${code}. It expires in ${expiresInMinutes} minutes. If you did not create a CoLearnX account, you can ignore this email.`,
        html: `<p>Your CoLearnX verification code is:</p><p style="font-size: 24px; font-weight: 700; letter-spacing: 0.12em;"><strong>${code}</strong></p><p>It expires in ${expiresInMinutes} minutes. If you did not create a CoLearnX account, you can ignore this email.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new EmailDeliveryError();
  }

  if (!response.ok) throw new EmailDeliveryError();
}

export async function sendPasswordResetEmail({ to, resetUrl, expiresInMinutes }: PasswordResetEmail) {
  if (env.EMAIL_PROVIDER !== 'resend') throw new EmailDeliveryError();
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [to],
        subject: 'Reset your CoLearnX password',
        text: `Use this one-time link to reset your CoLearnX password: ${resetUrl}\n\nThe link expires in ${expiresInMinutes} minutes. If you did not request this, you can ignore this email.`,
        html: `<p>Use this one-time link to reset your CoLearnX password:</p><p><a href="${resetUrl}">Reset password</a></p><p>This link expires in ${expiresInMinutes} minutes. If you did not request this, you can ignore this email.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new EmailDeliveryError();
  }
  if (!response.ok) throw new EmailDeliveryError();
}

/**
 * ASVS 2.2.3. For an account holder who did not perform the change, this is
 * the only out-of-band signal that it happened.
 */
export async function sendPasswordChangedEmail({ to }: { to: string }) {
  if (env.EMAIL_PROVIDER !== 'resend') throw new EmailDeliveryError();
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [to],
        subject: 'Your CoLearnX password was changed',
        text: 'Your CoLearnX password was just changed and all existing sessions were signed out. If this was not you, reset your password immediately to regain control of the account.',
        html: '<p>Your CoLearnX password was just changed and all existing sessions were signed out.</p><p>If this was not you, reset your password immediately to regain control of the account.</p>',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new EmailDeliveryError();
  }
  if (!response.ok) throw new EmailDeliveryError();
}

/**
 * Tells the account holder that repeated failed sign-ins paused their account.
 *
 * Delivered only to the registered address, so unlike the sign-in page this
 * channel can safely name the account state. The wording deliberately avoids
 * alarm: the overwhelmingly common cause is the owner mistyping their own
 * password, and an email that opens with "your account is under attack" would
 * be wrong most of the time and ignored the rest.
 *
 * No IP address or location is included. Only a keyed fingerprint of the
 * source is stored (threat model F-05), and a half-accurate geolocation in a
 * security email causes more alarm than it resolves.
 */
export async function sendAccountLockedEmail(
  { to, duration, resetUrl }: { to: string; duration: string; resetUrl: string },
) {
  if (env.EMAIL_PROVIDER !== 'resend') throw new EmailDeliveryError();
  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [to],
        subject: 'Sign-in to your CoLearnX account was paused',
        text: `There have been several failed sign-in attempts on your CoLearnX account, so sign-in has been paused for about ${duration}.\n\nIf that was you, wait for the pause to end and try again — or reset your password, which lifts the pause immediately: ${resetUrl}\n\nIf it was not you, your password has NOT been changed and nobody has signed in. Resetting your password is still the safest response.`,
        html: `<p>There have been several failed sign-in attempts on your CoLearnX account, so sign-in has been paused for about <strong>${duration}</strong>.</p><p>If that was you, wait for the pause to end and try again — or <a href="${resetUrl}">reset your password</a>, which lifts the pause immediately.</p><p>If it was not you, your password has <strong>not</strong> been changed and nobody has signed in. Resetting your password is still the safest response.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new EmailDeliveryError();
  }
  if (!response.ok) throw new EmailDeliveryError();
}
