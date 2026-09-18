# transaction-scheduler-service

Standalone microservice for **BitGo smart transactions**. A smart transaction stores one send intent plus one rule. When the rule becomes true, the worker creates the BitGo transaction through the normal BitGo pipeline.

Rules supported now:

- **Timestamp** — send at/after a configured time.
- **Sender balance above** — sweep sender balance down to `leaveBalance`.
- **Recipient balance below/above** — send a fixed amount from the sender wallet to the monitored recipient wallet/address.

---

## Highlights

- **Node 22 / TypeScript / Express / MongoDB**.
- **One API** — `/api/v1/smart-transactions` handles scheduled sends, sender sweep, recipient top-up, and hot/cold rebalance.
- **Smart collections** — smart transactions use `smartTxns`; executions use `smartTxnExecutions`.
- **Claim-based worker, no Temporal** — `findOneAndUpdate` claims one ready occurrence; replicas are safe.
- **Balance pre-check** — sender balance is checked before transaction creation; insufficient funds becomes a default.
- **Recipient monitoring** — recipient balance rules can monitor `recipient.walletId`; enterprise fee-address checks can use `enterpriseId`.
- **Notifications sink** — structured logs by default; optional webhook/Kafka.

## Requirements

- Node.js 22+.
- MongoDB (`make local-up` or local `mongod`).
- BitGo testnet access token + funded wallet for real sends.

## Getting started

```bash
make install
cp .env.example .env
make typecheck
make test
make build
make local-up
make run-api
make run-worker
make run-reaper # optional stuck-claim reaper
```

## Developer commands

| Command | Description |
|---------|-------------|
| `make install` | Install npm dependencies |
| `make build` | Compile TypeScript to `dist/` |
| `make typecheck` | Typecheck without emitting |
| `make test` | Run vitest suite |
| `make run-api` | Run API in dev |
| `make run-worker` | Run the smart transaction worker |
| `make run-reaper` | Run stuck-claim reaper |
| `make local-up` / `local-down` | Start/stop local MongoDB |

## Quick API tour

```bash
export API=http://localhost:3000/api/v1
export KEY="x-api-key: dev-api-key"

# Timestamp smart transaction
curl -X POST $API/smart-transactions -H "$KEY" -H "content-type: application/json" \
  -d '{"fromWalletId":"<walletId>","coin":"tbaseeth",
       "recipient":{"address":"0xde709f2102306220921060314715629080e2fb77","amount":"50000"},
       "rule":{"type":"timestamp","at":"2026-10-01T00:00:00Z"}}'

# Sender sweep: if sender balance > 150, send balance - 100 and leave 100
curl -X POST $API/smart-transactions -H "$KEY" -H "content-type: application/json" \
  -d '{"fromWalletId":"<hotWalletId>","coin":"tbaseeth",
       "recipient":{"address":"0xvault"},
       "rule":{"type":"balance","monitor":"sender","operator":"above","threshold":"150","leaveBalance":"100"}}'

# Hot/cold rebalance: if hot wallet balance < 100, send fixed 500 from cold to hot
curl -X POST $API/smart-transactions -H "$KEY" -H "content-type: application/json" \
  -d '{"fromWalletId":"<coldWalletId>","coin":"tbaseeth",
       "recipient":{"walletId":"<hotWalletId>","address":"0xhot","amount":"500"},
       "rule":{"type":"balance","monitor":"recipient","operator":"below","threshold":"100"},
       "repeat":true}'

# List / fetch / history
curl $API/smart-transactions -H "$KEY"
curl $API/smart-transactions/<id> -H "$KEY"
curl $API/smart-transactions/<id>/executions -H "$KEY"

# Manual worker tick for demo/testing
curl -X POST $API/worker/tick -H "$KEY"
```

## Repository layout

```text
src/
  server.ts          # Express bootstrap
  app.ts             # app factory
  config/env.ts      # env vars
  models/            # smartTxns + smartTxnExecutions schemas
  routes/            # REST routes
  controllers/       # request handlers
  services/          # smartTransactionService, bitgoClient, executionService,
                     # notificationService, webhookService
  workers/           # cronWorker, reaper
  utils/             # frequency, recipients, logger, db, asyncHandler
test/                # vitest suite
kustomize/           # base + env overlays
local-stack/         # docker-compose for local MongoDB
```


## License

Apache-2.0
