# ClawOps

Autonomous on-chain operations layer for Solana wallets. Monitors wallet activity, evaluates events against declarative policies, and executes on-chain transactions automatically.

## Architecture

```
Solana RPC WebSocket
       │
       ▼
 EventIngestion ──emit──▶ EventBus
                             │
                             ├──▶ StateEngine (position tracking, dev wallet metrics, LP state)
                             │
                             ├──▶ PolicyEngine (declarative rule evaluation)
                             │
                             └──▶ Orchestrator
                                     │
                                     ▼
                               RiskEngine ──▶ ExecutionEngine
                                                   │
                                                   ├── Simulate TX
                                                   ├── Send with retries
                                                   └── Persist result
```

Each module is independently testable. State is managed in-memory with Redis snapshots and Postgres persistence. The API layer is stateless.

## Monitoring

- Wallet activity (specific addresses)
- Token account balances
- Liquidity pool changes (Raydium, Meteora)
- Dev wallet behavior (sell detection)
- SPL token supply changes
- LP removal events

## Policy Engine

Declarative JSON policies with deterministic evaluation:

```json
{
  "trigger": "DEV_SELL_PERCENTAGE",
  "threshold": 30,
  "windowSeconds": 600,
  "action": "EXIT_POSITION"
}
```

**Supported triggers:** `DEV_SELL_PERCENTAGE`, `DEV_SELL_COUNT`, `LP_REMOVAL_PERCENTAGE`, `SUPPLY_INCREASE`, `PRICE_DROP_PERCENTAGE`

**Available actions:** `EXIT_POSITION`, `PARTIAL_SELL`, `HALT_STRATEGY`, `ALERT_ONLY`

## PumpFun Integration

Buy and sell tokens through PumpFun bonding curves. The execution engine builds real PumpFun program instructions with slippage protection and simulation.

**Open a position:**

```bash
curl -X POST http://localhost:3100/positions \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": "your-wallet-uuid",
    "mintAddress": "FKPvoUKtnWwPi73SGLQrAux9DeP9RD8eGqrzcwynpump",
    "solAmount": 0.5,
    "maxSlippageBps": 300,
    "priorityFeeLamports": 50000
  }'
```

Sells are triggered automatically by the policy engine through the execution engine's PumpFun sell path.

## Risk Engine

Every execution request passes through risk checks before TX construction:

- Max capital per position
- Max slippage (bps)
- Max priority fee
- Cooldown periods between executions
- Preflight transaction simulation

## Quick Start

```bash
# Start Postgres and Redis
docker compose up -d postgres redis

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your RPC URL and wallet key

# Run database migrations
npx prisma migrate dev

# Start in development mode
npm run dev
```

## Docker

```bash
# Full stack
docker compose up --build
```

Multi-stage build produces a minimal production image running as non-root.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | DB, Redis, and RPC health checks |
| `POST` | `/policies` | Create a policy |
| `GET` | `/policies` | List all policies |
| `DELETE` | `/policies/:id` | Deactivate a policy |
| `POST` | `/wallets` | Register a wallet to monitor |
| `GET` | `/wallets` | List monitored wallets |
| `POST` | `/wallets/:walletId/tokens` | Track a token for a wallet |
| `GET` | `/positions` | List positions (filterable by status, walletId) |
| `GET` | `/positions/:id` | Position detail with executions |
| `GET` | `/executions` | List executions (filterable by status, positionId) |
| `GET` | `/executions/:id` | Execution detail |

## Database

Postgres with Prisma ORM. Six tables:

- `wallets` — monitored wallet addresses
- `tracked_tokens` — token mints linked to wallets with optional dev wallet tracking
- `policies` — declarative trigger/action rules
- `positions` — open/closed position state
- `executions` — full execution audit trail with TX signatures and simulation results
- `event_log` — every ingested event with slot and signature

## Testing

```bash
npm test
```

29 unit tests covering policy evaluation, risk enforcement, state management, and event dispatch.

## Tech Stack

- TypeScript (strict mode, ESM)
- Node 22+
- Fastify 5
- Prisma 6 / PostgreSQL
- ioredis / Redis
- @solana/web3.js v1
- @solana/spl-token
- Pino (structured JSON logging)
- Zod (runtime validation)
- Vitest

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SOLANA_RPC_URL` | Solana RPC endpoint | — |
| `SOLANA_WS_URL` | Solana WebSocket endpoint | — |
| `WALLET_PRIVATE_KEY` | Base64 encoded private key | — |
| `WALLET_KEYPAIR_PATH` | Path to keypair JSON file | — |
| `DATABASE_URL` | Postgres connection string | — |
| `REDIS_URL` | Redis connection string | — |
| `API_HOST` | API bind address | `0.0.0.0` |
| `API_PORT` | API port | `3100` |
| `MAX_POSITION_SIZE_SOL` | Max SOL per position | `1.0` |
| `MAX_SLIPPAGE_BPS` | Max slippage in basis points | `300` |
| `MAX_PRIORITY_FEE_LAMPORTS` | Max priority fee | `100000` |
| `EXECUTION_COOLDOWN_MS` | Min time between executions | `5000` |
| `LOG_LEVEL` | Pino log level | `info` |
| `NODE_ENV` | Environment | `development` |

Either `WALLET_PRIVATE_KEY` or `WALLET_KEYPAIR_PATH` must be set. Private keys are never logged.

## CyclAwps Node

For autonomous AI-powered operation with agent swarms and shared intelligence, see [cyclawps-node](https://github.com/controlborgs/cyclawps-node). The node builds on this core engine with LLM-powered agents, deployer scoring, wallet graph analysis, and cross-node signal sharing.
