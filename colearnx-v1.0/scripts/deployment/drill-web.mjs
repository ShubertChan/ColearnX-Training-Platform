// Local exercise only: serve a specific built frontend and its real Express
// API on one loopback port, so a rollback swaps both parts as a pair.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const db = new URL(process.env.DATABASE_URL);
if (db.hostname !== '127.0.0.1' || db.pathname !== '/colearnx_drill' || db.username !== 'colearnx_app') {
  throw new Error('Recovery exercise requires its isolated runtime account and database.');
}
const appRoot = resolve(process.argv[2]);
const entry = pathToFileURL(resolve(appRoot, 'apps/api/dist/app.js'));
const express = createRequire(entry)('express');
const api = (await import(entry)).createApp();
const frontend = express();
frontend.use(express.static(resolve(appRoot, 'dist')));
createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path.startsWith('/api/') || path.startsWith('/health/')) api(request, response);
  else frontend(request, response);
}).listen(Number(process.env.PORT), '127.0.0.1');
