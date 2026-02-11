import type { Container } from '../../infra/container.js';
import type { StateEngine } from '../state-engine/state-engine.service.js';
import type { PolicyDefinition, PolicyEvaluationResult } from '../../types/policy.js';
import type { InternalEvent, DevWalletEvent, LPEvent, SupplyChangeEvent } from '../../types/events.js';
import type { EventBus } from '../../services/event-bus.js';

export class PolicyEngine {
  private readonly container: Container;
  private readonly stateEngine: StateEngine;
  private readonly eventBus: EventBus;
  private policies: PolicyDefinition[] = [];

  constructor(container: Container, stateEngine: StateEngine, eventBus: EventBus) {
    this.container = container;
    this.stateEngine = stateEngine;
    this.eventBus = eventBus;
  }

  async start(): Promise<void> {
    const { logger } = this.container;
    logger.info('Starting policy engine');

    await this.loadPolicies();

    this.eventBus.on((event) => {
      this.evaluateEvent(event).catch((err) => {
        logger.error({ err, eventId: event.id }, 'Policy evaluation failed');
      });
    });

    logger.info({ policyCount: this.policies.length }, 'Policy engine started');
  }

  async loadPolicies(): Promise<void> {
    const { db } = this.container;
    const raw = await db.policy.findMany({ where: { isActive: true } });

    this.policies = raw.map((p) => ({
      id: p.id,
      name: p.name,
      trigger: p.trigger as PolicyDefinition['trigger'],
      threshold: p.threshold,
      windowBlocks: p.windowBlocks ?? undefined,
      windowSeconds: p.windowSeconds ?? undefined,
      action: p.action as PolicyDefinition['action'],
      actionParams: (p.actionParams as PolicyDefinition['actionParams']) ?? undefined,
      priority: p.priority,
      isActive: p.isActive,
      trackedTokenId: p.trackedTokenId ?? undefined,
    }));
  }

  async evaluateEvent(event: InternalEvent): Promise<PolicyEvaluationResult[]> {
    const results: PolicyEvaluationResult[] = [];

    for (const policy of this.policies) {
      if (!policy.isActive) continue;

      const result = this.evaluatePolicy(policy, event);
      if (result && result.triggered) {
        results.push(result);
        this.container.logger.info(
          {
            policyId: policy.id,
            policyName: policy.name,
            action: result.action,
            triggerValue: result.triggerValue,
            threshold: result.threshold,
          },
          'Policy triggered',
        );
      }
    }

    // Sort by priority (higher = first)
    results.sort((a, b) => {
      const policyA = this.policies.find((p) => p.id === a.policyId);
      const policyB = this.policies.find((p) => p.id === b.policyId);
      return (policyB?.priority ?? 0) - (policyA?.priority ?? 0);
    });

    return results;
  }

  evaluatePolicy(policy: PolicyDefinition, event: InternalEvent): PolicyEvaluationResult | null {
    switch (policy.trigger) {
      case 'DEV_SELL_PERCENTAGE':
        return this.evaluateDevSellPercentage(policy, event);
      case 'DEV_SELL_COUNT':
        return this.evaluateDevSellCount(policy, event);
      case 'LP_REMOVAL_PERCENTAGE':
        return this.evaluateLPRemoval(policy, event);
      case 'SUPPLY_INCREASE':
        return this.evaluateSupplyIncrease(policy, event);
      case 'PRICE_DROP_PERCENTAGE':
        return this.evaluatePriceDrop(policy, event);
      default:
        return null;
    }
  }

  private evaluateDevSellPercentage(
    policy: PolicyDefinition,
    event: InternalEvent,
  ): PolicyEvaluationResult | null {
    if (event.type !== 'DEV_WALLET_SELL') return null;

    const devEvent = event as DevWalletEvent;
    const windowMs = (policy.windowSeconds ?? 600) * 1000;

    const totalPct = this.stateEngine.getDevSellPercentageInWindow(
      devEvent.mintAddress,
      devEvent.devWallet,
      windowMs,
    );

    return {
      policyId: policy.id,
      triggered: totalPct >= policy.threshold,
      action: policy.action,
      actionParams: policy.actionParams,
      triggerValue: totalPct,
      threshold: policy.threshold,
      reason: `Dev wallet sold ${totalPct.toFixed(2)}% in window (threshold: ${policy.threshold}%)`,
    };
  }

  private evaluateDevSellCount(
    policy: PolicyDefinition,
    event: InternalEvent,
  ): PolicyEvaluationResult | null {
    if (event.type !== 'DEV_WALLET_SELL') return null;

    const devEvent = event as DevWalletEvent;
    const metrics = this.stateEngine.getDevMetrics(devEvent.mintAddress, devEvent.devWallet);
    const count = metrics?.totalSellCount ?? 0;

    return {
      policyId: policy.id,
      triggered: count >= policy.threshold,
      action: policy.action,
      actionParams: policy.actionParams,
      triggerValue: count,
      threshold: policy.threshold,
      reason: `Dev wallet sell count: ${count} (threshold: ${policy.threshold})`,
    };
  }

  private evaluateLPRemoval(
    policy: PolicyDefinition,
    event: InternalEvent,
  ): PolicyEvaluationResult | null {
    if (event.type !== 'LP_REMOVE') return null;

    const lpEvent = event as LPEvent;
    const lpState = this.stateEngine.getLPState(lpEvent.poolAddress);
    const totalRemoved = lpState?.totalRemovedPercentage ?? 0;

    return {
      policyId: policy.id,
      triggered: totalRemoved >= policy.threshold,
      action: policy.action,
      actionParams: policy.actionParams,
      triggerValue: totalRemoved,
      threshold: policy.threshold,
      reason: `LP removal: ${totalRemoved.toFixed(2)}% (threshold: ${policy.threshold}%)`,
    };
  }

  private evaluateSupplyIncrease(
    policy: PolicyDefinition,
    event: InternalEvent,
  ): PolicyEvaluationResult | null {
    if (event.type !== 'SUPPLY_CHANGE') return null;

    const supplyEvent = event as SupplyChangeEvent;

    return {
      policyId: policy.id,
      triggered: supplyEvent.changePercentage >= policy.threshold,
      action: policy.action,
      actionParams: policy.actionParams,
      triggerValue: supplyEvent.changePercentage,
      threshold: policy.threshold,
      reason: `Supply increased ${supplyEvent.changePercentage.toFixed(2)}% (threshold: ${policy.threshold}%)`,
    };
  }

  private evaluatePriceDrop(
    _policy: PolicyDefinition,
    _event: InternalEvent,
  ): PolicyEvaluationResult | null {
    // Price tracking requires an oracle or DEX price feed
    // Stubbed for MVP — will integrate with Jupiter/Raydium price API
    return null;
  }

  getPolicies(): PolicyDefinition[] {
    return [...this.policies];
  }

  async addPolicy(policy: PolicyDefinition): Promise<void> {
    this.policies.push(policy);
    this.container.logger.info({ policyId: policy.id, name: policy.name }, 'Policy added');
  }

  async removePolicy(policyId: string): Promise<void> {
    this.policies = this.policies.filter((p) => p.id !== policyId);
    this.container.logger.info({ policyId }, 'Policy removed');
  }

  async stop(): Promise<void> {
    this.container.logger.info('Policy engine stopped');
  }
}
