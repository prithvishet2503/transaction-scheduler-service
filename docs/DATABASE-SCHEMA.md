# Database Schema

MongoDB via Mongoose. Two collections.

## `scheduledTransactions`

The standing instruction ("from this wallet, send this amount to this address, this often").

| field | type | notes |
|-------|------|-------|
| `_id` | ObjectId | |
| `userId` | string | owning user (indexed) |
| `enterpriseId` | string? | |
| `walletId` | string | BitGo wallet id (indexed) |
| `coin` | string | e.g. `tbtc` |
| `destinationAddress` | string | validated per coin at create/edit |
| `amount` | string | **base units as string** (avoids JS precision loss) |
| `frequency` | enum `one_time, daily, weekly, monthly` | |
| `startAt` | Date? | |
| `endAt` | Date? | when reached → `completed` |
| `timezone` | string | IANA zone; `nextRunAt` computed in this zone |
| `note` | string? | |
| `reminderOffsetMs` | number | default 24 h, min 1 h (FR-14) |
| `status` | enum `active, paused, cancelled, completed` | |
| `nextRunAt` | Date? | indexed; `null` → completed |
| `lastRunAt` | Date? | |
| `consecutiveDefaultedCount` | number | escalates alerts (≥1 warn, ≥3 strong) |
| `lastReminderSentForRunAt` | Date? | exactly-once reminders per occurrence |
| `createdAt` / `updatedAt` | Date | |

Indexes: `{ userId }`, `{ walletId }`, `{ status: 1, nextRunAt: 1 }` (worker due-scan).

## `scheduleExecutions`

One row per concrete occurrence of a schedule.

| field | type | notes |
|-------|------|-------|
| `_id` | ObjectId | |
| `scheduleId` | ObjectId → scheduledTransactions | |
| `scheduledFor` | Date | when this occurrence was due |
| `status` | enum `scheduled, claimed, executed, defaulted, pending_approval, failed, confirmed` | |
| `reason` | string? | e.g. `INSUFFICIENT_BALANCE` |
| `balanceSnapshot` | `{ spendable, maximumSpendable }`? | captured at precheck (US-6) |
| `txid` | string? | set on `executed` |
| `pendingApprovalId` | string? | set on `pending_approval` |
| `attempt` | number | retry counter |
| `leasedBy` | string? | worker id holding the claim |
| `leasedUntil` | Date? | claim expiry (reaper re-arms after this) |
| `sequenceId` | string | `scheduleId:scheduledForEpochMs` — idempotency for `sendMany` |
| `error` | string? | last failure detail |
| `createdAt` / `updatedAt` | Date | |

Indexes:
- **unique** `{ scheduleId: 1, scheduledFor: 1 }` — prevents duplicate ticks (FR-5).
- `{ status: 1, scheduledFor: 1 }` — worker due-scan + reaper stuck-claim scan.
- `{ txid: 1 }`, `{ sequenceId: 1 }` — webhook confirmation lookup.
