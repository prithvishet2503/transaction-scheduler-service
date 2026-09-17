#!/usr/bin/env bash
# service-config.sh — prints the service metadata used by CI/CD and docs.
# Mirrors the pattern used by other BitGo microservices.
set -euo pipefail

SERVICE="transaction-scheduler-service"
REPO="${REPO:-bitgo/transaction-scheduler-service}"
PORT="${PORT:-3000}"
COINS="${COINS:-tbtc}"

cat <<EOF
{
  "service": "$SERVICE",
  "repo": "$REPO",
  "port": $PORT,
  "stack": "node/typescript/express/mongodb",
  "scheduling": "claim-based mongo cron worker (no temporal)",
  "coins": "$COINS",
  "docs": "https://github.com/$REPO/blob/master/docs/README.md"
}
EOF
