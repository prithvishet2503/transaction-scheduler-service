# Transaction Scheduler Service — Architecture

## System context

```
                       ┌─────────────────────────────────────────────┐
 Retail UI (bitgo-      │        transaction-scheduler-service        │
 retail)                │                                             │
  Schedule button ─────▶│  Express API  ──▶  Mongo (schedules,        │
  (isSpender)           │   /api/v1/schedules        executions)      │
                        │        │                                    │
                        │  Cron worker (30s claim loop) ──────────────┼──▶ BitGoJS SDK
                        │        │                                    │       │
                        │  Reaper (stuck claims)                      │  wallets().get()
                        │  NotificationService ──▶ NCC/Kafka/webhook  │  sendMany()
                        │                                             │       │
                        └─────────────────────────────────────────────┘       ▼
                                                                    BitGo pipeline
                                                              prebuild → sign → submit
                                                              → policy/approvals → SendQueue → broadcast
```

The service is **standalone**: it owns its database and runs its own worker. It does **not** touch wallet-platform's release train (see PRD Appendix B). It talks to BitGo through the **BitGoJS SDK** exactly like a manual retail send, so every execution inherits BitGo policies and approvals.

## Components

| Component | Responsibility |
|-----------|----------------|
| Express API | Create / list / get / edit / pause / resume / cancel schedules; execution history; BitGo transfer webhook; manual worker tick. |
| Cron worker | Every `WORKER_POLL_INTERVAL_MS` (30 s) scans due schedules and processes each occurrence via an atomic claim. Also fires upcoming reminders. |
| Reaper | Re-arms `claimed` executions whose lease expired (worker crash recovery). |
| BitGoClient | Wraps the BitGoJS SDK: wallet lookup, `isValidAddress`, `checkBalance` (`spendableBalanceString` + `maximumSpendable`), `sendMany`. |
| ExecutionService | The per-occurrence state machine: claim → balance precheck → send → default/approval/failure handling, retry with backoff, advance `nextRunAt`. |
| NotificationService | Emits reminder / defaulted / failed events to a pluggable sink (log, webhook, Kafka/NCC). |

## Scheduling model (no Temporal)

Scheduling is **claim-based DB polling**, mirroring wallet-platform's MongoDB `Task` model + `runAt` and its stuck-state cronjob pattern — but self-contained and Temporal-free.

1. **Due scan:** worker finds `ScheduledTransaction` where `status='active' AND nextRunAt <= now AND (endAt is null OR endAt >= now)`.
2. **Occurrence upsert:** creates a `ScheduleExecution` row with `scheduledFor = nextRunAt`, guarded by a **unique `{scheduleId, scheduledFor}` index** — a duplicate tick cannot create a second row.
3. **Atomic claim:** `findOneAndUpdate({ _id, status:'scheduled' }, { status:'claimed', leasedBy, leasedUntil }, { new:true })`. Exactly one worker wins; others get `null` and skip.
4. **Execute:** balance precheck → `sendMany` → record result. `nextRunAt` is advanced (or the schedule completes for `one_time`/end date).
5. **Crash recovery:** if a worker dies mid-claim, `leasedUntil` expires and the **reaper** flips the row back to `scheduled` for re-claiming.

Duplicate execution is therefore impossible even with N worker replicas: uniqueness at step 2 + atomicity at step 3.

## Execution state machine

```
scheduled ──claim──▶ claimed ──balance precheck──▶
    ▲                  │                          ├─ sufficient ──▶ executed ──webhook──▶ confirmed
    │                  │                          │                   │
    │                  │                          │                   └─(pendingApprovalId)──▶ pending_approval ──approval──▶ confirmed
    │                  ▼                          ├─ insufficient ──▶ defaulted (alert + email)
    └──retry(backoff)── error ────────────────────└─ error ──▶ retry (≤3) else failed (alert)
```

- `defaulted`: no transaction started; schedule stays active; `consecutiveDefaultedCount` increments.
- `pending_approval`: BitGo policy/approval intercepted the tx — not an error; resolves via the normal approval flow, then `confirmed`.
- `confirmed`: only on a BitGo **transfer webhook** (async settlement).

## Idempotency & retries

- `sequenceId = <scheduleId>:<scheduledForEpochMs>` passed to `sendMany` makes retries idempotent (FR-6).
- Send failures retry up to `WORKER_MAX_ATTEMPTS` with `RETRY_BACKOFF_MS` (1m/5m/25m) by re-arming the occurrence (FR-9).
- Notifications carry an `idempotencyKey` (execution id + type) for exactly-once reminders (FR-14).

## Notifications

Default = structured log. Optional sinks:
- `NOTIFY_WEBHOOK_URL` — POST a JSON payload per event.
- `KAFKA_BROKERS` — publish to `tx-scheduler-notifications` for an NCC-like consumer (NCC owns templates + SendGrid in production).

## Scaling & resilience

- Stateless API + N stateless worker replicas sharing Mongo; the claim mechanism makes N replicas safe.
- Reaper runs on a separate process to re-arm stuck claims.
- Worker crash / process restart is safe: due schedules are picked up on the next tick.
