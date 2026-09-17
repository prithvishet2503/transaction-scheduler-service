# transaction-scheduler-service

A standalone microservice for **recurring scheduled crypto payments** on BitGo. It stores schedules, runs a claim-based cron worker that executes due payments through the **normal BitGo pipeline** (BitGoJS SDK → `sendMany` → prebuild/sign/submit → policy/approvals → SendQueue → broadcast), and alerts the user before each run and on every default.

Implements the requirements in `PRD.md` (see [docs](./docs)).

---

## Highlights

- **Node 22 / TypeScript / Express / MongoDB** — the stack required to use the BitGoJS packages.
- **Claim-based cron worker, no Temporal** — a 30 s poll loop atomically claims due schedules via `findOneAndUpdate` + a unique `{scheduleId, scheduledFor}` index. Any number of worker replicas are safe (exactly-once execution per occurrence).
- **Balance pre-check (two-layer)** — the scheduler checks `spendableBalanceString` / `maximumSpendable` before sending; a server-side `insufficient_funds` is also mapped to a **default** (no transaction, alert + email).
- **First-class states** — `pending_approval` is not an error; `confirmed` arrives via a BitGo transfer webhook.
- **Reminders (FR-14)** — one upcoming-payment reminder per occurrence at `nextRunAt − reminderOffset`.
- **Notifications sink** — structured logs by default; optional JSON webhook (`NOTIFY_WEBHOOK_URL`) and/or Kafka (NCC path).
- **Hackathon demo** — keys are hardcoded via `.env` (no KMS) and can create **real on-chain testnet transactions** once a testnet access token + wallet are supplied.

## Requirements

- **Node.js 22+** (BitGo SDK packages require `>=22`).
- A running MongoDB (`make local-up` or a local `mongod`).
- A BitGo **testnet** access token + a funded hot wallet + its passphrase for real sends.

## Getting started

```bash
# 1. Install deps
make install

# 2. Configure secrets (testnet)
cp .env.example .env
#    edit .env: BITGO_ACCESS_TOKEN, BITGO_WALLET_PASSPHRASE, COINS

# 3. Verify
make typecheck
make test
make build

# 4. Start MongoDB (local stack) if you don't have one
make local-up

# 5. Run the API + worker (two processes, or both in dev)
make run-api          # terminal 1 — Express API on :3000
make run-worker       # terminal 2 — cron worker
#    optional: node dist/workers/reaper.js  # re-arms stuck claims
```

## Developer commands

| Command | Description |
|---------|-------------|
| `make install` | Install npm dependencies |
| `make build` | Compile TypeScript to `dist/` |
| `make typecheck` | Typecheck without emitting |
| `make test` | Run vitest suite |
| `make run-api` | Run API in dev (tsx watch) |
| `make run-worker` | Run the cron worker |
| `make run-reaper` | Run the stuck-claim reaper |
| `make local-up` / `local-down` | Start/stop local MongoDB stack |
| `make lint` / `make format` | Lint / format |

## Quick API tour

```bash
export API=http://localhost:3000/api/v1
export KEY="x-api-key: dev-api-key"

# Create a schedule (zero balance is fine)
curl -X POST $API/schedules -H "$KEY" -H "content-type: application/json" \
  -d '{"walletId":"<walletId>","coin":"tbtc","destinationAddress":"tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",\
       "amount":"50000","frequency":"weekly","timezone":"UTC"}'

# List schedules
curl $API/schedules -H "$KEY"

# Manually run one worker tick (demo/testing)
curl -X POST $API/worker/tick -H "$KEY"

# Execution history
curl $API/schedules/<id>/executions -H "$KEY"

# BitGo transfer webhook -> marks execution 'confirmed'
curl -X POST $API/webhooks/bitgo -H "x-bitgo-signature: dev-webhook-secret" \
  -H "content-type: application/json" -d '{"transfer":{"txid":"<txid>"}}'
```

## Repository layout

```
src/
  server.ts          # Express bootstrap
  app.ts             # app factory
  config/env.ts      # env vars (hardcoded keys for demo)
  models/            # Mongoose models (ScheduledTransaction, ScheduleExecution)
  routes/            # REST routes
  controllers/       # request handlers
  services/          # bitgoClient, scheduleService, executionService,
                     #   notificationService, webhookService
  workers/           # cronWorker (claim loop), reaper (stuck claims)
  utils/             # frequency (computeNextRun), logger, db, asyncHandler
test/                # vitest suite
docs/                # architecture, db schema, dev guide, integrations
kustomize/           # base + env overlays
local-stack/         # docker-compose for local MongoDB
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, worker/claim model, states
- [docs/DATABASE-SCHEMA.md](docs/DATABASE-SCHEMA.md) — collections, indexes, state machine
- [docs/EXTERNAL-INTEGRATIONS.md](docs/EXTERNAL-INTEGRATIONS.md) — BitGoJS SDK, NCC notifications, webhooks
- [docs/DEVELOPMENT-GUIDE.md](docs/DEVELOPMENT-GUIDE.md) — local run, testnet provisioning, troubleshooting

## License

Apache-2.0
