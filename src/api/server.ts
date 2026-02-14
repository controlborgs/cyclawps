import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Container } from '../infra/container.js';
import type { PolicyEngine } from '../modules/policy-engine/policy-engine.service.js';
import type { EventIngestionService } from '../modules/event-ingestion/event-ingestion.service.js';
import { healthRoutes } from './routes/health.js';
import { policyRoutes } from './routes/policies.js';
import { positionRoutes } from './routes/positions.js';
import { executionRoutes } from './routes/executions.js';
import { walletRoutes } from './routes/wallets.js';

export interface ServerDeps {
  container: Container;
  policyEngine: PolicyEngine;
  eventIngestion: EventIngestionService;
}

export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { container, policyEngine, eventIngestion } = deps;

  const app = Fastify({
    logger: false, // We use our own Pino instance
    requestTimeout: 30_000,
    bodyLimit: 1_048_576, // 1MB
  });

  // Rate limiting
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // Request logging
  app.addHook('onRequest', async (request) => {
    container.logger.debug(
      { method: request.method, url: request.url },
      'Incoming request',
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    container.logger.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request completed',
    );
  });

  // Error handler
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    container.logger.error({ err: error }, 'Unhandled route error');
    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: error.message,
      statusCode,
    });
  });

  // Register routes
  await healthRoutes(app, container);
  await policyRoutes(app, container, policyEngine);
  await positionRoutes(app, container);
  await executionRoutes(app, container);
  await walletRoutes(app, container, eventIngestion);

  return app;
}
