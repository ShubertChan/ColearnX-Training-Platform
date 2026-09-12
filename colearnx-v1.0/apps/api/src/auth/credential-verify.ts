import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Closes the timing oracle in threat model F-01.
 *
 * The original login path called `argon2.verify` only when the address
 * resolved to a row.  argon2id is deliberately expensive -- tens to hundreds
 * of milliseconds -- so "no such account" returned an order of magnitude
 * faster than "wrong password".  That difference is far larger than network
 * jitter and is measurable remotely with a handful of samples, which turns the
 * login endpoint into a user-enumeration oracle regardless of how carefully
 * the error message is worded.
 *
 * The fix is to always spend the same work.  When there is no stored hash, the
 * password is verified against a decoy instead, and the result is discarded.
 *
 * The decoy is produced by the same `argon2.hash` call with the same options
 * as a real credential, so its memory cost, time cost and parallelism match.
 * A decoy with different parameters would reintroduce the very difference it
 * is meant to erase.
 *
 * It is generated once per process from fresh randomness rather than being a
 * constant checked into the repository: a committed hash is a fixed target,
 * and there is no reason to publish one.
 */
let decoy: Promise<string> | null = null;

function decoyHash(): Promise<string> {
  decoy ??= argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id });
  return decoy;
}

/**
 * Warms the decoy at startup so that the very first unauthenticated request of
 * a process does not pay the one-off hashing cost and stand out.
 */
export async function primeCredentialVerifier(): Promise<void> {
  await decoyHash();
}

export async function verifyPasswordConstantWork(
  storedHash: string | null | undefined,
  password: string,
): Promise<boolean> {
  const hash = storedHash ?? (await decoyHash());
  let matched = false;
  try {
    matched = await argon2.verify(hash, password);
  } catch {
    // A stored hash that argon2 cannot parse is corrupt data, not a match.
    // Swallowing it here keeps the failure indistinguishable from a wrong
    // password rather than surfacing a 500 that reveals the account exists.
    matched = false;
  }
  return storedHash ? matched : false;
}
