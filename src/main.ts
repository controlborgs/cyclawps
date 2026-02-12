import { env } from './config/env.js';
import {
  createLogger,
  createRedisClient,
  createPrismaClient,
  createSolanaContext,
  checkRpcHealth,
} from './infra/index.js';
import type { Container } from './infra/container.js';
import { EventBus } from './services/event-bus.js';
import { EventIngestionService } from './modules/event-ingestion/index.js';
import { StateEngine } from './modules/state-engine/index.js';
import { PolicyEngine } from './modules/policy-engine/index.js';
import { RiskEngine } from './modules/risk-engine/index.js';
import { ExecutionEngine } from './modules/execution-engine/index.js';
import { Orchestrator } from './modules/orchestrator/index.js';
import { createServer } from './api/server.js';

async function main(): Promise<void> {
  const logger = createLogger({ LOG_LEVEL: env.LOG_LEVEL, NODE_ENV: env.NODE_ENV });
  logger.info('ClawOps starting');

  // Infrastructure
  const db = createPrismaClient(logger);
  await db.$connect();
  logger.info('Database connected');

  const redis = createRedisClient(env.REDIS_URL, logger);
  await redis.connect();
  logger.info('Redis connected');

  const solana = createSolanaContext(env, logger);
  await checkRpcHealth(solana.connection, logger);

  const container: Container = {
    logger,
    db,
    redis,
    solana,
    riskParams: {
      maxPositionSizeSol: env.MAX_POSITION_SIZE_SOL,
      maxSlippageBps: env.MAX_SLIPPAGE_BPS,
      maxPriorityFeeLamports: env.MAX_PRIORITY_FEE_LAMPORTS,
      executionCooldownMs: env.EXECUTION_COOLDOWN_MS,
    },
  };

  // Services
  const eventBus = new EventBus(logger);
  const stateEngine = new StateEngine(container, eventBus);
  const policyEngine = new PolicyEngine(container, stateEngine, eventBus);
  const riskEngine = new RiskEngine(container, stateEngine);
  const executionEngine = new ExecutionEngine(container, stateEngine, riskEngine);
  const eventIngestion = new EventIngestionService(container, eventBus);
  const orchestrator = new Orchestrator(
    container,
    eventBus,
    stateEngine,
    policyEngine,
    executionEngine,
  );

  // Start services in order
  await stateEngine.start();
  await policyEngine.start();
  await eventIngestion.start();
  await orchestrator.start();

  // API server
  const server = await createServer({ container, policyEngine, eventIngestion });
  await server.listen({ host: env.API_HOST, port: env.API_PORT });
  logger.info({ host: env.API_HOST, port: env.API_PORT }, 'API server listening');

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');

    await server.close();
    await orchestrator.stop();
    await eventIngestion.stop();
    await policyEngine.stop();
    await stateEngine.stop();
    await riskEngine.stop();
    await executionEngine.stop();

    redis.disconnect();
    await db.$disconnect();

    logger.info('ClawOps shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });

  logger.info('ClawOps fully operational');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
