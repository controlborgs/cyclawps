import type { Container } from '../../infra/container.js';
import type { EventBus } from '../../services/event-bus.js';
import type { StateEngine } from '../state-engine/state-engine.service.js';
import type { PolicyEngine } from '../policy-engine/policy-engine.service.js';
import type { ExecutionEngine } from '../execution-engine/execution-engine.service.js';
import type { InternalEvent } from '../../types/events.js';
import type { PolicyEvaluationResult } from '../../types/policy.js';
import type { ExecutionAction, ExecutionRequest } from '../../types/execution.js';

export class Orchestrator {
  private readonly container: Container;
  private readonly eventBus: EventBus;
  private readonly stateEngine: StateEngine;
  private readonly policyEngine: PolicyEngine;
  private readonly executionEngine: ExecutionEngine;
  private processing = false;

  constructor(
    container: Container,
    eventBus: EventBus,
    stateEngine: StateEngine,
    policyEngine: PolicyEngine,
    executionEngine: ExecutionEngine,
  ) {
    this.container = container;
    this.eventBus = eventBus;
    this.stateEngine = stateEngine;
    this.policyEngine = policyEngine;
    this.executionEngine = executionEngine;
  }

  async start(): Promise<void> {
    const { logger } = this.container;
    logger.info('Starting orchestrator');

    this.eventBus.on((event) => {
      this.processEvent(event).catch((err) => {
        logger.error({ err, eventId: event.id }, 'Orchestrator event processing failed');
      });
    });

    logger.info('Orchestrator started');
  }

  private async processEvent(event: InternalEvent): Promise<void> {
    if (this.processing) {
      this.container.logger.debug({ eventId: event.id }, 'Orchestrator busy, queuing event');
      return;
    }

    this.processing = true;
    try {
      const triggered = await this.policyEngine.evaluateEvent(event);
      if (triggered.length === 0) return;

      for (const result of triggered) {
        await this.handleTriggeredPolicy(result, event);
      }
    } finally {
      this.processing = false;
    }
  }

  private async handleTriggeredPolicy(
    result: PolicyEvaluationResult,
    event: InternalEvent,
  ): Promise<void> {
    const { logger } = this.container;

    const mintAddress = this.extractMintFromEvent(event);
    if (!mintAddress) {
      logger.warn({ eventId: event.id }, 'Cannot determine mint address from event');
      return;
    }

    const positions = this.stateEngine.getPositionsByMint(mintAddress);
    if (positions.length === 0) {
      logger.debug({ mintAddress }, 'No open positions for triggered policy');
      return;
    }

    for (const position of positions) {
      const action = this.mapPolicyAction(result);
      if (!action) continue;

      const request: ExecutionRequest = {
        positionId: position.id,
        policyId: result.policyId,
        action: action.type,
        sellPercentage: action.sellPercentage,
        maxSlippageBps: result.actionParams?.maxSlippageBps ?? this.container.riskParams.maxSlippageBps,
        priorityFeeLamports:
          result.actionParams?.priorityFeeLamports ?? this.container.riskParams.maxPriorityFeeLamports,
      };

      logger.info(
        {
          positionId: position.id,
          policyId: result.policyId,
          action: action.type,
          sellPct: action.sellPercentage,
        },
        'Executing policy action',
      );

      const executionResult = await this.executionEngine.execute(request);

      logger.info(
        {
          executionId: executionResult.id,
          status: executionResult.status,
          txSignature: executionResult.txSignature,
        },
        'Execution completed',
      );
    }
  }

  private mapPolicyAction(
    result: PolicyEvaluationResult,
  ): { type: ExecutionAction; sellPercentage: number } | null {
    switch (result.action) {
      case 'EXIT_POSITION':
        return { type: 'FULL_EXIT', sellPercentage: 100 };
      case 'PARTIAL_SELL':
        return {
          type: 'PARTIAL_SELL',
          sellPercentage: result.actionParams?.sellPercentage ?? 50,
        };
      case 'HALT_STRATEGY':
        return { type: 'HALT', sellPercentage: 0 };
      case 'ALERT_ONLY':
        return null;
      default:
        return null;
    }
  }

  private extractMintFromEvent(event: InternalEvent): string | null {
    switch (event.type) {
      case 'DEV_WALLET_SELL':
      case 'DEV_WALLET_TRANSFER':
        return event.mintAddress;
      case 'TOKEN_TRANSFER':
        return event.mintAddress;
      case 'TOKEN_BALANCE_CHANGE':
        return event.mintAddress;
      case 'LP_ADD':
      case 'LP_REMOVE':
        return event.mintAddress;
      case 'SUPPLY_CHANGE':
        return event.mintAddress;
      default:
        return null;
    }
  }

  async stop(): Promise<void> {
    this.container.logger.info('Orchestrator stopped');
  }
}
