export type PolicyTrigger =
  | 'DEV_SELL_PERCENTAGE'
  | 'DEV_SELL_COUNT'
  | 'LP_REMOVAL_PERCENTAGE'
  | 'LP_REMOVAL_TOTAL'
  | 'SUPPLY_INCREASE'
  | 'PRICE_DROP_PERCENTAGE'
  | 'WALLET_OUTFLOW';

export type PolicyAction =
  | 'EXIT_POSITION'
  | 'PARTIAL_SELL'
  | 'HALT_STRATEGY'
  | 'ALERT_ONLY';

export interface PolicyActionParams {
  sellPercentage?: number;
  maxSlippageBps?: number;
  priorityFeeLamports?: number;
}

export interface PolicyDefinition {
  id: string;
  name: string;
  trigger: PolicyTrigger;
  threshold: number;
  windowBlocks?: number;
  windowSeconds?: number;
  action: PolicyAction;
  actionParams?: PolicyActionParams;
  priority: number;
  isActive: boolean;
  trackedTokenId?: string;
}

export interface PolicyEvaluationResult {
  policyId: string;
  triggered: boolean;
  action: PolicyAction;
  actionParams?: PolicyActionParams;
  triggerValue: number;
  threshold: number;
  reason: string;
}
