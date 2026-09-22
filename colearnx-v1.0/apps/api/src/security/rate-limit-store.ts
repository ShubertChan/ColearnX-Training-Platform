import type { Options, Store, IncrementResponse } from 'express-rate-limit';
import { getRedis } from '../lib/redis.js';

/**
 * The minimal Redis command surface the store needs. Declaring it here (rather
 * than importing ioredis's type) lets the unit test inject a fake, so the
 * window/counter logic is verified without a running Redis.
 */
export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
}

/**
 * A Redis-backed store for `express-rate-limit`, so the counter is shared
 * across every API instance instead of living in one process's memory
 * (threat-model finding F-06).
 *
 * Every method FAILS OPEN: if Redis is unreachable the request is allowed
 * rather than rejected. Losing the shared limiter degrades to "no distributed
 * limit for the duration of the outage", which is strictly better than turning
 * a cache outage into a login outage.
 */
export class RedisRateLimitStore implements Store {
  public readonly localKeys = false;
  private windowMs = 60_000;
  private readonly keyPrefix: string;

  constructor(private readonly redis: RateLimitRedis, bucket: string) {
    this.keyPrefix = `rl:${bucket}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private redisKey(key: string): string {
    return this.keyPrefix + key;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const redisKey = this.redisKey(key);
    try {
      const totalHits = await this.redis.incr(redisKey);
      // Only the request that creates the counter arms its expiry, so a busy
      // key is not perpetually renewed into never expiring.
      if (totalHits === 1) {
        await this.redis.pexpire(redisKey, this.windowMs);
      }
      let ttl = await this.redis.pttl(redisKey);
      // -1 (no expiry) or -2 (missing) both mean the window is unknown; re-arm
      // it so a counter can never get stuck without a reset time.
      if (ttl < 0) {
        await this.redis.pexpire(redisKey, this.windowMs);
        ttl = this.windowMs;
      }
      return { totalHits, resetTime: new Date(Date.now() + ttl) };
    } catch {
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.redis.decr(this.redisKey(key));
    } catch {
      /* fail open */
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await this.redis.del(this.redisKey(key));
    } catch {
      /* fail open */
    }
  }
}

/**
 * Returns a store for a named limiter bucket, or `undefined` when no Redis is
 * configured -- in which case `express-rate-limit` uses its built-in
 * MemoryStore and behaviour is identical to before W5.
 */
export function rateLimitStore(bucket: string): Store | undefined {
  const redis = getRedis();
  if (!redis) return undefined;
  return new RedisRateLimitStore(redis, bucket);
}
