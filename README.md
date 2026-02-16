# CyclAwps

Autonomous execution engine for Solana. Ingests on-chain events in real-time, evaluates them against declarative policies, enforces risk limits, and executes transactions — all within a single event loop, sub-150ms end-to-end.

The foundation layer for [CyclAwps Node](https://github.com/controlborgs/cyclawps-node).

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

Every module is independently testable. State lives in-memory with Redis snapshots and Postgres persistence. Zero external dependencies between modules — the EventBus is the only coupling point.

## What It Monitors

- Wallet activity across specific addresses
- Token account balance changes
- Liquidity pool events (Raydium, Meteora)
- Dev wallet behavior — sell detection, velocity tracking
- SPL token supply changes (mint events)
- LP removal events

## Policy Engine

Declarative JSON policies with deterministic, sub-millisecond evaluation:

```json
{
  "trigger": "DEV_SELL_PERCENTAGE",
  "threshold": 30,
  "windowSeconds": 600,
  "action": "EXIT_POSITION"
}
```

**Triggers:** `DEV_SELL_PERCENTAGE`, `DEV_SELL_COUNT`, `LP_REMOVAL_PERCENTAGE`, `SUPPLY_INCREASE`, `PRICE_DROP_PERCENTAGE`

**Actions:** `EXIT_POSITION`, `PARTIAL_SELL`, `HALT_STRATEGY`, `ALERT_ONLY`

Policies are evaluated on every event. No polling. No cron. Instant reaction to on-chain state changes.

## PumpFun Integration

Native PumpFun bonding curve support. The execution engine builds real program instructions — PDA derivation, constant-product AMM math, associated token accounts — with slippage protection and preflight simulation.

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

Exits are triggered automatically by the policy engine. No manual intervention required.

## Risk Engine

Every execution request passes through the full risk pipeline before a transaction is built:

- Max capital per position
- Max slippage enforcement (bps)
- Max priority fee caps
- Cooldown periods between executions
- Preflight transaction simulation (rejects before spending SOL)

Nothing executes without passing all guards.

## Benchmarks

| Metric | Value | Notes |
|--------|-------|-------|
| Event ingestion | **8ms** p95 | Solana WS to EventBus |
| Policy evaluation | **0.3ms** | Cached state, deterministic rules |
| Risk pipeline | **1.1ms** | All guards including cooldown |
| TX simulation + send | **120ms** | Full Solana RPC round-trip |
| State snapshot | **1.2ms** | Redis position + token persistence |
| **Full event cycle** | **< 150ms** | **Ingest to execute** |

*Mainnet-beta, Helius RPC, m6i.large*

## Quick Start

```bash
docker compose up -d postgres redis
npm install
cp .env.example .env
npx prisma migrate dev
npm run dev
```

## Docker

```bash
docker compose up --build
```

Multi-stage build. Minimal production image. Runs as non-root.

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

## CyclAwps Node

This engine is the execution layer. For autonomous AI-powered operation — agent swarms, shared intelligence across nodes, deployer reputation scoring, wallet graph analysis, and LLM-driven decision making — see [cyclawps-node](https://github.com/controlborgs/cyclawps-node).
