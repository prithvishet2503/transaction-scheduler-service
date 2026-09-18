#!/usr/bin/env bash
# service-config.sh — prints service metadata used by CI/CD.
# Mirrors the pattern used by other BitGo microservices.
set -euo pipefail

SERVICE="transaction-scheduler-service"
REPO="${REPO:-bitgo/transaction-scheduler-service}"
PORT="${PORT:-3000}"
COINS="${COINS:-tbaseeth}"

cat <<EOF
{
  "service": "$SERVICE",
  "repo": "$REPO",
  "port": $PORT,
  "stack": "node/typescript/express/mongodb",
  "scheduling": "claim-based mongo cron worker (no temporal)",
  "coins": "$COINS"
}
EOF
