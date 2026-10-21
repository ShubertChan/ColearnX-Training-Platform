import { Client } from 'pg';
import { env } from '../config/env.js';

export const refundNotificationChannel = 'colearnx_refund_decisions';

// One dedicated LISTEN connection per API process, not one connection per user.
// PostgreSQL delivers NOTIFY only after commit and across API instances.
export function createRefundNotificationEvents(makeClient = () => new Client({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  application_name: 'colearnx-refund-notifications',
  keepAlive: true,
})) {
  const subscribers = new Map<string, Set<() => void>>();
  let client: Client | null = null;
  let starting: Promise<boolean> | null = null;
  let stopped = false;
  const wakeAll = () => { for (const callbacks of subscribers.values()) for (const callback of callbacks) callback(); };

  function start(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    if (starting) return starting;
    if (client) return Promise.resolve(true);
    const connection = makeClient();
    client = connection;
    const disconnect = () => {
      if (client !== connection) return;
      client = null;
      wakeAll();
      void connection.end().catch(() => {});
    };
    connection.on('notification', (event) => {
      if (event.channel !== refundNotificationChannel || !event.payload) return;
      for (const callback of subscribers.get(event.payload) ?? []) callback();
    });
    connection.on('error', disconnect);
    connection.on('end', disconnect);
    starting = (async () => {
      try {
        await connection.connect();
        await connection.query(`LISTEN ${refundNotificationChannel}`);
        return client === connection && !stopped;
      } catch {
        disconnect();
        return false;
      } finally { starting = null; }
    })();
    return starting;
  }

  return {
    subscribe(userId: string, callback: () => void) {
      const callbacks = subscribers.get(userId) ?? new Set<() => void>();
      callbacks.add(callback);
      subscribers.set(userId, callbacks);
      return {
        ready: start(),
        dispose() {
          callbacks.delete(callback);
          if (!callbacks.size) subscribers.delete(userId);
        },
      };
    },
    async close() {
      stopped = true;
      wakeAll();
      subscribers.clear();
      const connection = client;
      client = null;
      if (connection) await connection.end().catch(() => {});
      await starting;
    },
  };
}

export const refundNotificationEvents = createRefundNotificationEvents();
