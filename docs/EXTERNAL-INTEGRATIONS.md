# External Integrations

## BitGoJS SDK

Packages: `@bitgo/sdk-api` (client/auth), `@bitgo/sdk-core` (Wallet, wallets), `@bitgo/sdk-coin-<coin>` (per-coin registration). All are public on npm; install from the repo root (`make install`).

### Authentication
- Constructor `new BitGoAPI({ env, accessToken })` or `authenticateWithAccessToken({ accessToken })`.
- `env: 'test' | 'prod'`.
- **Demo:** the token is a long-lived, spend-scoped access token supplied in `.env` (hardcoded; no KMS). Production would source it from a secret manager. **Open item (OQ-1):** exact scope-string literals are server-defined and not discoverable in the SDK repo — provision with the wallet's `spend` permission.

### Coin registration
Per-coin SDK packages export one class per coin, each with `createInstance`:
```ts
import { BitGoAPI } from '@bitgo/sdk-api';
import { Tbtc } from '@bitgo/sdk-coin-btc';
const bitgo = new BitGoAPI({ env: 'test', accessToken });
bitgo.register('tbtc', Tbtc.createInstance);
```
`src/services/bitgoClient.ts` resolves the coin class by name (`tbtc → Tbtc`, `btc → Btc`, general fallback).

### Wallet & balance
```ts
const wallet = await bitgo.coin(coin).wallets().get({ id: walletId });
await wallet.refresh();
wallet.spendableBalanceString();                 // funds movable now (excl. unconfirmed/held)
wallet.maximumSpendable({ recipientAddress });   // fee-adjusted pre-spend feasibility
```
The SDK does **not** enforce funds client-side; the scheduler pre-checks (FR-10) and treats a server-side `insufficient_funds` as a default (FR-11).

### Send
```ts
const result = await wallet.sendMany({
  recipients: [{ address, amount }],   // amount in base units
  walletPassphrase,                    // decrypts user key share
  minConfirms,
  sequenceId,                          // idempotency
  comment,
});
// result.txid | result.pendingApprovalId | result.txRequestId
```
Under the hood this runs prebuild → sign → submit against BitGo (`/api/v2/:coin/wallet/:id/tx/build`, `/tx/send`), through the same policy/approval path as a manual send.

## Notifications — NCC path

Production reminders/defaults are sent through BitGo's **NCC (Notification Command Center)**: publishers serialize protobuf events onto Kafka topics that NCC consumes; NCC owns email templates + SendGrid delivery and deduplicates on `userId + idempotencyKey` (SendGrid is not in the monorepo).

This service ships a **self-contained sink**:
1. **Log** (always) — structured line per event.
2. **Webhook** (optional, `NOTIFY_WEBHOOK_URL`) — POST JSON payload.
3. **Kafka** (optional, `KAFKA_BROKERS`) — publish to `tx-scheduler-notifications` for an NCC-like consumer.

**Open item (OQ-3):** three NCC templates are needed — `scheduled_payment_reminder`, `scheduled_payment_defaulted`, `scheduled_payment_failed` — owned by the NCC team.

## BitGo transfer webhook

- Endpoint: `POST /api/v1/webhooks/bitgo`, signed with `x-bitgo-signature: <WEBHOOK_SECRET>` (constant-time compare).
- Payload carries the transfer's `txid` (and our `sequenceId` when echoed). On receipt the execution transitions `executed → confirmed` (FR-8).
- **Open item (OQ-2):** the exact transfer-confirmed webhook type literal + callback schema are server-defined and not present in the SDK repo — align the payload shape when wiring the real webhook registration.

## Auth / ownership

- Demo auth is a static API key (`x-api-key`) with an optional `x-user-id` header (default `demo-user`). Production resolves the user from an OAuth scoped session and enforces wallet ownership (FR-15).
