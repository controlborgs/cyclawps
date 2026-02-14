import type { FastifyInstance } from 'fastify';
import type { Container } from '../../infra/container.js';

export async function executionRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.get('/executions', async (request, reply) => {
    const { status, positionId, limit } = request.query as {
      status?: string;
      positionId?: string;
      limit?: string;
    };

    const where: Record<string, unknown> = {};
    if (status) where['status'] = status;
    if (positionId) where['positionId'] = positionId;

    const executions = await container.db.execution.findMany({
      where,
      include: {
        position: { select: { mintAddress: true, status: true } },
        policy: { select: { name: true, trigger: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit ? parseInt(limit, 10) : 50,
    });

    return reply.send(executions);
  });

  app.get('/executions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const execution = await container.db.execution.findUnique({
      where: { id },
      include: {
        position: true,
        policy: true,
      },
    });

    if (!execution) {
      return reply.status(404).send({ error: 'Execution not found' });
    }

    return reply.send(execution);
  });
}
