import type { RedisOptions } from "ioredis";

/**
 * Connection options every Redis client in the API shares.
 *
 * `family: 0` is the important one. Railway's private network
 * (`*.railway.internal`) resolves to IPv6 ONLY, while ioredis defaults to
 * IPv4 lookups — so the hostname never resolves and the client retries
 * forever without ever reporting an error. Family 0 lets Node use whichever
 * record DNS actually returns, which keeps both Railway (IPv6) and local
 * Docker (IPv4) working from the same code.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ.
 */
export const redisOptions: RedisOptions = {
  family: 0,
  maxRetriesPerRequest: null,
  // Give up reconnecting eventually so a misconfigured URL surfaces in the
  // logs instead of retrying silently until someone notices no orders.
  retryStrategy: (attempt) => (attempt > 20 ? null : Math.min(attempt * 200, 3000)),
};
