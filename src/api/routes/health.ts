import type { FastifyInstance } from 'fastify';
import type { Container } from '../../infra/container.js';

export async function healthRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.get('/health', async (_request, reply) => {
    try {
      // Check database
      await container.db.$queryRaw`SELECT 1`;

      // Check Redis
      const redisPing = await container.redis.ping();

      // Check Solana RPC
      const slot = await container.solana.connection.getSlot();

      return reply.send({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'ok',
          redis: redisPing === 'PONG' ? 'ok' : 'degraded',
          solanaRpc: { status: 'ok', slot },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      container.logger.error({ err }, 'Health check failed');
      return reply.status(503).send({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: message,
      });
    }
  });
}
