import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDatabase } from './db/database.js';
import { primeCredentialVerifier } from './auth/credential-verify.js';

const app = createApp();
// Generates the argon2 decoy before the first request, so the first
// unauthenticated sign-in of a process does not pay the one-off hashing cost
// and stand out from every later one.
// Never left unhandled: argon2 is a native module, and a rejection here would
// be an unhandled promise rejection, which terminates the process under Node's
// default policy. A cold decoy is a degraded defence; a dead API is an outage.
void primeCredentialVerifier().then((ready) => {
  if (!ready) process.stderr.write('Credential verifier decoy unavailable; login timing defence is degraded.\n');
});
const server = app.listen(env.PORT, () => { process.stdout.write(`CoLearnX API listening on port ${env.PORT}\n`); });

async function shutdown(signal: string) {
  process.stdout.write(`Received ${signal}; shutting down.\n`);
  server.close(async () => { await closeDatabase(); process.exit(0); });
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
