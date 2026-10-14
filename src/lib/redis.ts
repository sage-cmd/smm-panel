import Redis, { RedisOptions } from "ioredis";
import { env } from "../config/env";
import { logger } from "./logger";

export const redisOptions: RedisOptions = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
};

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(redisOptions);

    redisClient.on("error", (err) => {
      // Log warning rather than unhandled exception if Redis is unavailable during local tests
      logger.warn(`Redis connection issue: ${err.message}`);
    });
  }
  return redisClient;
}

/**
 * Pings Redis with a timeout to check connectivity health.
 */
export async function isRedisHealthy(): Promise<boolean> {
  try {
    const client = getRedisClient();
    if (client.status === "wait") {
      await client.connect();
    }
    const pong = await client.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

/**
 * Cleanly disconnects Redis client.
 */
export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
      logger.info("Redis connection cleanly disconnected.");
    } catch (err) {
      logger.warn(`Error disconnecting Redis: ${err}`);
    } finally {
      redisClient = null;
    }
  }
}
