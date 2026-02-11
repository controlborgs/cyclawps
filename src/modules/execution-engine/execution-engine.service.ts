import {
  Transaction,
  PublicKey,
  ComputeBudgetProgram,
  type TransactionInstruction,
  type SendOptions,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createCloseAccountInstruction,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../infra/container.js';
import type { StateEngine } from '../state-engine/state-engine.service.js';
import type { RiskEngine } from '../risk-engine/risk-engine.service.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  SimulationResult,
} from '../../types/execution.js';

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

export class ExecutionEngine {
  private readonly container: Container;
  private readonly stateEngine: StateEngine;
  private readonly riskEngine: RiskEngine;

  constructor(container: Container, stateEngine: StateEngine, riskEngine: RiskEngine) {
    this.container = container;
    this.stateEngine = stateEngine;
    this.riskEngine = riskEngine;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const { logger } = this.container;
    const executionId = randomUUID();

    logger.info(
      {
        executionId,
        positionId: request.positionId,
        action: request.action,
        sellPct: request.sellPercentage,
      },
      'Execution requested',
    );

    // Risk check
    const riskCheck = this.riskEngine.evaluate(request);
    if (!riskCheck.approved) {
      logger.warn(
        { executionId, violations: riskCheck.violations },
        'Execution rejected by risk engine',
      );

      const result: ExecutionResult = {
        id: executionId,
        status: 'FAILED',
        txSignature: null,
        amountIn: null,
        amountOut: null,
        errorMessage: `Risk violations: ${riskCheck.violations.map((v) => v.message).join('; ')}`,
        simulationResult: null,
        completedAt: new Date(),
      };

      await this.persistExecution(executionId, request, result);
      return result;
    }

    // Build transaction
    const position = this.stateEngine.getPosition(request.positionId);
    if (!position) {
      const result: ExecutionResult = {
        id: executionId,
        status: 'FAILED',
        txSignature: null,
        amountIn: null,
        amountOut: null,
        errorMessage: `Position ${request.positionId} not found`,
        simulationResult: null,
        completedAt: new Date(),
      };
      await this.persistExecution(executionId, request, result);
      return result;
    }

    try {
      const sellAmount =
        (position.tokenBalance * BigInt(Math.floor(request.sellPercentage))) / BigInt(100);

      const transaction = await this.buildSellTransaction(
        position.mintAddress,
        sellAmount,
        request.priorityFeeLamports,
      );

      // Simulate
      const simulation = await this.simulateTransaction(transaction);
      if (!simulation.success) {
        const result: ExecutionResult = {
          id: executionId,
          status: 'FAILED',
          txSignature: null,
          amountIn: sellAmount.toString(),
          amountOut: null,
          errorMessage: `Simulation failed: ${simulation.error}`,
          simulationResult: simulation,
          completedAt: new Date(),
        };
        await this.persistExecution(executionId, request, result);
        return result;
      }

      // Send with retries
      const txSignature = await this.sendWithRetries(transaction);

      // Update state
      const newBalance = position.tokenBalance - sellAmount;
      this.stateEngine.updatePosition(position.id, {
        tokenBalance: newBalance,
        status: newBalance === BigInt(0) ? 'CLOSED' : 'OPEN',
        closedAt: newBalance === BigInt(0) ? new Date() : null,
      });

      const result: ExecutionResult = {
        id: executionId,
        status: 'CONFIRMED',
        txSignature,
        amountIn: sellAmount.toString(),
        amountOut: null,
        errorMessage: null,
        simulationResult: simulation,
        completedAt: new Date(),
      };

      await this.persistExecution(executionId, request, result);
      await this.updatePositionInDb(position.id, newBalance);

      logger.info(
        { executionId, txSignature, amountIn: sellAmount.toString() },
        'Execution confirmed',
      );

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, executionId }, 'Execution failed');

      const result: ExecutionResult = {
        id: executionId,
        status: 'FAILED',
        txSignature: null,
        amountIn: null,
        amountOut: null,
        errorMessage: errorMsg,
        simulationResult: null,
        completedAt: new Date(),
      };

      await this.persistExecution(executionId, request, result);
      return result;
    }
  }

  private async buildSellTransaction(
    mintAddress: string,
    amount: bigint,
    priorityFeeLamports: number,
  ): Promise<Transaction> {
    const { connection, keypair } = this.container.solana;
    const mint = new PublicKey(mintAddress);
    const owner = keypair.publicKey;

    const sourceAta = await getAssociatedTokenAddress(mint, owner);

    const instructions: TransactionInstruction[] = [];

    // Priority fee
    if (priorityFeeLamports > 0) {
      instructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeLamports,
        }),
      );
      instructions.push(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 200_000,
        }),
      );
    }

    // For MVP: transfer tokens to a designated sell address
    // In production, this would integrate with Jupiter/Raydium swap
    // This demonstrates the transaction building pattern
    instructions.push(
      createTransferInstruction(
        sourceAta,
        sourceAta, // self-transfer for simulation purposes
        owner,
        amount,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );

    // If full exit, close the token account
    if (amount === BigInt(0)) {
      instructions.push(
        createCloseAccountInstruction(sourceAta, owner, owner, [], TOKEN_PROGRAM_ID),
      );
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    const transaction = new Transaction({
      feePayer: owner,
      blockhash,
      lastValidBlockHeight,
    });

    for (const ix of instructions) {
      transaction.add(ix);
    }

    return transaction;
  }

  private async simulateTransaction(transaction: Transaction): Promise<SimulationResult> {
    const { connection, keypair } = this.container.solana;

    transaction.sign(keypair);

    const result = await connection.simulateTransaction(transaction);

    return {
      success: result.value.err === null,
      unitsConsumed: result.value.unitsConsumed ?? 0,
      logs: result.value.logs ?? [],
      returnData: null,
      error: result.value.err ? JSON.stringify(result.value.err) : null,
    };
  }

  private async sendWithRetries(transaction: Transaction): Promise<string> {
    const { connection, keypair } = this.container.solana;
    const logger = this.container.logger;

    // Re-sign with fresh blockhash for each attempt
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.lastValidBlockHeight = lastValidBlockHeight;
        transaction.sign(keypair);

        const options: SendOptions = {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0,
        };

        const signature = await connection.sendRawTransaction(
          transaction.serialize(),
          options,
        );

        // Wait for confirmation
        const confirmation = await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        );

        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        return signature;
      } catch (err) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
        logger.warn(
          { attempt: attempt + 1, maxRetries: MAX_RETRIES, delay, err },
          'Transaction send failed, retrying',
        );

        if (attempt === MAX_RETRIES - 1) {
          throw err;
        }

        await this.sleep(delay);
      }
    }

    throw new Error('Max retries exceeded');
  }

  private async persistExecution(
    executionId: string,
    request: ExecutionRequest,
    result: ExecutionResult,
  ): Promise<void> {
    const { db, logger } = this.container;

    try {
      await db.execution.create({
        data: {
          id: executionId,
          positionId: request.positionId,
          policyId: request.policyId,
          action: request.action,
          txSignature: result.txSignature,
          status: result.status,
          amountIn: result.amountIn,
          amountOut: result.amountOut,
          slippageBps: request.maxSlippageBps,
          priorityFee: request.priorityFeeLamports.toString(),
          simulationResult: result.simulationResult ? JSON.parse(JSON.stringify(result.simulationResult)) : undefined,
          errorMessage: result.errorMessage,
          completedAt: result.completedAt,
        },
      });
    } catch (err) {
      logger.error({ err, executionId }, 'Failed to persist execution');
    }
  }

  private async updatePositionInDb(positionId: string, newBalance: bigint): Promise<void> {
    const { db, logger } = this.container;

    try {
      await db.position.update({
        where: { id: positionId },
        data: {
          tokenBalance: newBalance.toString(),
          status: newBalance === BigInt(0) ? 'CLOSED' : 'OPEN',
          closedAt: newBalance === BigInt(0) ? new Date() : null,
        },
      });
    } catch (err) {
      logger.error({ err, positionId }, 'Failed to update position in database');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async stop(): Promise<void> {
    this.container.logger.info('Execution engine stopped');
  }
}
