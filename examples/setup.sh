#!/bin/bash
# CyclAwps — Full setup walkthrough
# Run each section step by step. Do not run this as a single script.

# ============================================================
# 1. Register a wallet to monitor
# ============================================================

WALLET_RESPONSE=$(curl -s -X POST http://localhost:3100/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "address": "YourSolanaWalletAddressHere",
    "label": "main-trading-wallet"
  }')

echo "$WALLET_RESPONSE"
WALLET_ID=$(echo "$WALLET_RESPONSE" | jq -r '.id')
echo "Wallet ID: $WALLET_ID"

# ============================================================
# 2. Track a token on that wallet
# ============================================================

curl -s -X POST "http://localhost:3100/wallets/${WALLET_ID}/tokens" \
  -H "Content-Type: application/json" \
  -d '{
    "mintAddress": "FKPvoUKtnWwPi73SGLQrAux9DeP9RD8eGqrzcwynpump",
    "symbol": "CYCLAWPS",
    "decimals": 9,
    "devWallet": "optional-dev-wallet-address"
  }' | jq .

# ============================================================
# 3. Create policies for automatic protection
# ============================================================

# Exit if dev dumps more than 30% in 10 minutes
curl -s -X POST http://localhost:3100/policies \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Dev sell > 30% — full exit",
    "trigger": "DEV_SELL_PERCENTAGE",
    "threshold": 30,
    "windowSeconds": 600,
    "action": "EXIT_POSITION",
    "priority": 10
  }' | jq .

# Partial sell if price drops 20%
curl -s -X POST http://localhost:3100/policies \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Price drop > 20% — trim position",
    "trigger": "PRICE_DROP_PERCENTAGE",
    "threshold": 20,
    "windowSeconds": 300,
    "action": "PARTIAL_SELL",
    "actionParams": {
      "sellPercentage": 50,
      "maxSlippageBps": 500
    },
    "priority": 7
  }' | jq .

# ============================================================
# 4. Open a position via PumpFun bonding curve
# ============================================================

curl -s -X POST http://localhost:3100/positions \
  -H "Content-Type: application/json" \
  -d "{
    \"walletId\": \"${WALLET_ID}\",
    \"mintAddress\": \"FKPvoUKtnWwPi73SGLQrAux9DeP9RD8eGqrzcwynpump\",
    \"solAmount\": 0.5,
    \"maxSlippageBps\": 300,
    \"priorityFeeLamports\": 50000
  }" | jq .

# ============================================================
# 5. Check your positions
# ============================================================

curl -s "http://localhost:3100/positions?status=OPEN" | jq .

# ============================================================
# 6. Check execution history
# ============================================================

curl -s "http://localhost:3100/executions?status=CONFIRMED" | jq .

# ============================================================
# 7. Health check
# ============================================================

curl -s http://localhost:3100/health | jq .
