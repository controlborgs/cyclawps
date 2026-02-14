import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RiskEngine } from './risk-engine.service.js';
import type { Container } from '../../infra/container.js';
import type { StateEngine } from '../state-engine/state-engine.service.js';
import type { ExecutionRequest } from '../../types/execution.js';

function createMockContainer(): Container {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Container['logger'],
    db: {} as Container['db'],
    redis: {} as Container['redis'],
    solana: {} as Container['solana'],
    riskParams: {
      maxPositionSizeSol: 1.0,
      maxSlippageBps: 300,
      maxPriorityFeeLamports: 100000,
      executionCooldownMs: 5000,
    },
  };
}

function createMockStateEngine(): StateEngine {
  return {
    getPosition: vi.fn().mockReturnValue({
      id: 'pos1',
      entryAmountSol: 0.5,
      tokenBalance: BigInt(1000000),
      status: 'OPEN',
    }),
  } as unknown as StateEngine;
}

describe('RiskEngine', () => {
  let engine: RiskEngine;
  let mockContainer: Container;
  let mockStateEngine: StateEngine;

  beforeEach(() => {
    mockContainer = createMockContainer();
    mockStateEngine = createMockStateEngine();
    engine = new RiskEngine(mockContainer, mockStateEngine);
  });

  const validRequest: ExecutionRequest = {
    positionId: 'pos1',
    policyId: 'pol1',
    action: 'FULL_EXIT',
    sellPercentage: 100,
    maxSlippageBps: 200,
    priorityFeeLamports: 50000,
  };

  it('approves valid execution request', () => {
    const result = engine.evaluate(validRequest);
    expect(result.approved).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects when slippage exceeds limit', () => {
    const request: ExecutionRequest = {
      ...validRequest,
      maxSlippageBps: 500,
    };

    const result = engine.evaluate(request);
    expect(result.approved).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule).toBe('MAX_SLIPPAGE');
  });

  it('rejects when priority fee exceeds limit', () => {
    const request: ExecutionRequest = {
      ...validRequest,
      priorityFeeLamports: 200000,
    };

    const result = engine.evaluate(request);
    expect(result.approved).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.rule).toBe('MAX_PRIORITY_FEE');
  });

  it('rejects when position size exceeds limit', () => {
    vi.mocked(mockStateEngine.getPosition).mockReturnValue({
      id: 'pos1',
      entryAmountSol: 5.0,
      tokenBalance: BigInt(1000000),
      status: 'OPEN',
      walletId: 'w1',
      trackedTokenId: 't1',
      mintAddress: 'mint1',
      entryPrice: null,
      openedAt: new Date(),
      closedAt: null,
    });

    const result = engine.evaluate(validRequest);
    expect(result.approved).toBe(false);
    expect(result.violations.some((v) => v.rule === 'MAX_POSITION_SIZE')).toBe(true);
  });

  it('rejects invalid sell percentage', () => {
    const request: ExecutionRequest = {
      ...validRequest,
      sellPercentage: 0,
    };

    const result = engine.evaluate(request);
    expect(result.approved).toBe(false);
    expect(result.violations.some((v) => v.rule === 'INVALID_SELL_PERCENTAGE')).toBe(true);
  });

  it('rejects sell percentage over 100', () => {
    const request: ExecutionRequest = {
      ...validRequest,
      sellPercentage: 150,
    };

    const result = engine.evaluate(request);
    expect(result.approved).toBe(false);
    expect(result.violations.some((v) => v.rule === 'INVALID_SELL_PERCENTAGE')).toBe(true);
  });

  it('enforces execution cooldown', () => {
    // First execution passes
    const result1 = engine.evaluate(validRequest);
    expect(result1.approved).toBe(true);

    // Immediate second execution fails
    const result2 = engine.evaluate(validRequest);
    expect(result2.approved).toBe(false);
    expect(result2.violations.some((v) => v.rule === 'EXECUTION_COOLDOWN')).toBe(true);
  });

  it('allows execution after cooldown reset', () => {
    engine.evaluate(validRequest);
    engine.resetCooldown('pos1');

    const result = engine.evaluate(validRequest);
    expect(result.approved).toBe(true);
  });

  it('collects multiple violations', () => {
    const request: ExecutionRequest = {
      ...validRequest,
      maxSlippageBps: 500,
      priorityFeeLamports: 200000,
      sellPercentage: 0,
    };

    const result = engine.evaluate(request);
    expect(result.approved).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });
});
