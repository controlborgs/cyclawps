export type ExecutionStatus = 'PENDING' | 'SIMULATING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED';

export type ExecutionAction = 'FULL_EXIT' | 'PARTIAL_SELL' | 'HALT';

export interface ExecutionRequest {
  positionId: string;
  policyId: string;
  action: ExecutionAction;
  sellPercentage: number;
  maxSlippageBps: number;
  priorityFeeLamports: number;
}

export interface ExecutionResult {
  id: string;
  status: ExecutionStatus;
  txSignature: string | null;
  amountIn: string | null;
  amountOut: string | null;
  errorMessage: string | null;
  simulationResult: SimulationResult | null;
  completedAt: Date | null;
}

export interface SimulationResult {
  success: boolean;
  unitsConsumed: number;
  logs: string[];
  returnData: string | null;
  error: string | null;
}
