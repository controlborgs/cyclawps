export type EventType =
  | 'WALLET_TRANSACTION'
  | 'TOKEN_TRANSFER'
  | 'TOKEN_BALANCE_CHANGE'
  | 'LP_ADD'
  | 'LP_REMOVE'
  | 'DEV_WALLET_SELL'
  | 'DEV_WALLET_TRANSFER'
  | 'SUPPLY_CHANGE'
  | 'POSITION_OPENED'
  | 'POSITION_CLOSED';

export interface BaseEvent {
  id: string;
  type: EventType;
  timestamp: number;
  slot: number;
  signature: string;
}

export interface WalletTransactionEvent extends BaseEvent {
  type: 'WALLET_TRANSACTION';
  walletAddress: string;
  mintAddress?: string;
  direction: 'IN' | 'OUT';
  amountLamports: string;
}

export interface TokenTransferEvent extends BaseEvent {
  type: 'TOKEN_TRANSFER';
  mintAddress: string;
  from: string;
  to: string;
  amount: string;
}

export interface TokenBalanceChangeEvent extends BaseEvent {
  type: 'TOKEN_BALANCE_CHANGE';
  walletAddress: string;
  mintAddress: string;
  previousBalance: string;
  newBalance: string;
}

export interface LPEvent extends BaseEvent {
  type: 'LP_ADD' | 'LP_REMOVE';
  poolAddress: string;
  mintAddress: string;
  liquidityAmount: string;
  solAmount: string;
  tokenAmount: string;
}

export interface DevWalletEvent extends BaseEvent {
  type: 'DEV_WALLET_SELL' | 'DEV_WALLET_TRANSFER';
  devWallet: string;
  mintAddress: string;
  amount: string;
  percentageOfHoldings: number;
}

export interface SupplyChangeEvent extends BaseEvent {
  type: 'SUPPLY_CHANGE';
  mintAddress: string;
  previousSupply: string;
  newSupply: string;
  changePercentage: number;
}

export type InternalEvent =
  | WalletTransactionEvent
  | TokenTransferEvent
  | TokenBalanceChangeEvent
  | LPEvent
  | DevWalletEvent
  | SupplyChangeEvent;
