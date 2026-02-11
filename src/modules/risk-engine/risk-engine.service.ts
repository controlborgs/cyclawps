import type { Container } from '../../infra/container.js';
import type { ExecutionRequest } from '../../types/execution.js';
import type { RiskCheckResult, RiskViolation } from '../../types/risk.js';
import type { StateEngine } from '../state-engine/state-engine.service.js';

export class RiskEngine {
  private readonly container: Container;
  private readonly stateEngine: StateEngine;
  private lastExecutionTime: Map<string, number> = new Map();

  constructor(container: Container, stateEngine: StateEngine) {
    this.container = container;
    this.stateEngine = stateEngine;
  }

  evaluate(request: ExecutionRequest): RiskCheckResult {
    const violations: RiskViolation[] = [];
    const { riskParams } = this.container;

    // Check slippage
    if (request.maxSlippageBps > riskParams.maxSlippageBps) {
      violations.push({
        rule: 'MAX_SLIPPAGE',
        message: `Slippage ${request.maxSlippageBps}bps exceeds limit ${riskParams.maxSlippageBps}bps`,
        currentValue: request.maxSlippageBps,
        limit: riskParams.maxSlippageBps,
      });
    }

    // Check priority fee
    if (request.priorityFeeLamports > riskParams.maxPriorityFeeLamports) {
      violations.push({
        rule: 'MAX_PRIORITY_FEE',
        message: `Priority fee ${request.priorityFeeLamports} exceeds limit ${riskParams.maxPriorityFeeLamports}`,
        currentValue: request.priorityFeeLamports,
        limit: riskParams.maxPriorityFeeLamports,
      });
    }

    // Check cooldown
    const lastExec = this.lastExecutionTime.get(request.positionId);
    if (lastExec) {
      const elapsed = Date.now() - lastExec;
      if (elapsed < riskParams.executionCooldownMs) {
        violations.push({
          rule: 'EXECUTION_COOLDOWN',
          message: `Cooldown not elapsed: ${elapsed}ms of ${riskParams.executionCooldownMs}ms`,
          currentValue: elapsed,
          limit: riskParams.executionCooldownMs,
        });
      }
    }

    // Check position size
    const position = this.stateEngine.getPosition(request.positionId);
    if (position && position.entryAmountSol > riskParams.maxPositionSizeSol) {
      violations.push({
        rule: 'MAX_POSITION_SIZE',
        message: `Position size ${position.entryAmountSol} SOL exceeds limit ${riskParams.maxPositionSizeSol} SOL`,
        currentValue: position.entryAmountSol,
        limit: riskParams.maxPositionSizeSol,
      });
    }

    // Validate sell percentage
    if (request.sellPercentage <= 0 || request.sellPercentage > 100) {
      violations.push({
        rule: 'INVALID_SELL_PERCENTAGE',
        message: `Sell percentage ${request.sellPercentage}% is invalid`,
        currentValue: request.sellPercentage,
        limit: 100,
      });
    }

    if (violations.length === 0) {
      this.lastExecutionTime.set(request.positionId, Date.now());
    }

    return {
      approved: violations.length === 0,
      violations,
    };
  }

  resetCooldown(positionId: string): void {
    this.lastExecutionTime.delete(positionId);
  }

  async stop(): Promise<void> {
    this.lastExecutionTime.clear();
    this.container.logger.info('Risk engine stopped');
  }
}
