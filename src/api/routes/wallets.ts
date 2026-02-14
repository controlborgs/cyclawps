import type { FastifyInstance } from 'fastify';
import type { Container } from '../../infra/container.js';
import type { EventIngestionService } from '../../modules/event-ingestion/event-ingestion.service.js';
import { createWalletSchema, addTrackedTokenSchema } from '../schemas.js';

export async function walletRoutes(
  app: FastifyInstance,
  container: Container,
  eventIngestion: EventIngestionService,
): Promise<void> {
  app.post('/wallets', async (request, reply) => {
    const parsed = createWalletSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.format(),
      });
    }

    const { db } = container;
    const input = parsed.data;

    const existing = await db.wallet.findUnique({ where: { address: input.address } });
    if (existing) {
      return reply.status(409).send({ error: 'Wallet already tracked', wallet: existing });
    }

    const wallet = await db.wallet.create({
      data: {
        address: input.address,
        label: input.label ?? null,
      },
    });

    await eventIngestion.addWalletSubscription(wallet.address, wallet.label ?? undefined);

    container.logger.info({ walletId: wallet.id, address: wallet.address }, 'Wallet registered');

    return reply.status(201).send(wallet);
  });

  app.get('/wallets', async (_request, reply) => {
    const wallets = await container.db.wallet.findMany({
      include: {
        trackedTokens: { where: { isActive: true } },
        _count: { select: { positions: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send(wallets);
  });

  app.post('/wallets/:walletId/tokens', async (request, reply) => {
    const parsed = addTrackedTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.format(),
      });
    }

    const { db } = container;
    const input = parsed.data;

    const token = await db.trackedToken.create({
      data: {
        mintAddress: input.mintAddress,
        symbol: input.symbol ?? null,
        decimals: input.decimals,
        walletId: input.walletId,
        devWallet: input.devWallet ?? null,
      },
    });

    container.logger.info(
      { tokenId: token.id, mint: token.mintAddress },
      'Token tracking registered',
    );

    return reply.status(201).send(token);
  });
}
