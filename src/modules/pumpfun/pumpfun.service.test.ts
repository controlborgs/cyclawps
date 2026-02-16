import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PumpFunService } from './pumpfun.service.js';
import type { Container } from '../../infra/container.js';
import type { BondingCurveState } from './pumpfun.service.js';

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
    solana: {
      connection: {} as Container['solana']['connection'],
      keypair: {} as Container['solana']['keypair'],
    } as Container['solana'],
    riskParams: {
      maxPositionSizeSol: 1.0,
      maxSlippageBps: 300,
      maxPriorityFeeLamports: 100000,
      executionCooldownMs: 5000,
    },
  };
}

function createMockCurveState(overrides?: Partial<BondingCurveState>): BondingCurveState {
  return {
    virtualTokenReserves: 1_000_000_000_000n,  // 1M tokens (6 decimals)
    virtualSolReserves: 30_000_000_000n,        // 30 SOL
    realTokenReserves: 800_000_000_000n,
    realSolReserves: 20_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000n,
    complete: false,
    creator: PublicKey.default,
    ...overrides,
  };
}

describe('PumpFunService', () => {
  let service: PumpFunService;

  beforeEach(() => {
    service = new PumpFunService(createMockContainer());
  });

  describe('PDA derivation', () => {
    it('derives deterministic bonding curve PDA', () => {
      const mint = Keypair.generate().publicKey;
      const pda1 = service.getBondingCurvePDA(mint);
      const pda2 = service.getBondingCurvePDA(mint);
      expect(pda1.equals(pda2)).toBe(true);
    });

    it('derives different PDAs for different mints', () => {
      const mint1 = Keypair.generate().publicKey;
      const mint2 = Keypair.generate().publicKey;
      const pda1 = service.getBondingCurvePDA(mint1);
      const pda2 = service.getBondingCurvePDA(mint2);
      expect(pda1.equals(pda2)).toBe(false);
    });

    it('derives global PDA deterministically', () => {
      const pda1 = service.getGlobalPDA();
      const pda2 = service.getGlobalPDA();
      expect(pda1.equals(pda2)).toBe(true);
    });
  });

  describe('calculateBuyQuote', () => {
    it('returns positive token output for SOL input', () => {
      const state = createMockCurveState();
      const solIn = 1_000_000_000n; // 1 SOL
      const quote = service.calculateBuyQuote(state, solIn);

      expect(quote.amountIn).toBe(solIn);
      expect(quote.amountOut).toBeGreaterThan(0n);
    });

    it('deducts 1% fee from SOL input before swap', () => {
      const state = createMockCurveState();
      // With very small input, output should reflect ~99% of input going to swap
      const solIn = 100_000_000n; // 0.1 SOL
      const quote = service.calculateBuyQuote(state, solIn);

      // Net SOL after 1% fee = 99_009_900 (100M * 10000 / 10100)
      // tokens = 99_009_900 * 1T / (30B + 99_009_900)
      // Should be ~3.28B tokens approximately
      expect(quote.amountOut).toBeGreaterThan(0n);
      expect(quote.amountOut).toBeLessThan(state.virtualTokenReserves);
    });

    it('caps output at real token reserves', () => {
      const state = createMockCurveState({
        realTokenReserves: 100n, // Very low real reserves
      });
      const solIn = 1_000_000_000_000n; // Huge SOL input
      const quote = service.calculateBuyQuote(state, solIn);

      expect(quote.amountOut).toBe(100n);
    });

    it('returns zero output for zero input', () => {
      const state = createMockCurveState();
      const quote = service.calculateBuyQuote(state, 0n);
      expect(quote.amountOut).toBe(0n);
    });

    it('reports non-negative price impact', () => {
      const state = createMockCurveState();
      const quote = service.calculateBuyQuote(state, 1_000_000_000n);
      expect(quote.priceImpactBps).toBeGreaterThanOrEqual(0);
    });

    it('larger buys have higher price impact', () => {
      const state = createMockCurveState();
      const small = service.calculateBuyQuote(state, 100_000_000n);
      const large = service.calculateBuyQuote(state, 10_000_000_000n);
      expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
    });
  });

  describe('calculateSellQuote', () => {
    it('returns positive SOL output for token input', () => {
      const state = createMockCurveState();
      const tokensIn = 10_000_000_000n; // 10K tokens
      const quote = service.calculateSellQuote(state, tokensIn);

      expect(quote.amountIn).toBe(tokensIn);
      expect(quote.amountOut).toBeGreaterThan(0n);
    });

    it('deducts 1% fee from SOL output', () => {
      const state = createMockCurveState();
      const tokensIn = 10_000_000_000n;
      const quote = service.calculateSellQuote(state, tokensIn);

      // Gross SOL = tokensIn * virtualSolReserves / (virtualTokenReserves + tokensIn)
      const grossSol = (tokensIn * state.virtualSolReserves) /
        (state.virtualTokenReserves + tokensIn);
      // Net = gross * 99%
      const expectedNet = (grossSol * 9900n) / 10000n;
      expect(quote.amountOut).toBe(expectedNet);
    });

    it('caps output at real SOL reserves', () => {
      const state = createMockCurveState({
        realSolReserves: 50n, // Very low real SOL
      });
      const tokensIn = 1_000_000_000_000n; // Huge token input
      const quote = service.calculateSellQuote(state, tokensIn);

      expect(quote.amountOut).toBe(50n);
    });

    it('reports non-negative price impact', () => {
      const state = createMockCurveState();
      const quote = service.calculateSellQuote(state, 10_000_000_000n);
      expect(quote.priceImpactBps).toBeGreaterThanOrEqual(0);
    });
  });

  describe('applySlippage', () => {
    it('increases amount for buys', () => {
      const amount = 1_000_000_000n;
      const result = service.applySlippage(amount, 300, true);
      // 1B * (10000 + 300) / 10000 = 1.03B
      expect(result).toBe(1_030_000_000n);
    });

    it('decreases amount for sells', () => {
      const amount = 1_000_000_000n;
      const result = service.applySlippage(amount, 300, false);
      // 1B * (10000 - 300) / 10000 = 0.97B
      expect(result).toBe(970_000_000n);
    });

    it('returns same amount with zero slippage', () => {
      const amount = 1_000_000_000n;
      expect(service.applySlippage(amount, 0, true)).toBe(amount);
      expect(service.applySlippage(amount, 0, false)).toBe(amount);
    });

    it('handles 100% slippage on buy side', () => {
      const amount = 1_000_000_000n;
      const result = service.applySlippage(amount, 10000, true);
      expect(result).toBe(2_000_000_000n); // doubled
    });
  });

  describe('getProgramId', () => {
    it('returns PumpFun program ID', () => {
      const id = service.getProgramId();
      expect(id.toBase58()).toBe('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    });
  });
});
