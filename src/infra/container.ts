import type { PrismaClient } from '@prisma/client';
import type { RedisClient } from './redis.js';
import type { Logger } from './logger.js';
import type { SolanaContext } from './solana.js';
import type { RiskParameters } from '../types/risk.js';

export interface Container {
  logger: Logger;
  db: PrismaClient;
  redis: RedisClient;
  solana: SolanaContext;
  riskParams: RiskParameters;
}
