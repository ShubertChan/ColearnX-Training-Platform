import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encrypts TOTP secrets at rest with AES-256-GCM.
 *
 * WHY THIS IS NOT OPTIONAL
 *
 * A TOTP secret is a bearer credential: anyone holding it can generate valid
 * codes forever. Stored in plaintext, a single database dump silently defeats
 * two-factor authentication for every enrolled account, and -- unlike a
 * password hash -- there is nothing to slow the attacker down, because there is
 * nothing to crack. The key lives in the environment rather than the database,
 * so a dump alone is not enough.
 *
 * GCM rather than CBC: it authenticates the ciphertext, so a tampered row fails
 * to decrypt instead of yielding a silently wrong secret. A wrong secret would
 * lock the user out with no diagnosis; a decryption failure is at least legible.
 *
 * The nonce is 96 bits of fresh randomness per encryption, never reused, and
 * stored alongside the ciphertext. Reuse under one key is the single failure
 * that breaks GCM completely.
 */

const algorithm = 'aes-256-gcm';
const nonceBytes = 12;
const tagBytes = 16;

/**
 * Derives a 32-byte key from the configured secret so the environment variable
 * can be any length. This is a domain-separated digest, not a password KDF:
 * the input is already high-entropy machine-generated material, so stretching
 * it would add cost without adding security.
 */
export const deriveMfaKey = (secret: string) =>
  createHash('sha256').update(`colearnx-mfa-secret-key:${secret}`).digest();

/** Returns `nonce.ciphertext.tag`, each base64url, safe for a text column. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv(algorithm, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [nonce, ciphertext, cipher.getAuthTag()]
    .map((part) => part.toString('base64url'))
    .join('.');
}

export function decryptSecret(stored: string, key: Buffer): string {
  const parts = stored.split('.');
  if (parts.length !== 3) throw new Error('Malformed encrypted secret.');
  const [nonce, ciphertext, tag] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (nonce.length !== nonceBytes || tag.length !== tagBytes) throw new Error('Malformed encrypted secret.');
  const decipher = createDecipheriv(algorithm, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
