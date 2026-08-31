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
