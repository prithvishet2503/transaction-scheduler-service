# Transaction Scheduler Service — Product Requirements Document

**Status:** Draft for review · **Date:** 2026-09-17 · **Owner:** Wallet Platform / Retail
**Companion documents:** [HLD.md](./HLD.md) (architecture), [LLD.md](./LLD.md) (detailed design), [DFD.md](./DFD.md) (data flows). Requirement identifiers: R1–R6 are the product owner's hard requirements; D1–D10 refer to pinned design decisions in `SCHEDULER-BRIEF.md`.

## Preface

A **scheduled payment** is a standing instruction: "from this wallet, send this amount to this address, this often, starting on this date." An **execution** (occurrence) is one concrete run of that instruction. An execution is **defaulted** when, at run time, the wallet does not hold enough **spendable balance** (funds actually movable now — excludes unconfirmed or held funds); no transaction is started. An **upcoming-payment reminder** warns the user ahead of each run so they can fund the wallet in time.

The problem this note solves: BitGo retail customers who want recurring payments (rent, payroll-like transfers, DCA buys) must open the app and send manually every time. We add a standalone **Transaction Scheduler Service** that stores schedules, runs a cron-style worker, executes due payments through BitGo's normal transaction pipeline, and alerts the user on every upcoming run and every default.

## TL;DR

- **Need:** recurring crypto payments from retail wallets without manual repetition.
- **Build:** "Schedule Transaction" UI in bitgo-retail; standalone `tx-scheduler-service` (Node/TypeScript/Express/MongoDB) with a 30-second claim-based cron worker; execution via BitGo JS SDK `sendMany`; reminders and defaulted alerts via the platform's NCC (Notification Command Center) email pipeline.
- **Key decisions:** Mongo atomic-claim scheduling (no new queue infra); long-lived spend-scoped access token for headless execution; policy/approval interception is a first-class `pending_approval` state, not an error.
- **Caveats:** access-token scope strings and transfer-confirmed webhook type literals are not discoverable in the BitGoJS repo — two open items; NCC needs three new email templates; compliance must review pre-authored transfer instructions.

## 1. Problem & opportunity

Today a retail user sends crypto through a manual, multi-step dialog (withdraw form, review, OTP/password confirmation) — see the withdraw flow in `apps/retail-web/src/components/TransferDialogs/Transfer/Withdraw/WithdrawSteps/WithdrawForm/WithdrawFormStep.tsx` and validation in `withdrawSchema.ts:35-107` (repo bitgo-retail). The only automation concept in the app is the TWAP (time-weighted average price) trade automations table (`apps/retail-web/src/routes/_app/$enterpriseId/_appLayout/_searchLayout/trade/_tradeLayout/automations.lazy.tsx`) — there is no recurring-payment capability anywhere in the stack.

Manual repetition fails the user in predictable ways: missed payments, and — when funds are short — silent failure with no warning. The platform already runs every send through policy checks and approvals (BitGo policy/approval interception surfaces as `status: 'pendingApproval'`, BitGoJS `wallet.ts:5316-5331`), so scheduled executions can reuse the exact governance path a manual send uses.

## 2. Goals & non-goals

**Goals**
1. A user can create, view, pause/resume, edit, and cancel scheduled payments from bitgo-retail.
2. Due payments execute automatically through the same BitGo pipeline as a manual send, including policies and approvals.
3. The user is warned before each execution and clearly told when a payment could not be funded.

**Non-goals for v1** (from brief D10): no editing of executions after broadcast; no manual retry button; no multi-recipient schedules; no fiat auto-buy to fund wallets; no public/third-party scheduler API.

## 3. Personas

- **Retail user (primary):** holds one or more BitGo wallets in the app; wants a payment to happen on schedule and to hear about problems immediately.
- **Ops/support engineer:** needs to answer "why didn't my scheduled payment send?" from execution history and logs, and to page in when the worker is wedged.
- **Compliance reviewer:** must confirm that pre-authored transfer instructions still pass sanctions/screening and wallet policies at execution time.

## 4. User stories & acceptance criteria

| # | Story | Acceptance criteria |
|---|---|---|
| US-1 | As a user, I schedule a payment from any wallet, even with zero balance (R4). | Creation succeeds regardless of balance; the form shows a hint that execution requires funds; the schedule is persisted in the scheduler service's own database (R2). |
| US-2 | As a user, I am warned before an upcoming payment (R6). | One reminder (in-app alert + email) is sent `reminderOffset` before each occurrence (default 24 h, per-user configurable, minimum 1 h); exactly one reminder per occurrence. |
| US-3 | As a user, my payment executes at the scheduled time without my presence (R3). | The cron worker claims the due schedule, runs balance precheck, and sends via BitGo; the resulting transaction follows the normal pipeline, including `pending_approval` interception. |
| US-4 | As a user with insufficient balance, I am told my payment defaulted (R5). | No transaction is initiated; the Scheduled Payments view shows a "no balance" alert; an email notification states the payment defaulted and shows the next occurrence; no auto-retry within the occurrence. |
| US-5 | As a user, I manage my schedules. | Pause/resume, edit (amount/address/frequency), cancel, and per-schedule execution history all work; only the wallet owner can act. |
| US-6 | As support, I can reconstruct any execution. | Each execution carries attempt count, error codes, balance snapshot at precheck, and tx id when broadcast. |

## 5. Functional requirements

Identifier mapping: R1 schedule UI · R2 own-DB persistence · R3 cron execution through regular pipeline · R4 schedule with zero balance · R5 insufficient-balance default handling · R6 pre-execution reminder.

**Scheduling & persistence**
- **FR-1 (R1):** "Schedule Transaction" entry points: dashboard nav button, dashboard route-search dialog, and wallet-detail actions menu (see §6). Frequency options: `one_time | daily | weekly | monthly`.
- **FR-2 (R1):** Form fields: destination address, amount (base-unit validated, display in coin units), frequency, start date, optional end date, optional note, user timezone (IANA).
- **FR-3 (R1/R2):** Create → `POST /api/v1/schedules` on tx-scheduler-service; the record lives in the scheduler's own MongoDB (`scheduledTransactions`), never in retail state.
- **FR-4 (R4):** Schedule creation never checks wallet balance. Zero-balance wallets are accepted, with an inline hint.

**Execution**
- **FR-5 (R3):** Worker ticks every 30 s and atomically claims due schedules (`status: 'active'`, `nextRunAt <= now`) via `findOneAndUpdate` — one claim, one execution (brief D2).
- **FR-6 (R3):** Execution calls `wallet.sendMany({recipients:[{address, amount}], walletPassphrase, minConfirms, sequenceId: '<scheduleId>:<scheduledForEpochMs>', comment})` (BitGoJS `wallet.ts:3120-3154`); `sequenceId` makes retries idempotent.
- **FR-7 (R3):** `status: 'pendingApproval'` (or TSS `{pendingApproval, txRequest}`) maps to execution state `pending_approval`; the transaction continues through the regular approval flow — never treated as an error.
- **FR-8 (R3):** Broadcast success records the tx id; the execution becomes `confirmed` only on a transfer-confirmed webhook.
- **FR-9 (R3):** Send failures retry up to 3 times with 1 m/5 m/25 m backoff (D3); after the last failure the execution is `failed` and the user is notified.

**Default handling**
- **FR-10 (R5):** Precheck: `wallet.refresh()` then `spendableBalanceString` (optionally `maximumSpendable`) — BitGoJS `wallet.ts:473-476, 340-342, 752-774`. `amount > spendable` ⇒ skip send, execution `defaulted`.
- **FR-11 (R5):** Send-time `err.code === 'insufficient_funds'` (SDK enriches with `walletBalances`, `wallet.ts:2757-2776`) also maps to `defaulted` — the two-layer rule (D4).
- **FR-12 (R5):** Default ⇒ (a) persistent alert banner in the Scheduled Payments view and wallet surface, escalating with `consecutiveDefaultedCount` (≥1 warn, ≥3 strong — D3); (b) defaulted email via NCC with wallet name, coin, destination, amount, next occurrence, deep link.
- **FR-13 (R5):** A defaulted occurrence never auto-retries inside the occurrence and never cancels the schedule; the next occurrence per frequency proceeds normally.

**Reminders**
- **FR-14 (R6):** Reminder fired at `nextRunAt − reminderOffset` (default 24 h, per-user configurable, min 1 h), exactly once per occurrence (idempotent on execution id + type).

**Cross-cutting**
- **FR-15:** Ownership enforced: only the wallet owner can create/view/mutate its schedules.
- **FR-16:** Destination address validated per coin; amount must be positive and representable in base units.
- **FR-17:** Schedule creation rate-limited per user; all mutations audit-logged.
- **FR-18:** Feature-flag gating: backend `tx-scheduler.enabled` (FLIPT — the wallet-platform convention, `packages/wallet-platform/package.json:142-146`), retail UI via LaunchDarkly `useFeatureFlag` (bitgo-retail pattern, `apps/retail-web/src/hooks/useShowOnboardingChecklist.ts`).
- **FR-19:** `nextRunAt` computed in UTC from the user's IANA timezone; monthly schedules clamp month-end dates (Jan 31 → Feb 28).

## 6. UX specification (bitgo-retail)

**Entry points** (scout-verified insertion points):
1. **Dashboard navigation** — next to the Withdraw button: `DashboardNavigation.tsx:85-94`; the commented-out TODO Send/Request button at `:66-74` shows the intended button pattern (`CarouselItem` + `Button`).
2. **Dashboard route-search dialog** — a `schedule` dialog param in `validateSearch` (`dashboard.tsx:9-20`) handled by `useDialogs.tsx`, lazy-loading a `ScheduleTransactionDialog` modeled on `WithdrawDialog.tsx` (right-drawer wrapper, `:10-28`).
3. **Wallet detail actions** — `useWalletDetailsActions.tsx` action-items dropdown, wallet context preselected.

**Schedule Transaction form.** Fields per FR-2; reuse the react-hook-form + zod step-schema pattern from `withdrawSchema.ts`; date selection reuses the `ScheduledDateCalendar.tsx` picker pattern. Zero-balance hint per FR-4. Copy states plainly: "We'll attempt this payment automatically. If your wallet doesn't have enough funds at that time, we'll skip it and notify you."

**Scheduled Payments list.** New route following the automations-table pattern; rows show status chip (`active | paused | cancelled | completed`), next run time, and a defaulted badge when `consecutiveDefaultedCount ≥ 1`. Alert banner component for defaults and reminders; toast on creation. Live status via TanStack Query polling (the app already polls wallets on a 30 s interval — `apps/retail-web/src/config/queryConfig.ts`).

**Settings.** Reminder offset and email preference live under the existing notification settings surface (`SettingsEmailNotificationsTab.tsx` pattern, channel `email`).

## 7. Notifications & alerts matrix

| Event | Trigger | In-app | Email (via NCC) |
|---|---|---|---|
| Schedule created | POST succeeds | Toast + list row | `scheduled_payment_created` (proposed; optional) |
| Upcoming reminder | `nextRunAt − reminderOffset` | List badge + banner | `scheduled_payment_reminder` (proposed) |
| Defaulted | Precheck or `insufficient_funds` | Banner, escalating | `scheduled_payment_defaulted` (proposed) |
| Execution failed | 3rd send attempt failed | Banner | `scheduled_payment_failed` (proposed) |

Email delivery follows the wallet-platform → NCC path: publishers serialize protobuf events onto Kafka topics consumed by NCC (Notification Command Center), which owns templates and the actual SendGrid delivery — SendGrid is not in the monorepo (`app/integrations/microservices.ts:207-210`, repo bitgo-microservices). NCC deduplicates on `userId + idempotencyKey`. In-app is limited to banners/badges: bitgo-retail has no notification-center component (only email notification settings). Push channels (FCM/SNS) were not found anywhere in the researched repos and are out of scope.

## 8. Edge cases & failure matrix

| Case | Behavior |
|---|---|
| Insufficient balance at execution | Execution `defaulted`; alert + email (FR-10…13). |
| Policy/approval interception | Execution `pending_approval`; resolution follows the normal approval flow (FR-7). |
| BitGo API outage / 429 | Retry with backoff using the same `sequenceId`; ops alert on sustained failure (error mapping in HLD/LLD). |
| Worker crash mid-execution | Atomic claim is the recovery unit; a reaper re-processes stuck claims (>15 min) — modeled on the wallet-platform stuck-state K8s CronJobs (`kustomize/applications/wallet-platform-internal/cronjobs/`). |
| Duplicate cron tick | Second claim of the same `nextRunAt` impossible (atomic claim + unique `{scheduleId, scheduledFor}` index). |
| Monthly month-end (Jan 31) | Clamp to last day of shorter months (FR-19). |
| DST / timezone | Compute in UTC from IANA zone stored per schedule (FR-19). |
| Expired/invalid access token | `err.invalidToken` ⇒ ops alert + token rotation runbook; executions pause-safe (claimed but not sent). |
| Invalid destination address | Rejected at creation (FR-16); SDK-side validation is second layer. |
| Edit while executing | Edits apply from the next occurrence; the in-flight execution keeps its own snapshot. |

## 9. Success metrics & KPIs

- Adoption: schedules created per week; % of wallets with ≥1 active schedule.
- Reliability: execution success rate ≥ 99% of *funded* occurrences; stuck-execution count (target 0 > 15 min).
- Default handling: defaulted-occurrence rate; % of defaulted schedules that recover by the next occurrence; reminder→top-up conversion.
- Ops: claim lag (due time → claim time) p95 < 60 s.

## 10. Rollout plan

1. **Internal:** FLIPT `tx-scheduler.enabled` for internal accounts; retail LD flag for the same cohort; testnet wallets only.
2. **Shadow mode (2 weeks):** executions run end-to-end but sends are suppressed (executions marked `shadow`), validating claim timing, prechecks, and notification content against real balances.
3. **Percentage rollout:** LD/FLIPT percentage gates, ramp 1% → 25% → 100% with error-budget alarms (HLD §9).
4. **GA:** flag defaults on; runbooks linked from the ops alert rules.

## 11. Security, privacy & compliance considerations

- The scheduler never stores key material; the wallet passphrase is fetched from the secret manager (KMS) only inside the signer process (D4/D9).
- Ownership checks (FR-15) and audit logging (FR-17) on every mutation.
- Every execution passes through BitGo policies/approvals exactly as a manual send; scheduling does not bypass governance.
- **Open compliance question:** a scheduled payment is a pre-authorized user instruction. Sanctions/screening runs at execution time (address screening, travel-rule checks) — confirm with compliance that this satisfies policy for pre-authored transfers, and whether reminder emails require any disclosures.

## 12. Open questions

| # | Question | Why it blocks | Suggested owner |
|---|---|---|---|
| OQ-1 | Exact access-token scope strings for spend (BitGoJS models scope only as `scope: string[]`; literals are server-defined — NOT FOUND in repo). | Token provisioning cannot start without them. | Token ops / API platform |
| OQ-2 | Transfer-confirmed webhook type literals and callback schema (NOT FOUND in BitGoJS repo). | `confirmed` state depends on the webhook contract. | Wallet platform |
| OQ-3 | NCC template + event-type creation ownership (3 new templates proposed). | Defaulted/reminder emails cannot ship without templates. | NCC team |
| OQ-4 | Does tx-scheduler get Kafka producer access on day 1, or relay through a wallet-platform internal route? | Pins the notification path (HLD presents both; LLD pins Kafka-direct). | Platform infra |
| OQ-5 | Compliance sign-off on pre-authorized recurring transfers (§11). | GA gate. | Compliance |
| OQ-6 | OTP behavior for spend outside token spending limits (`err.needsOTP`) — limits must be sized above scheduled amounts or executions fail. | Limits config must cover typical schedule amounts. | Token ops |

## Appendix A: Glossary

- **BitGo Express** — lightweight co-signing server (`@bitgo/express`, port 3080) that signs locally and proxies to the BitGo API.
- **BitGo API** — BitGo's hosted REST API (bitgo.com) for wallets, addresses, transfers, approvals.
- **BitGo JS SDK** — npm packages `@bitgo/sdk-core` / `@bitgo/sdk-api` / `@bitgo/express`.
- **Wallet spendable balance** — funds movable right now; excludes unconfirmed, pending-withdrawal and locked funds.
- **Scheduled payment** — persisted rule: source wallet, destination, amount, frequency, start date.
- **Execution (occurrence)** — one concrete run of a schedule, with its own lifecycle and audit record.
- **Defaulted execution** — pre-flight balance check failed; no transaction initiated; user alerted.
- **Upcoming-payment reminder** — in-app + email alert `reminderOffset` before the next due time.
- **Pending approval** — BitGo policy/approvals intercepted the transaction; not an error.
- **Broadcast** — submitting the signed transaction to the blockchain via BitGo.
- **Cron worker** — the scheduler's internal loop claiming due schedules.
- **FLIPT** — BitGo's feature-flag system (backend).
- **NCC (Notification Command Center)** — external service consuming Kafka notification events; owns email templates and delivery.
- **TWAP** — time-weighted average price trading automation (the only existing "automation" concept in retail).
- **Idempotency** — a due schedule executes exactly once despite restarts or duplicate ticks.

## Appendix B: Alternatives considered — where scheduling lives

| Option | Correctness | Ops burden | Latency | Blast radius | Verdict |
|---|---|---|---|---|---|
| **Standalone `tx-scheduler-service` repo (chosen)** | Own DB, atomic claim, independent deploys | New repo + pipeline + kustomize app | 30 s tick | Contained; wallet-platform untouched | **Recommended** — D1; clean ownership for a cross-cutting feature |
| Package inside wallet-platform monorepo | Reuses Mongo/Task queue/Kafka conventions | Zero new infra, but crowded backlog and shared deploys | Same | Bugs can hit the main API | Rejected: couples a retail feature to the core API's release train |
| Retail BFF (`apps/retail-bff`) persistence + cron | Simple to start | BFF is stateless by convention; cron there is an anti-pattern | Same | BFF outages block scheduling UI | Rejected: wrong layer for durable jobs |
