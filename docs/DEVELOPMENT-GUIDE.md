# Development Guide

## Prerequisites

- **Node.js 22+** (BitGo SDK packages require `>=22`; local default may be 20 — use `nvm use 22`).
- **MongoDB** — `make local-up` starts one via Docker, or point `MONGO_URI` at a local `mongod`.
- A BitGo **testnet** access token + a funded wallet for real on-chain sends. For **custody wallets** no passphrase is needed (BitGo holds the keys); for self-custody/hot wallets you also need the wallet passphrase.

## Local run

```bash
make install
cp .env.example .env        # fill BITGO_ACCESS_TOKEN (BITGO_WALLET_PASSPHRASE only for hot wallets)
make typecheck
make test
make build
make local-up               # MongoDB (docker) if needed
make run-api                # API on :3000
make run-worker             # cron worker (separate terminal)
# optional
make run-reaper             # reaper (re-arms stuck claims)
```

## Demo walkthrough (real testnet transaction)

1. Create a testnet Base (Ethereum) wallet in BitGo test; copy its `walletId`. (For a hot/self-custody wallet also note the **passphrase** you set; custody wallets need none.)
2. Fund it with testnet Base ETH (a faucet) so the balance covers `amount + fee`.
3. Set `BITGO_ACCESS_TOKEN` and `COINS=tbaseeth` in `.env` (add `BITGO_WALLET_PASSPHRASE` only for a hot wallet).
4. Start the API + worker.
5. Create a **due** schedule (past `startAt`):

```bash
curl -X POST localhost:3000/api/v1/schedules \
  -H "x-api-key: dev-api-key" -H "content-type: application/json" \
  -d '{"walletId":"<walletId>","coin":"tbaseeth",
       "destinationAddress":"0xde709f2102306220921060314715629080e2fb77",
       "amount":"50000","frequency":"daily","timezone":"UTC",
       "startAt":"2026-09-01T00:00:00Z"}'
```

6. Trigger one worker tick (or wait ≤30 s):

```bash
curl -X POST localhost:3000/api/v1/worker/tick -H "x-api-key: dev-api-key"
```

7. Check the execution — funded wallet → `executed` (txid); unfunded wallet → `defaulted` with `INSUFFICIENT_BALANCE`, plus a reminder/default notification in the logs.

## Testing

- `make test` — vitest unit tests: `test/frequency.test.ts` (month-end clamp, zones), `test/scheduleService.test.ts` (create validation, zero-balance), `test/executionService.test.ts` (default vs execute state machine).

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `EBADENGINE` warnings on install | Node < 22; switch to Node 22. Non-fatal for most paths but BTC signing may misbehave. |
| `Coin or token type tbaseeth not supported` | Coin not registered — confirm `COINS=tbaseeth` and that `@bitgo/sdk-coin-evm` is installed. |
| Execution stuck `claimed` with a real token | BitGo API error (network/token); the reaper re-arms after the lease expires, or the token path pauses. Check logs for `insufficient_funds` / `invalidToken`. |
| Schedule created but never executes | `nextRunAt` is in the future (computed from `startAt` + one period). Use a past `startAt` to make it due immediately. |
| Real send fails with spend-limit/OTP | The token's spending limits must cover the schedule amount (OQ-6). |
