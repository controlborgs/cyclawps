import { PublicKey } from '@solana/web3.js';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../infra/container.js';
import type { EventBus } from '../../services/event-bus.js';
import type { InternalEvent, DevWalletEvent } from '../../types/events.js';

interface Subscription {
  id: number;
  type: 'account' | 'logs';
  address: string;
}

interface TrackedWallet {
  address: string;
  label: string | null;
  devWallets: Map<string, string>; // mintAddress -> devWallet
}

export class EventIngestionService {
  private readonly container: Container;
  private readonly eventBus: EventBus;
  private readonly subscriptions: Subscription[] = [];
  private readonly trackedWallets: Map<string, TrackedWallet> = new Map();
  private readonly trackedMints: Set<string> = new Set();

  constructor(container: Container, eventBus: EventBus) {
    this.container = container;
    this.eventBus = eventBus;
  }

  async start(): Promise<void> {
    const { logger, db } = this.container;
    logger.info('Starting event ingestion service');

    const wallets = await db.wallet.findMany({ where: { isActive: true } });
    const tokens = await db.trackedToken.findMany({
      where: { isActive: true },
      include: { wallet: true },
    });

    for (const wallet of wallets) {
      this.trackedWallets.set(wallet.address, {
        address: wallet.address,
        label: wallet.label,
        devWallets: new Map(),
      });
    }

    for (const token of tokens) {
      this.trackedMints.add(token.mintAddress);
      const tracked = this.trackedWallets.get(token.wallet.address);
      if (tracked && token.devWallet) {
        tracked.devWallets.set(token.mintAddress, token.devWallet);
      }
    }

    await this.subscribeToWallets();
    await this.subscribeToDevWallets(tokens);

    logger.info(
      {
        walletCount: wallets.length,
        tokenCount: tokens.length,
        subscriptionCount: this.subscriptions.length,
      },
      'Event ingestion started',
    );
  }

  private async subscribeToWallets(): Promise<void> {
    const { connection } = this.container.solana;
    const logger = this.container.logger;

    for (const [address] of this.trackedWallets) {
      try {
        const pubkey = new PublicKey(address);
        const subId = connection.onAccountChange(pubkey, (accountInfo, context) => {
          this.handleAccountChange(address, accountInfo, context.slot);
        });

        this.subscriptions.push({ id: subId, type: 'account', address });
        logger.debug({ address }, 'Subscribed to wallet account changes');
      } catch (err) {
        logger.error({ err, address }, 'Failed to subscribe to wallet');
      }
    }
  }

  private async subscribeToDevWallets(
    tokens: Array<{ mintAddress: string; devWallet: string | null; wallet: { address: string } }>,
  ): Promise<void> {
    const { connection } = this.container.solana;
    const logger = this.container.logger;
    const devWallets = new Set<string>();

    for (const token of tokens) {
      if (token.devWallet && !devWallets.has(token.devWallet)) {
        devWallets.add(token.devWallet);

        try {
          const pubkey = new PublicKey(token.devWallet);
          const subId = connection.onAccountChange(pubkey, (accountInfo, context) => {
            this.handleDevWalletChange(
              token.devWallet!,
              token.mintAddress,
              accountInfo,
              context.slot,
            );
          });

          this.subscriptions.push({ id: subId, type: 'account', address: token.devWallet });
          logger.debug({ devWallet: token.devWallet, mint: token.mintAddress }, 'Subscribed to dev wallet');
        } catch (err) {
          logger.error({ err, devWallet: token.devWallet }, 'Failed to subscribe to dev wallet');
        }
      }
    }
  }

  private handleAccountChange(
    address: string,
    accountInfo: { lamports: number; data: Buffer },
    slot: number,
  ): void {
    const event: InternalEvent = {
      id: randomUUID(),
      type: 'WALLET_TRANSACTION',
      timestamp: Date.now(),
      slot,
      signature: '',
      walletAddress: address,
      direction: 'OUT',
      amountLamports: accountInfo.lamports.toString(),
    };

    this.eventBus.emit(event);
    this.persistEvent(event);
  }

  private handleDevWalletChange(
    devWallet: string,
    mintAddress: string,
    _accountInfo: { lamports: number; data: Buffer },
    slot: number,
  ): void {
    const event: DevWalletEvent = {
      id: randomUUID(),
      type: 'DEV_WALLET_SELL',
      timestamp: Date.now(),
      slot,
      signature: '',
      devWallet,
      mintAddress,
      amount: '0',
      percentageOfHoldings: 0,
    };

    this.eventBus.emit(event);
    this.persistEvent(event);
  }

  private persistEvent(event: InternalEvent): void {
    const { db, logger } = this.container;
    db.eventLog
      .create({
        data: {
          eventType: event.type,
          source: 'websocket',
          payload: JSON.parse(JSON.stringify(event)),
          slot: BigInt(event.slot),
          signature: event.signature || null,
        },
      })
      .catch((err) => {
        logger.error({ err, eventId: event.id }, 'Failed to persist event');
      });
  }

  async addWalletSubscription(address: string, label?: string): Promise<void> {
    const { connection } = this.container.solana;
    const pubkey = new PublicKey(address);

    const subId = connection.onAccountChange(pubkey, (accountInfo, context) => {
      this.handleAccountChange(address, accountInfo, context.slot);
    });

    this.subscriptions.push({ id: subId, type: 'account', address });
    this.trackedWallets.set(address, {
      address,
      label: label ?? null,
      devWallets: new Map(),
    });

    this.container.logger.info({ address, label }, 'Added wallet subscription');
  }

  async stop(): Promise<void> {
    const { connection } = this.container.solana;
    const logger = this.container.logger;

    for (const sub of this.subscriptions) {
      try {
        await connection.removeAccountChangeListener(sub.id);
      } catch (err) {
        logger.error({ err, subId: sub.id }, 'Failed to remove subscription');
      }
    }

    this.subscriptions.length = 0;
    logger.info('Event ingestion stopped');
  }
}
