import { PrismaClient } from '@prisma/client';
import type { Logger } from './logger.js';

export function createPrismaClient(logger: Logger): PrismaClient {
  const client = new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
  });

  client.$on('error' as never, (e: { message: string }) => {
    logger.error({ msg: e.message }, 'Prisma error');
  });

  client.$on('warn' as never, (e: { message: string }) => {
    logger.warn({ msg: e.message }, 'Prisma warning');
  });

  return client;
}
