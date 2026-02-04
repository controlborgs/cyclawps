import { Connection, Keypair } from '@solana/web3.js';
import fs from 'node:fs';
import type { Logger } from './logger.js';
import type { EnvConfig } from '../config/env.js';

export interface SolanaContext {
  connection: Connection;
  keypair: Keypair;
}

export function createSolanaContext(
  config: Pick<EnvConfig, 'SOLANA_RPC_URL' | 'SOLANA_WS_URL' | 'WALLET_PRIVATE_KEY' | 'WALLET_KEYPAIR_PATH'>,
  logger: Logger,
): SolanaContext {
  const connection = new Connection(config.SOLANA_RPC_URL, {
    wsEndpoint: config.SOLANA_WS_URL,
    commitment: 'confirmed',
  });

  const keypair = loadKeypair(config, logger);

  logger.info(
    { publicKey: keypair.publicKey.toBase58() },
    'Solana context initialized',
  );

  return { connection, keypair };
}

function loadKeypair(
  config: Pick<EnvConfig, 'WALLET_PRIVATE_KEY' | 'WALLET_KEYPAIR_PATH'>,
  logger: Logger,
): Keypair {
  if (config.WALLET_PRIVATE_KEY) {
    logger.info('Loading keypair from environment variable');
    const decoded = Buffer.from(config.WALLET_PRIVATE_KEY, 'base64');
    return Keypair.fromSecretKey(new Uint8Array(decoded));
  }

  if (config.WALLET_KEYPAIR_PATH) {
    logger.info({ path: config.WALLET_KEYPAIR_PATH }, 'Loading keypair from file');
    const raw = fs.readFileSync(config.WALLET_KEYPAIR_PATH, 'utf-8');
    const secretKey = new Uint8Array(JSON.parse(raw) as number[]);
    return Keypair.fromSecretKey(secretKey);
  }

  throw new Error('No wallet keypair configured');
}

export async function checkRpcHealth(connection: Connection, logger: Logger): Promise<void> {
  try {
    const slot = await connection.getSlot();
    const version = await connection.getVersion();
    logger.info({ slot, version: version['solana-core'] }, 'RPC health check passed');
  } catch (err) {
    logger.fatal({ err }, 'RPC health check failed');
    throw new Error('Solana RPC is unreachable');
  }
}
