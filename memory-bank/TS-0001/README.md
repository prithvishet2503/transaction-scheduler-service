# TS-0001 — Transaction Scheduler Service (hackathon demo)

## Context
Standalone microservice implementing the recurring-payment PRD. Node/TS/Express/MongoDB (required to use BitGoJS), claim-based cron worker (no Temporal), hardcoded keys for the demo (no KMS).

## Decisions
- **Stack:** Node 22 / TypeScript / Express / MongoDB — matches the PRD's pinned stack and enables the BitGoJS SDK.
- **Scheduling:** 30 s claim-based Mongo poll + unique `{scheduleId, scheduledFor}` index + atomic `findOneAndUpdate` claim; reaper re-arms stuck claims. Exactly-once per occurrence with N replicas.
- **Execution:** `wallet.sendMany` via BitGoJS; two-layer balance default (precheck `spendableBalanceString` + server `insufficient_funds`); `pending_approval` is first-class; `confirmed` via transfer webhook.
- **Notifications:** self-contained sink (log + optional webhook/Kafka). NCC path documented for prod.
- **Coin registration:** per-coin class resolved by name (`tbaseeth → Eth`, `tbtc → Tbtc`); validated live against testnet.

## Verification
- `make typecheck` ✓, `make test` (12 tests) ✓, `make build` ✓.
- Live smoke against local MongoDB: create schedule (strict tbaseeth address validation) → worker tick atomically claimed the occurrence, fired reminder, attempted balance check (pause-safe with placeholder token). Real on-chain send requires a funded testnet wallet + token in `.env`.

## Open items (from PRD §12)
- OQ-1 access-token scope literals; OQ-2 transfer-confirmed webhook schema; OQ-3 NCC templates; OQ-4 Kafka access; OQ-5 compliance; OQ-6 OTP/spend limits.
