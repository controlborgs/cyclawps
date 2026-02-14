import type { FastifyInstance } from 'fastify';
import type { Container } from '../../infra/container.js';
import type { PolicyEngine } from '../../modules/policy-engine/policy-engine.service.js';
import { createPolicySchema } from '../schemas.js';

export async function policyRoutes(
  app: FastifyInstance,
  container: Container,
  policyEngine: PolicyEngine,
): Promise<void> {
  app.post('/policies', async (request, reply) => {
    const parsed = createPolicySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.format(),
      });
    }

    const { db } = container;
    const input = parsed.data;

    const policy = await db.policy.create({
      data: {
        name: input.name,
        trigger: input.trigger,
        threshold: input.threshold,
        windowBlocks: input.windowBlocks ?? null,
        windowSeconds: input.windowSeconds ?? null,
        action: input.action,
        actionParams: input.actionParams ?? undefined,
        priority: input.priority,
        trackedTokenId: input.trackedTokenId ?? null,
      },
    });

    await policyEngine.addPolicy({
      id: policy.id,
      name: policy.name,
      trigger: policy.trigger as typeof input.trigger,
      threshold: policy.threshold,
      windowBlocks: policy.windowBlocks ?? undefined,
      windowSeconds: policy.windowSeconds ?? undefined,
      action: policy.action as typeof input.action,
      actionParams: (policy.actionParams as typeof input.actionParams) ?? undefined,
      priority: policy.priority,
      isActive: policy.isActive,
      trackedTokenId: policy.trackedTokenId ?? undefined,
    });

    container.logger.info({ policyId: policy.id }, 'Policy created via API');

    return reply.status(201).send(policy);
  });

  app.get('/policies', async (_request, reply) => {
    const policies = await container.db.policy.findMany({
      orderBy: { priority: 'desc' },
    });
    return reply.send(policies);
  });

  app.delete('/policies/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    await container.db.policy.update({
      where: { id },
      data: { isActive: false },
    });

    await policyEngine.removePolicy(id);

    return reply.status(204).send();
  });
}
