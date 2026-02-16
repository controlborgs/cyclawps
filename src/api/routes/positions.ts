import { Transaction, PublicKey, ComputeBudgetProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../infra/container.js';
import type { PumpFunService } from '../../modules/pumpfun/pumpfun.service.js';
import type { StateEngine } from '../../modules/state-engine/state-engine.service.js';
import { createPositionSchema } from '../schemas.js';

export async function positionRoutes(
  app: FastifyInstance,
  container: Container,
  pumpfun: PumpFunService,
  stateEngine: StateEngine,
): Promise<void> {
  app.post('/positions', async (request, reply) => {
    const parsed = createPositionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.format(),
      });
    }

    const { db, solana, logger } = container;
    const input = parsed.data;
    const mint = new PublicKey(input.mintAddress);
    const owner = solana.keypair.publicKey;

    // Verify wallet exists
    const wallet = await db.wallet.findUnique({ where: { id: input.walletId } });
    if (!wallet) {
      return reply.status(404).send({ error: 'Wallet not found' });
    }

    // Find or create tracked token
    let trackedToken = await db.trackedToken.findFirst({
      where: { mintAddress: input.mintAddress, walletId: input.walletId },
    });
    if (!trackedToken) {
      trackedToken = await db.trackedToken.create({
        data: {
          mintAddress: input.mintAddress,
          walletId: input.walletId,
          decimals: 6,
        },
      });
    }

    try {
      // Get bonding curve state + quote
      const curveState = await pumpfun.getBondingCurveState(mint);
      if (curveState.complete) {
        return reply.status(400).send({ error: 'Bonding curve is complete — use PumpSwap AMM' });
      }

      const solLamports = BigInt(Math.floor(input.solAmount * LAMPORTS_PER_SOL));
      const quote = pumpfun.calculateBuyQuote(curveState, solLamports);
      const maxSolCost = pumpfun.applySlippage(solLamports, input.maxSlippageBps, true);

      logger.info(
        {
          mint: input.mintAddress,
          solAmount: input.solAmount,
          estimatedTokens: quote.amountOut.toString(),
          maxSolCost: maxSolCost.toString(),
          priceImpactBps: quote.priceImpactBps,
        },
        'PumpFun buy quote',
      );

      // Build TX
      const instructions = [];

      if (input.priorityFeeLamports > 0) {
        instructions.push(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: input.priorityFeeLamports,
          }),
        );
      }
      instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
      );

      // Ensure ATA exists
      const ata = getAssociatedTokenAddressSync(mint, owner);
      const ataInfo = await solana.connection.getAccountInfo(ata);
      if (!ataInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(owner, ata, owner, mint, TOKEN_PROGRAM_ID),
        );
      }

      const buyIx = await pumpfun.buildBuyInstruction(
        mint,
        owner,
        quote.amountOut,
        maxSolCost,
      );
      instructions.push(buyIx);

      const { blockhash, lastValidBlockHeight } =
        await solana.connection.getLatestBlockhash('confirmed');

      const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight });
      for (const ix of instructions) {
        tx.add(ix);
      }

      // Simulate
      tx.sign(solana.keypair);
      const sim = await solana.connection.simulateTransaction(tx);
      if (sim.value.err) {
        return reply.status(400).send({
          error: 'Simulation failed',
          details: JSON.stringify(sim.value.err),
          logs: sim.value.logs,
        });
      }

      // Send
      const signature = await solana.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });

      await solana.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );

      // Persist position
      const entryPrice = Number(solLamports) / Number(quote.amountOut);

      const position = await db.position.create({
        data: {
          walletId: input.walletId,
          trackedTokenId: trackedToken.id,
          mintAddress: input.mintAddress,
          entryAmountSol: input.solAmount,
          tokenBalance: quote.amountOut.toString(),
          entryPrice,
          status: 'OPEN',
        },
      });

      // Add to state engine
      stateEngine.addPosition({
        id: position.id,
        walletId: position.walletId,
        trackedTokenId: position.trackedTokenId,
        mintAddress: position.mintAddress,
        entryAmountSol: position.entryAmountSol,
        tokenBalance: BigInt(position.tokenBalance),
        entryPrice: position.entryPrice,
        status: 'OPEN',
        openedAt: position.openedAt,
        closedAt: null,
      });

      logger.info(
        {
          positionId: position.id,
          mint: input.mintAddress,
          solAmount: input.solAmount,
          tokensReceived: quote.amountOut.toString(),
          txSignature: signature,
        },
        'Position opened via PumpFun',
      );

      return reply.status(201).send({
        ...position,
        txSignature: signature,
        estimatedTokens: quote.amountOut.toString(),
        priceImpactBps: quote.priceImpactBps,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, mint: input.mintAddress }, 'Failed to open position');
      return reply.status(500).send({ error: msg });
    }
  });

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
