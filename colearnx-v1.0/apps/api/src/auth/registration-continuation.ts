import jwt from 'jsonwebtoken';

// This browser-bound continuation outlives a single verification code so a
// legitimate resend can finish the same registration flow. It never authenticates
// by itself; the current email code is still required.
export const registrationContinuationLifetimeSeconds = 60 * 60;

const audience = 'colearnx-registration';
const issuer = 'colearnx-api';
const purpose = 'registration-verification';

export type RegistrationContinuation = {
  userId: string;
  email: string;
};

export function signRegistrationContinuation(
  continuation: RegistrationContinuation,
  secret: string,
) {
  return jwt.sign(
    {
      sub: continuation.userId,
      email: continuation.email,
      purpose,
    },
    secret,
    {
      audience,
      issuer,
      expiresIn: registrationContinuationLifetimeSeconds,
    },
  );
}

export function verifyRegistrationContinuation(
  token: string | undefined,
  secret: string,
): RegistrationContinuation | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, secret, { audience, issuer });
    if (
      typeof payload === 'string'
      || typeof payload.sub !== 'string'
      || typeof payload.email !== 'string'
      || payload.purpose !== purpose
    ) return null;
    return { userId: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}
