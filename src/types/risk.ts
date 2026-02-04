export interface RiskParameters {
  maxPositionSizeSol: number;
  maxSlippageBps: number;
  maxPriorityFeeLamports: number;
  executionCooldownMs: number;
}

export interface RiskCheckResult {
  approved: boolean;
  violations: RiskViolation[];
}

export interface RiskViolation {
  rule: string;
  message: string;
  currentValue: number;
  limit: number;
}
