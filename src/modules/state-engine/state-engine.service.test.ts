import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { StateEngine } from './state-engine.service.js';
import type { Container } from '../../infra/container.js';
import type { EventBus } from '../../services/event-bus.js';
import type { DevWalletEvent } from '../../types/events.js';

function createMockContainer(): Container {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Container['logger'],
    db: {
      position: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as Container['db'],
    redis: {
      set: vi.fn().mockResolvedValue('OK'),
    } as unknown as Container['redis'],
    solana: {} as Container['solana'],
    riskParams: {
      maxPositionSizeSol: 1,
      maxSlippageBps: 300,
      maxPriorityFeeLamports: 100000,
      executionCooldownMs: 5000,
    },
  };
}

function createMockEventBus(): EventBus {
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  return {
    on: vi.fn(),
    onType: vi.fn((type: string, handler: (event: unknown) => void) => {
      const existing = handlers.get(type) ?? [];
      existing.push(handler);
      handlers.set(type, existing);
    }),
    emit: vi.fn(),
    off: vi.fn(),
    _handlers: handlers,
  } as unknown as EventBus & { _handlers: Map<string, Array<(event: unknown) => void>> };
}

describe('StateEngine', () => {
  let engine: StateEngine;
  let mockContainer: Container;
  let mockEventBus: ReturnType<typeof createMockEventBus>;

  beforeEach(async () => {
    mockContainer = createMockContainer();
    mockEventBus = createMockEventBus();
    engine = new StateEngine(mockContainer, mockEventBus);
    await engine.start();
  });

  afterEach(async () => {
    await engine.stop();
  });

  describe('position management', () => {
    it('adds and retrieves positions', () => {
      engine.addPosition({
        id: 'p1',
        walletId: 'w1',
        trackedTokenId: 't1',
        mintAddress: 'mint1',
        entryAmountSol: 0.5,
        tokenBalance: BigInt(1000000),
        entryPrice: 0.001,
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
      });

      const pos = engine.getPosition('p1');
      expect(pos).toBeDefined();
      expect(pos!.mintAddress).toBe('mint1');
      expect(pos!.tokenBalance).toBe(BigInt(1000000));
    });

    it('returns undefined for non-existent position', () => {
      expect(engine.getPosition('nonexistent')).toBeUndefined();
    });

    it('updates position fields', () => {
      engine.addPosition({
        id: 'p2',
        walletId: 'w1',
        trackedTokenId: 't1',
        mintAddress: 'mint1',
        entryAmountSol: 0.5,
        tokenBalance: BigInt(1000000),
        entryPrice: null,
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
      });

      engine.updatePosition('p2', {
        tokenBalance: BigInt(500000),
        status: 'CLOSING',
      });

      const pos = engine.getPosition('p2');
      expect(pos!.tokenBalance).toBe(BigInt(500000));
      expect(pos!.status).toBe('CLOSING');
    });

    it('filters open positions', () => {
      engine.addPosition({
        id: 'p1',
        walletId: 'w1',
        trackedTokenId: 't1',
        mintAddress: 'mint1',
        entryAmountSol: 0.5,
        tokenBalance: BigInt(1000),
        entryPrice: null,
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
      });

      engine.addPosition({
        id: 'p2',
        walletId: 'w1',
        trackedTokenId: 't2',
        mintAddress: 'mint2',
        entryAmountSol: 0.3,
        tokenBalance: BigInt(0),
        entryPrice: null,
        status: 'CLOSED',
        openedAt: new Date(),
        closedAt: new Date(),
      });

      const open = engine.getOpenPositions();
      expect(open).toHaveLength(1);
      expect(open[0]!.id).toBe('p1');
    });

    it('filters positions by mint address', () => {
      engine.addPosition({
        id: 'p1',
        walletId: 'w1',
        trackedTokenId: 't1',
        mintAddress: 'mint1',
        entryAmountSol: 0.5,
        tokenBalance: BigInt(1000),
        entryPrice: null,
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
      });

      engine.addPosition({
        id: 'p2',
        walletId: 'w1',
        trackedTokenId: 't2',
        mintAddress: 'mint2',
        entryAmountSol: 0.3,
        tokenBalance: BigInt(500),
        entryPrice: null,
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
      });

      const result = engine.getPositionsByMint('mint1');
      expect(result).toHaveLength(1);
      expect(result[0]!.mintAddress).toBe('mint1');
    });
  });

  describe('dev wallet metrics', () => {
    it('tracks dev sells via event handler', () => {
      // Trigger the handler that was registered with onType
      const handlers = mockEventBus._handlers.get('DEV_WALLET_SELL') ?? [];
      expect(handlers.length).toBeGreaterThan(0);

      const event: DevWalletEvent = {
        id: 'e1',
        type: 'DEV_WALLET_SELL',
        timestamp: Date.now(),
        slot: 100,
        signature: 'sig1',
        devWallet: 'dev1',
        mintAddress: 'mint1',
        amount: '5000',
        percentageOfHoldings: 25,
      };

      handlers[0]!(event);

      const metrics = engine.getDevMetrics('mint1', 'dev1');
      expect(metrics).toBeDefined();
      expect(metrics!.totalSellCount).toBe(1);
      expect(metrics!.totalSellPercentage).toBe(25);
    });

    it('accumulates multiple sells', () => {
      const handlers = mockEventBus._handlers.get('DEV_WALLET_SELL') ?? [];

      const sell1: DevWalletEvent = {
        id: 'e1',
        type: 'DEV_WALLET_SELL',
        timestamp: Date.now(),
        slot: 100,
        signature: 'sig1',
        devWallet: 'dev1',
        mintAddress: 'mint1',
        amount: '3000',
        percentageOfHoldings: 15,
      };

      const sell2: DevWalletEvent = {
        id: 'e2',
        type: 'DEV_WALLET_SELL',
        timestamp: Date.now(),
        slot: 101,
        signature: 'sig2',
        devWallet: 'dev1',
        mintAddress: 'mint1',
        amount: '4000',
        percentageOfHoldings: 20,
      };

      handlers[0]!(sell1);
      handlers[0]!(sell2);

      const metrics = engine.getDevMetrics('mint1', 'dev1');
      expect(metrics!.totalSellCount).toBe(2);
      expect(metrics!.totalSellPercentage).toBe(35);
    });

    it('calculates sell percentage within window', () => {
      const handlers = mockEventBus._handlers.get('DEV_WALLET_SELL') ?? [];

      const now = Date.now();

      const oldSell: DevWalletEvent = {
        id: 'e1',
        type: 'DEV_WALLET_SELL',
        timestamp: now - 120_000, // 2 minutes ago
        slot: 100,
        signature: 'sig1',
        devWallet: 'dev1',
        mintAddress: 'mint1',
        amount: '1000',
        percentageOfHoldings: 10,
      };

      const recentSell: DevWalletEvent = {
        id: 'e2',
        type: 'DEV_WALLET_SELL',
        timestamp: now - 30_000, // 30 seconds ago
        slot: 200,
        signature: 'sig2',
        devWallet: 'dev1',
        mintAddress: 'mint1',
        amount: '2000',
        percentageOfHoldings: 20,
      };

      handlers[0]!(oldSell);
      handlers[0]!(recentSell);

      // 60 second window should only include the recent sell
      const pct = engine.getDevSellPercentageInWindow('mint1', 'dev1', 60_000);
      expect(pct).toBe(20);

      // 180 second window should include both
      const pctWide = engine.getDevSellPercentageInWindow('mint1', 'dev1', 180_000);
      expect(pctWide).toBe(30);
    });
  });
});
