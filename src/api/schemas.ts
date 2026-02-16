import { z } from 'zod';

export const createPolicySchema = z.object({
  name: z.string().min(1).max(255),
  trigger: z.enum([
    'DEV_SELL_PERCENTAGE',
    'DEV_SELL_COUNT',
    'LP_REMOVAL_PERCENTAGE',
    'LP_REMOVAL_TOTAL',
    'SUPPLY_INCREASE',
    'PRICE_DROP_PERCENTAGE',
    'WALLET_OUTFLOW',
  ]),
  threshold: z.number().positive(),
  windowBlocks: z.number().int().positive().optional(),
  windowSeconds: z.number().int().positive().optional(),
  action: z.enum(['EXIT_POSITION', 'PARTIAL_SELL', 'HALT_STRATEGY', 'ALERT_ONLY']),
  actionParams: z
    .object({
      sellPercentage: z.number().min(1).max(100).optional(),
      maxSlippageBps: z.number().int().min(1).max(10000).optional(),
      priorityFeeLamports: z.number().int().min(0).optional(),
    })
    .optional(),
  priority: z.number().int().default(0),
  trackedTokenId: z.string().uuid().optional(),
});

export const createWalletSchema = z.object({
  address: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid base58 address'),
  label: z.string().max(255).optional(),
});

export const addTrackedTokenSchema = z.object({
  mintAddress: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid base58 address'),
  symbol: z.string().max(20).optional(),
  decimals: z.number().int().min(0).max(18).default(9),
  walletId: z.string().uuid(),
  devWallet: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid base58 address')
    .optional(),
});

export const createPositionSchema = z.object({
  walletId: z.string().uuid(),
  mintAddress: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, 'Invalid base58 address'),
  solAmount: z.number().positive(),
  maxSlippageBps: z.number().int().min(1).max(10000).default(300),
  priorityFeeLamports: z.number().int().min(0).default(50000),
});

export type CreatePolicyInput = z.infer<typeof createPolicySchema>;
export type CreateWalletInput = z.infer<typeof createWalletSchema>;
export type AddTrackedTokenInput = z.infer<typeof addTrackedTokenSchema>;
export type CreatePositionInput = z.infer<typeof createPositionSchema>;
