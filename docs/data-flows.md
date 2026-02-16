# CyclAwps — Data Flows

How data moves through the engine, from on-chain event to executed transaction.

---

## Architecture Overview

```
Solana RPC (WebSocket)
       │
       ▼
┌─────────────────┐
│ EventIngestion   │──► EventLog (DB)
└────────┬────────┘
         │ emit
         ▼
┌─────────────────┐
│    EventBus      │
└──┬──────────┬───┘
   │          │
   ▼          ▼
┌──────┐  ┌───────────┐
│State │  │  Policy    │
│Engine│  │  Engine    │
└──┬───┘  └─────┬─────┘
   │            │ evaluations
   │            ▼
   │    ┌──────────────┐
   └───►│ Orchestrator  │
        └──────┬───────┘
               │ ExecutionRequest
               ▼
        ┌──────────────┐
        │  Risk Engine  │
        └──────┬───────┘
               │ approved
               ▼
        ┌──────────────┐
        │  Execution    │──► Solana TX
        │  Engine       │──► Position (DB)
        └──────────────┘    Execution (DB)
```

---

## Module-by-Module

### 1. Event Ingestion

The entry point. Listens to Solana via WebSocket subscriptions.

| Direction | What |
|-----------|------|
| **In** | Solana `onAccountChange` callbacks for tracked wallets and dev wallets |
| **Out** | `WALLET_TRANSACTION` events on EventBus |
| **Out** | `DEV_WALLET_SELL` events on EventBus |
| **Writes** | `eventLog` table (async, fire-and-forget) |
| **Reads** | `wallet` + `trackedToken` tables on startup |

**Startup behavior**: Loads all active wallets and their tracked tokens from the database. Creates WebSocket subscriptions for each wallet address and each dev wallet address. Maintains in-memory maps of wallet metadata and mint-to-devWallet associations.

**Event generation**: Raw Solana account changes are converted into typed `InternalEvent` objects with UUIDs, timestamps, and structured payloads. Each event is emitted on the EventBus and persisted to `eventLog` asynchronously.

---

### 2. EventBus

Node.js EventEmitter with typed channels. Every event flows through here.

| Channel | Payload | Publishers | Subscribers |
|---------|---------|------------|-------------|
| `event` | Any `InternalEvent` | EventIngestion | PolicyEngine, Orchestrator |
| `DEV_WALLET_SELL` | Dev sell event | EventIngestion | StateEngine |
| `LP_REMOVE` | LP removal event | EventIngestion | StateEngine |
| `WALLET_TRANSACTION` | Wallet tx event | EventIngestion | — |

Max 50 listeners. Every `.emit()` publishes to both the type-specific channel and the generic `event` channel.

---

### 3. State Engine

In-memory state store. The single source of truth for positions, dev wallet metrics, and LP states.

| Direction | What |
|-----------|------|
| **In** | `DEV_WALLET_SELL` events via EventBus |
| **In** | `LP_REMOVE` events via EventBus |
| **In** | Position updates from ExecutionEngine |
| **Out** | Position queries (by mint, by ID, all open) |
| **Out** | Dev wallet sell metrics (percentage in window, total count) |
| **Out** | LP state queries |
| **Writes** | Redis `clawops:state:snapshot` every 30s (300s TTL) |
| **Reads** | `position` table on startup (status=OPEN) |

**Dev wallet tracking**: Maintains sliding windows of dev sell events per `mint:devWallet` pair. Calculates sell percentages within configurable time windows for PolicyEngine queries.

**State snapshots**: Every 30 seconds, serializes all positions, dev metrics, and LP states to Redis. Acts as a warm cache for fast restarts.

---

### 4. Policy Engine

Rule evaluator. Checks every event against all active policies.

| Direction | What |
|-----------|------|
| **In** | All events via EventBus (`event` channel) |
| **In** | Policy CRUD via API routes |
| **Out** | `PolicyEvaluationResult[]` returned to Orchestrator |
| **Reads** | StateEngine (dev sell %, sell count, LP removal %) |
| **Reads** | `policy` table on startup (isActive=true) |

**Trigger types and data sources**:

| Trigger | Data Source | Logic |
|---------|-------------|-------|
| `DEV_SELL_PERCENTAGE` | StateEngine.getDevSellPercentage() | Sell % > threshold in window |
| `DEV_SELL_COUNT` | StateEngine.getDevSellCount() | Total sells > threshold |
| `LP_REMOVAL_PERCENTAGE` | StateEngine.getLPRemovalPercentage() | LP removed % > threshold |
| `SUPPLY_INCREASE` | Event payload | Supply change % > threshold |
| `PRICE_DROP_PERCENTAGE` | — | Stubbed (MVP) |

Results are sorted by priority (highest first). The Orchestrator acts on the highest-priority triggered policy.

---

### 5. Orchestrator

The dispatcher. Connects policy evaluations to execution requests.

| Direction | What |
|-----------|------|
| **In** | All events via EventBus |
| **In** | `PolicyEvaluationResult[]` from PolicyEngine |
| **Out** | `ExecutionRequest` to ExecutionEngine |
| **Reads** | StateEngine (open positions by mint) |

**Action mapping**:

| Policy Action | Execution Action | Sell % |
|--------------|-----------------|--------|
| `EXIT_POSITION` | `FULL_EXIT` | 100% |
| `PARTIAL_SELL` | `PARTIAL_SELL` | from actionParams (default 50%) |
| `HALT_STRATEGY` | `HALT` | 0% (stops processing) |
| `ALERT_ONLY` | — | No execution |

**Concurrency**: Simple mutex flag prevents overlapping event processing. Events that arrive during processing are dropped.

---

### 6. Risk Engine

Pre-execution gate. Every execution request must pass all risk checks.

| Direction | What |
|-----------|------|
| **In** | `ExecutionRequest` from ExecutionEngine |
| **Out** | `RiskCheckResult { approved, violations[] }` |
| **Reads** | StateEngine (position data) |

**Risk checks**:

| Check | Rule | Source |
|-------|------|--------|
| `MAX_SLIPPAGE` | maxSlippageBps ≤ configured limit | Env: `MAX_SLIPPAGE_BPS` |
| `MAX_PRIORITY_FEE` | priorityFeeLamports ≤ configured limit | Env: `MAX_PRIORITY_FEE_LAMPORTS` |
| `EXECUTION_COOLDOWN` | time since last exec ≥ cooldown | Env: `EXECUTION_COOLDOWN_MS` |
| `MAX_POSITION_SIZE` | entry amount ≤ SOL limit | Env: `MAX_POSITION_SIZE_SOL` |
| `INVALID_SELL_PERCENTAGE` | 0 < sellPercentage ≤ 100 | Request payload |

Cooldown tracking is in-memory per position. Updated only when all checks pass.

---

### 7. Execution Engine

Builds, simulates, and sends Solana transactions.

| Direction | What |
|-----------|------|
| **In** | `ExecutionRequest` from Orchestrator |
| **Out** | Signed transaction → Solana |
| **Out** | `ExecutionResult` |
| **Writes** | `execution` table (full tx details) |
| **Writes** | `position` table (balance, status, closedAt) |
| **Reads** | StateEngine (position data) |
| **Reads** | PumpFun bonding curve (quote) |

**Execution pipeline**:

```
1. RiskEngine.validate(request)     → reject if violations
2. StateEngine.getPosition(id)       → get current balance
3. Calculate sell amount              → balance × sellPercentage
4. PumpFun.getSellQuote(mint, amount) → expected SOL output
5. Apply slippage                     → minSolOutput
6. Build transaction                  → compute budget + PumpFun sell IX
7. Simulate                           → catch errors before sending
8. Send with retries                  → max 3 attempts, exponential backoff
9. Confirm on-chain                   → wait for confirmation
10. Update StateEngine                → new balance, status
11. Persist to database               → execution record + position update
```

---

## End-to-End Flows

### Opening a Position (Manual via API)

```
User POST /positions
  → Validate wallet exists
  → Get PumpFun buy quote
  → Build buy transaction (compute budget + PumpFun buy IX)
  → Simulate transaction
  → Send transaction to Solana
  → Create position record (DB, status=OPEN)
  → StateEngine.addPosition()
  → Return { positionId, txSignature }
```

### Automated Exit (Dev Dumps Tokens)

```
Solana WebSocket → dev wallet balance changes
  → EventIngestion creates DEV_WALLET_SELL event
  → EventBus delivers to StateEngine + PolicyEngine + Orchestrator

StateEngine:
  → Records sell event in sliding window
  → Updates dev sell percentage

PolicyEngine (via Orchestrator):
  → Evaluates all policies against event
  → "Dev sell > 30%" policy triggers
  → Returns [{ action: EXIT_POSITION, priority: 10 }]

Orchestrator:
  → Gets open positions for mint from StateEngine
  → Maps EXIT_POSITION → FULL_EXIT (100%)
  → Sends ExecutionRequest to ExecutionEngine

ExecutionEngine:
  → RiskEngine approves
  → Gets PumpFun sell quote
  → Builds, simulates, sends sell transaction
  → Confirms on Solana
  → Updates position to CLOSED
  → Persists execution record
```

---

## Database Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `wallet` | Tracked wallet addresses | address, label, isActive |
| `trackedToken` | Mint addresses linked to wallets | mintAddress, symbol, decimals, devWallet |
| `position` | Open/closed positions | walletId, mintAddress, tokenBalance, status |
| `policy` | Declarative risk policies | trigger, threshold, action, priority, isActive |
| `execution` | Execution audit trail | positionId, policyId, txSignature, status |
| `eventLog` | Raw event log | type, payload, source, processedAt |

## Redis Keys

| Key | Purpose | TTL |
|-----|---------|-----|
| `clawops:state:snapshot` | State engine warm cache | 300s |
