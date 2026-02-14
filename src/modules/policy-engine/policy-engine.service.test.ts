import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PolicyEngine } from './policy-engine.service.js';
import type { Container } from '../../infra/container.js';
import type { StateEngine } from '../state-engine/state-engine.service.js';
import type { EventBus } from '../../services/event-bus.js';
import type { DevWalletEvent, LPEvent, SupplyChangeEvent } from '../../types/events.js';
import type { PolicyDefinition } from '../../types/policy.js';

function createMockContainer(): Container {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn(),
    } as unknown as Container['logger'],
    db: {
      policy: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as Container['db'],
    redis: {} as Container['redis'],
    solana: {} as Container['solana'],
    riskParams: {
      maxPositionSizeSol: 1,
      maxSlippageBps: 300,
      maxPriorityFeeLamports: 100000,
      executionCooldownMs: 5000,
    },
  };
}

function createMockStateEngine(): StateEngine {
  return {
    getDevSellPercentageInWindow: vi.fn().mockReturnValue(0),
    getDevMetrics: vi.fn().mockReturnValue(null),
    getLPState: vi.fn().mockReturnValue(null),
    getPosition: vi.fn().mockReturnValue(null),
    getOpenPositions: vi.fn().mockReturnValue([]),
    getPositionsByMint: vi.fn().mockReturnValue([]),
  } as unknown as StateEngine;
}

function createMockEventBus(): EventBus {
  return {
    on: vi.fn(),
    onType: vi.fn(),
    emit: vi.fn(),
    off: vi.fn(),
  } as unknown as EventBus;
}

describe('PolicyEngine', () => {
  let engine: PolicyEngine;
  let mockContainer: Container;
  let mockStateEngine: StateEngine;
  let mockEventBus: EventBus;

  beforeEach(() => {
    mockContainer = createMockContainer();
    mockStateEngine = createMockStateEngine();
    mockEventBus = createMockEventBus();
    engine = new PolicyEngine(mockContainer, mockStateEngine, mockEventBus);
  });

  describe('evaluatePolicy', () => {
    it('triggers DEV_SELL_PERCENTAGE when threshold exceeded', () => {
      const policy: PolicyDefinition = {
        id: 'p1',
        name: 'Dev sell guard',
        trigger: 'DEV_SELL_PERCENTAGE',
        threshold: 30,
        windowSeconds: 600,
        action: 'EXIT_POSITION',
        priority: 1,
        isActive: true,
      };

      vi.mocked(mockStateEngine.getDevSellPercentageInWindow).mockReturnValue(35);

      const event: DevWalletEvent = {
        id: 'e1',
        type: 'DEV_WALLET_SELL',
        timestamp: Date.now(),
        slot: 100,
        signature: 'sig1',
        devWallet: 'devAddr',
        mintAddress: 'mintAddr',
        amount: '1000',
        percentageOfHoldings: 35,
      };

      const result = engine.evaluatePolicy(policy, event);

      expect(result).not.toBeNull();
      expect(result!.triggered).toBe(true);
      expect(result!.action).toBe('EXIT_POSITION');
      expect(result!.triggerValue).toBe(35);
    });

    it('does not trigger DEV_SELL_PERCENTAGE when below threshold', () => {
      const policy: PolicyDefinition = {
        id: 'p1',
        name: 'Dev sell guard',
        trigger: 'DEV_SELL_PERCENTAGE',
        threshold: 30,
        windowSeconds: 600,
        action: 'EXIT_POSITION',
        priority: 1,
        isActive: true,
      };

      vi.mocked(mockStateEngine.getDevSellPercentageInWindow).mockReturnValue(10);

      const event: DevWalletEvent = {
        id: 'e1',
        type: 'DEV_WALLET_SELL',
        timestamp: Date.now(),
        slot: 100,
        signature: 'sig1',
        devWallet: 'devAddr',
        mintAddress: 'mintAddr',
        amount: '500',
        percentageOfHoldings: 10,
      };

      const result = engine.evaluatePolicy(policy, event);

      expect(result).not.toBeNull();
      expect(result!.triggered).toBe(false);
    });

    it('triggers DEV_SELL_COUNT when threshold met', () => {
      const policy: PolicyDefinition = {
        id: 'p2',
        name: 'Dev sell count guard',
        trigger: 'DEV_SELL_COUNT',
        threshold: 5,
        action: 'PARTIAL_SELL',
        priority: 0,
        isActive: true,
      };

      vi.mocked(mockStateEngine.getDevMetrics).mockReturnValue({
        mintAddress: 'mint',
        devWallet: 'dev',
        totalSellCount: 6,
        totalSellPercentage: 45,
        recentSells: [],
        lastUpdated: Date.now(),
      });

      const event: DevWalletEvent = {
        id: 'e2',
        type: 'DEV_WALLET_SELL',
        timestamp: Date.now(),
        slot: 200,
        signature: 'sig2',
        devWallet: 'dev',
        mintAddress: 'mint',
        amount: '100',
        percentageOfHoldings: 5,
      };

      const result = engine.evaluatePolicy(policy, event);

      expect(result).not.toBeNull();
      expect(result!.triggered).toBe(true);
      expect(result!.action).toBe('PARTIAL_SELL');
    });

    it('triggers LP_REMOVAL_PERCENTAGE when threshold exceeded', () => {
      const policy: PolicyDefinition = {
        id: 'p3',
        name: 'LP removal guard',
        trigger: 'LP_REMOVAL_PERCENTAGE',
        threshold: 50,
        action: 'EXIT_POSITION',
        priority: 2,
        isActive: true,
      };

      vi.mocked(mockStateEngine.getLPState).mockReturnValue({
        poolAddress: 'pool1',
        mintAddress: 'mint1',
        totalLiquidity: BigInt(1000),
        removals: [],
        totalRemovedPercentage: 60,
      });

      const event: LPEvent = {
        id: 'e3',
        type: 'LP_REMOVE',
        timestamp: Date.now(),
        slot: 300,
        signature: 'sig3',
        poolAddress: 'pool1',
        mintAddress: 'mint1',
        liquidityAmount: '600',
        solAmount: '100',
        tokenAmount: '500',
      };

      const result = engine.evaluatePolicy(policy, event);

      expect(result).not.toBeNull();
      expect(result!.triggered).toBe(true);
    });

    it('triggers SUPPLY_INCREASE when supply grows beyond threshold', () => {
      const policy: PolicyDefinition = {
        id: 'p4',
        name: 'Supply inflation guard',
        trigger: 'SUPPLY_INCREASE',
        threshold: 10,
        action: 'HALT_STRATEGY',
        priority: 3,
        isActive: true,
      };

      const event: SupplyChangeEvent = {
        id: 'e4',
        type: 'SUPPLY_CHANGE',
        timestamp: Date.now(),
        slot: 400,
        signature: 'sig4',
        mintAddress: 'mint2',
        previousSupply: '1000000',
        newSupply: '1200000',
        changePercentage: 20,
      };

      const result = engine.evaluatePolicy(policy, event);

      expect(result).not.toBeNull();
      expect(result!.triggered).toBe(true);
      expect(result!.action).toBe('HALT_STRATEGY');
    });

    it('returns null for irrelevant event types', () => {
      const policy: PolicyDefinition = {
        id: 'p5',
        name: 'Dev sell guard',
        trigger: 'DEV_SELL_PERCENTAGE',
        threshold: 30,
        action: 'EXIT_POSITION',
        priority: 0,
        isActive: true,
      };

      const event: SupplyChangeEvent = {
        id: 'e5',
        type: 'SUPPLY_CHANGE',
        timestamp: Date.now(),
        slot: 500,
        signature: 'sig5',
        mintAddress: 'mint3',
        previousSupply: '100',
        newSupply: '110',
        changePercentage: 10,
      };

      const result = engine.evaluatePolicy(policy, event);
      expect(result).toBeNull();
    });
  });

  describe('evaluateEvent', () => {
    it('returns all triggered policies sorted by priority', async () => {
      const policies: PolicyDefinition[] = [
        {
          id: 'p1',
          name: 'Low priority',
          trigger: 'DEV_SELL_PERCENTAGE',
          threshold: 10,
          windowSeconds: 600,
          action: 'ALERT_ONLY',
          priority: 0,
          isActive: true,
        },
        {
          id: 'p2',
          name: 'High priority',
          trigger: 'DEV_SELL_PERCENTAGE',
          threshold: 10,
          windowSeconds: 600,
          action: 'EXIT_POSITION',
          priority: 10,
          isActive: true,
        },
      ];

      // Access private field for testing
      (engine as unknown as { policies: PolicyDefinition[] }).policies = policies;

      vi.mocked(mockStateEngine.getDevSellPercentageInWindow).mockReturnValue(50);

      const event: DevWalletEvent = {
        id: 'e1',
        type: 'DEV_WALLET_SELL',
        timestamp: Date.now(),
        slot: 100,
        signature: 'sig',
        devWallet: 'dev',
        mintAddress: 'mint',
        amount: '1000',
        percentageOfHoldings: 50,
      };

      const results = await engine.evaluateEvent(event);

      expect(results).toHaveLength(2);
      expect(results[0]!.policyId).toBe('p2'); // Higher priority first
      expect(results[1]!.policyId).toBe('p1');
    });

    it('skips inactive policies', async () => {
      const policies: PolicyDefinition[] = [
        {
          id: 'p1',
          name: 'Inactive',
          trigger: 'DEV_SELL_PERCENTAGE',
          threshold: 1,
          action: 'EXIT_POSITION',
          priority: 0,
          isActive: false,
        },
      ];

      (engine as unknown as { policies: PolicyDefinition[] }).policies = policies;

      const event: DevWalletEvent = {
        id: 'e1',
        type: 'DEV_WALLET_SELL',
        timestamp: Date.now(),
        slot: 100,
        signature: 'sig',
        devWallet: 'dev',
        mintAddress: 'mint',
        amount: '1000',
        percentageOfHoldings: 50,
      };

      const results = await engine.evaluateEvent(event);
      expect(results).toHaveLength(0);
    });
  });
});
