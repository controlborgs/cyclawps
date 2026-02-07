import type { Container } from '../../infra/container.js';
import type { EventBus } from '../../services/event-bus.js';
import type { PositionState } from '../../types/position.js';
import type { InternalEvent, DevWalletEvent } from '../../types/events.js';

interface DevWalletMetrics {
  mintAddress: string;
  devWallet: string;
  totalSellCount: number;
  totalSellPercentage: number;
  recentSells: Array<{ timestamp: number; percentage: number; slot: number }>;
  lastUpdated: number;
}

interface LPState {
  poolAddress: string;
  mintAddress: string;
  totalLiquidity: bigint;
  removals: Array<{ timestamp: number; amount: string; slot: number }>;
  totalRemovedPercentage: number;
}

export class StateEngine {
  private readonly container: Container;
  private readonly eventBus: EventBus;
  private readonly positions: Map<string, PositionState> = new Map();
  private readonly devMetrics: Map<string, DevWalletMetrics> = new Map();
  private readonly lpStates: Map<string, LPState> = new Map();
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;

  constructor(container: Container, eventBus: EventBus) {
    this.container = container;
    this.eventBus = eventBus;
  }

  async start(): Promise<void> {
    const { logger, db } = this.container;
    logger.info('Starting state engine');

    const openPositions = await db.position.findMany({
      where: { status: 'OPEN' },
    });

    for (const pos of openPositions) {
      this.positions.set(pos.id, {
        id: pos.id,
        walletId: pos.walletId,
        trackedTokenId: pos.trackedTokenId,
        mintAddress: pos.mintAddress,
        entryAmountSol: pos.entryAmountSol,
        tokenBalance: BigInt(pos.tokenBalance),
        entryPrice: pos.entryPrice,
        status: pos.status as PositionState['status'],
        openedAt: pos.openedAt,
        closedAt: pos.closedAt,
      });
    }

    this.eventBus.onType('DEV_WALLET_SELL', (event) => {
      this.handleDevSell(event as DevWalletEvent);
    });

    this.eventBus.onType('LP_REMOVE', (event) => {
      this.handleLPRemoval(event);
    });

    this.snapshotInterval = setInterval(() => {
      this.persistSnapshot().catch((err) => {
        logger.error({ err }, 'Failed to persist state snapshot');
      });
    }, 30_000);

    logger.info({ positionCount: this.positions.size }, 'State engine started');
  }

  private handleDevSell(event: DevWalletEvent): void {
    const key = `${event.mintAddress}:${event.devWallet}`;
    const existing = this.devMetrics.get(key);

    if (existing) {
      existing.totalSellCount += 1;
      existing.totalSellPercentage += event.percentageOfHoldings;
      existing.recentSells.push({
        timestamp: event.timestamp,
        percentage: event.percentageOfHoldings,
        slot: event.slot,
      });
      // Keep only last 100 sells
      if (existing.recentSells.length > 100) {
        existing.recentSells = existing.recentSells.slice(-100);
      }
      existing.lastUpdated = Date.now();
    } else {
      this.devMetrics.set(key, {
        mintAddress: event.mintAddress,
        devWallet: event.devWallet,
        totalSellCount: 1,
        totalSellPercentage: event.percentageOfHoldings,
        recentSells: [
          { timestamp: event.timestamp, percentage: event.percentageOfHoldings, slot: event.slot },
        ],
        lastUpdated: Date.now(),
      });
    }

    this.container.logger.info(
      {
        devWallet: event.devWallet,
        mint: event.mintAddress,
        sellPct: event.percentageOfHoldings,
        totalPct: this.devMetrics.get(key)?.totalSellPercentage,
      },
      'Dev wallet sell recorded',
    );
  }

  private handleLPRemoval(event: InternalEvent): void {
    if (event.type !== 'LP_REMOVE') return;

    const key = event.poolAddress;
    const existing = this.lpStates.get(key);

    if (existing) {
      existing.removals.push({
        timestamp: event.timestamp,
        amount: event.liquidityAmount,
        slot: event.slot,
      });
      existing.totalRemovedPercentage += parseFloat(event.liquidityAmount);
    } else {
      this.lpStates.set(key, {
        poolAddress: event.poolAddress,
        mintAddress: event.mintAddress,
        totalLiquidity: BigInt(0),
        removals: [
          { timestamp: event.timestamp, amount: event.liquidityAmount, slot: event.slot },
        ],
        totalRemovedPercentage: parseFloat(event.liquidityAmount),
      });
    }
  }

  getPosition(positionId: string): PositionState | undefined {
    return this.positions.get(positionId);
  }

  getOpenPositions(): PositionState[] {
    return Array.from(this.positions.values()).filter((p) => p.status === 'OPEN');
  }

  getPositionsByMint(mintAddress: string): PositionState[] {
    return Array.from(this.positions.values()).filter(
      (p) => p.mintAddress === mintAddress && p.status === 'OPEN',
    );
  }

  getDevMetrics(mintAddress: string, devWallet: string): DevWalletMetrics | undefined {
    return this.devMetrics.get(`${mintAddress}:${devWallet}`);
  }

  getDevSellPercentageInWindow(
    mintAddress: string,
    devWallet: string,
    windowMs: number,
  ): number {
    const metrics = this.devMetrics.get(`${mintAddress}:${devWallet}`);
    if (!metrics) return 0;

    const cutoff = Date.now() - windowMs;
    return metrics.recentSells
      .filter((s) => s.timestamp >= cutoff)
      .reduce((sum, s) => sum + s.percentage, 0);
  }

  getLPState(poolAddress: string): LPState | undefined {
    return this.lpStates.get(poolAddress);
  }

  updatePosition(positionId: string, update: Partial<PositionState>): void {
    const existing = this.positions.get(positionId);
    if (existing) {
      Object.assign(existing, update);
    }
  }

  addPosition(position: PositionState): void {
    this.positions.set(position.id, position);
  }

  private async persistSnapshot(): Promise<void> {
    const { redis, logger } = this.container;

    const snapshot = {
      positions: Array.from(this.positions.entries()).map(([_key, pos]) => ({
        ...pos,
        tokenBalance: pos.tokenBalance.toString(),
      })),
      devMetrics: Array.from(this.devMetrics.entries()),
      timestamp: Date.now(),
    };

    await redis.set('clawops:state:snapshot', JSON.stringify(snapshot), 'EX', 300);
    logger.debug({ positionCount: this.positions.size }, 'State snapshot persisted');
  }

  async stop(): Promise<void> {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }
    await this.persistSnapshot();
    this.container.logger.info('State engine stopped');
  }
}
