import type { FastifyInstance } from 'fastify';
import type { Container } from '../../infra/container.js';

export async function positionRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.get('/positions', async (request, reply) => {
    const { status, walletId } = request.query as {
      status?: string;
      walletId?: string;
    };

    const where: Record<string, unknown> = {};
    if (status) where['status'] = status;
    if (walletId) where['walletId'] = walletId;

    const positions = await container.db.position.findMany({
      where,
      include: {
        trackedToken: { select: { mintAddress: true, symbol: true } },
        wallet: { select: { address: true, label: true } },
      },
      orderBy: { openedAt: 'desc' },
    });

    return reply.send(positions);
  });

  app.get('/positions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    const position = await container.db.position.findUnique({
      where: { id },
      include: {
        trackedToken: true,
        wallet: true,
        executions: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!position) {
      return reply.status(404).send({ error: 'Position not found' });
    }

    return reply.send(position);
  });
}
