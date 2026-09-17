# CLAUDE.md

## What this is

`transaction-scheduler-service` — a standalone BitGo microservice for recurring scheduled crypto payments. Express + MongoDB + BitGoJS SDK. Claim-based cron worker (no Temporal).

## Commands

```bash
make install        # npm install
make typecheck      # tsc --noEmit
make test           # vitest
make build          # tsc -> dist/
make run-api        # API on :3000
make run-worker     # cron worker
make run-reaper     # stuck-claim reaper
make local-up/down  # local MongoDB stack
```

## Architecture (30-second tour)

- `src/models/ScheduledTransaction.ts` + `ScheduleExecution.ts` — two Mongo collections.
- `src/services/executionService.ts` — the core state machine:
  `ensureExecution` (unique per occurrence) → `claimExecution` (atomic) → `executeOccurrence` (balance precheck → `sendMany`) → default/approval/failure handling → `advanceSchedule`.
- `src/workers/cronWorker.ts` — 30 s due-scan + claim loop (FR-5).
- `src/workers/reaper.ts` — re-arms stuck `claimed` rows.
- `src/services/bitgoClient.ts` — BitGoJS SDK wrapper (coin registration, balance, send).
- `src/services/notificationService.ts` — reminder/default/failed events → log + webhook + Kafka.
- `src/utils/frequency.ts` — `computeNextRun` (daily/weekly/monthly, month-end clamp, IANA zones).

## Key invariants

- **Exactly-once per occurrence:** unique `{scheduleId, scheduledFor}` index + atomic `findOneAndUpdate` claim. Do not weaken either.
- **`pending_approval` is not an error** (FR-7) — it resolves via the normal approval flow, then `confirmed`.
- **`defaulted` never cancels the schedule** (FR-13); `consecutiveDefaultedCount` escalates alerts.
- **Balance is pre-checked** (FR-10); server-side `insufficient_funds` also maps to default (FR-11).
- **No balance check at creation** (FR-4) — zero-balance wallets are accepted.
- **Retry:** ≤ `WORKER_MAX_ATTEMPTS` with `RETRY_BACKOFF_MS` backoff (FR-9); `sequenceId` makes sends idempotent.

## Conventions

- Amounts are **strings in base units** — never `Number` (precision loss).
- Errors: throw `ScheduleError(message, status)` from services; `asyncHandler` forwards to Express error middleware (Express 4 does not catch async rejections).
- Env: all keys read in `src/config/env.ts` (hardcoded for the demo; no KMS).
- Tests: vitest; keep pure logic (frequency, state machine) unit-tested.

## Don't

- Don't add Temporal/Bull/Agenda — scheduling is claim-based polling by design.
- Don't store wallet passphrases in code; keep them in `.env` (demo) or a secret manager (prod).
- Don't block schedule creation on balance.
