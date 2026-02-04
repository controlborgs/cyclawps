import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_WS_URL: z.string().startsWith('wss://').or(z.string().startsWith('ws://')),

  WALLET_PRIVATE_KEY: z.string().optional(),
  WALLET_KEYPAIR_PATH: z.string().optional(),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3100),

  MAX_POSITION_SIZE_SOL: z.coerce.number().positive().default(1.0),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(10000).default(300),
  MAX_PRIORITY_FEE_LAMPORTS: z.coerce.number().int().min(0).default(100000),
  EXECUTION_COOLDOWN_MS: z.coerce.number().int().min(0).default(5000),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

function validateEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.format();
    const messages = Object.entries(formatted)
      .filter(([key]) => key !== '_errors')
      .map(([key, val]) => {
        const errors = (val as { _errors?: string[] })._errors;
        return `  ${key}: ${errors?.join(', ') ?? 'invalid'}`;
      })
      .join('\n');
    throw new Error(`Environment validation failed:\n${messages}`);
  }

  if (!result.data.WALLET_PRIVATE_KEY && !result.data.WALLET_KEYPAIR_PATH) {
    throw new Error('Either WALLET_PRIVATE_KEY or WALLET_KEYPAIR_PATH must be set');
  }

  return result.data;
}

export type EnvConfig = z.infer<typeof envSchema>;
export const env = validateEnv();
