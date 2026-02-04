import { Redis } from 'ioredis';
import type { Logger } from './logger.js';

export type RedisClient = Redis;

export function createRedisClient(url: string, logger: Logger): RedisClient {
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 5000);
      return delay;
    },
    lazyConnect: true,
  });

  client.on('connect', () => {
    logger.info('Redis connected');
  });

  client.on('error', (err: Error) => {
    logger.error({ err }, 'Redis error');
  });

  client.on('close', () => {
    logger.warn('Redis connection closed');
  });

  return client;
}
