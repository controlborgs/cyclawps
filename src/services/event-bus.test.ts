import { describe, it, expect, vi } from 'vitest';
import { EventBus } from './event-bus.js';
import type { Logger } from '../infra/logger.js';
import type { DevWalletEvent, WalletTransactionEvent } from '../types/events.js';

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

describe('EventBus', () => {
  it('emits events to global handlers', () => {
    const bus = new EventBus(createMockLogger());
    const handler = vi.fn();

    bus.on(handler);

    const event: DevWalletEvent = {
      id: 'e1',
      type: 'DEV_WALLET_SELL',
      timestamp: Date.now(),
      slot: 100,
      signature: 'sig1',
      devWallet: 'dev',
      mintAddress: 'mint',
      amount: '1000',
      percentageOfHoldings: 10,
    };

    bus.emit(event);

    expect(handler).toHaveBeenCalledWith(event);
  });

  it('emits events to type-specific handlers', () => {
    const bus = new EventBus(createMockLogger());
    const devHandler = vi.fn();
    const walletHandler = vi.fn();

    bus.onType('DEV_WALLET_SELL', devHandler);
    bus.onType('WALLET_TRANSACTION', walletHandler);

    const event: DevWalletEvent = {
      id: 'e1',
      type: 'DEV_WALLET_SELL',
      timestamp: Date.now(),
      slot: 100,
      signature: 'sig1',
      devWallet: 'dev',
      mintAddress: 'mint',
      amount: '1000',
      percentageOfHoldings: 10,
    };

    bus.emit(event);

    expect(devHandler).toHaveBeenCalledWith(event);
    expect(walletHandler).not.toHaveBeenCalled();
  });

  it('removes handlers with off()', () => {
    const bus = new EventBus(createMockLogger());
    const handler = vi.fn();

    bus.on(handler);
    bus.off(handler);

    const event: WalletTransactionEvent = {
      id: 'e1',
      type: 'WALLET_TRANSACTION',
      timestamp: Date.now(),
      slot: 100,
      signature: 'sig',
      walletAddress: 'addr',
      direction: 'OUT',
      amountLamports: '1000',
    };

    bus.emit(event);

    expect(handler).not.toHaveBeenCalled();
  });

  it('removes all listeners', () => {
    const bus = new EventBus(createMockLogger());
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on(h1);
    bus.onType('DEV_WALLET_SELL', h2);
    bus.removeAllListeners();

    const event: DevWalletEvent = {
      id: 'e1',
      type: 'DEV_WALLET_SELL',
      timestamp: Date.now(),
      slot: 100,
      signature: 'sig',
      devWallet: 'dev',
      mintAddress: 'mint',
      amount: '500',
      percentageOfHoldings: 5,
    };

    bus.emit(event);

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });
});
