export type PositionStatus = 'OPEN' | 'CLOSING' | 'CLOSED' | 'FAILED';

export interface PositionState {
  id: string;
  walletId: string;
  trackedTokenId: string;
  mintAddress: string;
  entryAmountSol: number;
  tokenBalance: bigint;
  entryPrice: number | null;
  status: PositionStatus;
  openedAt: Date;
  closedAt: Date | null;
}

export interface PositionSnapshot {
  positionId: string;
  tokenBalance: bigint;
  estimatedValueSol: number | null;
  timestamp: number;
}
