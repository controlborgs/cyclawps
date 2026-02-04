import pino from 'pino';
import type { EnvConfig } from '../config/env.js';

export function createLogger(config: Pick<EnvConfig, 'LOG_LEVEL' | 'NODE_ENV'>): pino.Logger {
  return pino({
    level: config.LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    ...(config.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino/file',
            options: { destination: 1 },
          },
        }
      : {}),
    redact: {
      paths: ['privateKey', 'secret', 'password', 'WALLET_PRIVATE_KEY'],
      censor: '[REDACTED]',
    },
  });
}

export type Logger = pino.Logger;
