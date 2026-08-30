import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDatabase } from './db/database.js';

const app = createApp();
const server = app.listen(env.PORT, () => { process.stdout.write(`CoLearnX API listening on port ${env.PORT}\n`); });

async function shutdown(signal: string) {
  process.stdout.write(`Received ${signal}; shutting down.\n`);
  server.close(async () => { await closeDatabase(); process.exit(0); });
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
