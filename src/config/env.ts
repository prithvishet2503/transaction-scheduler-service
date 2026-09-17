import dotenv from 'dotenv';
dotenv.config();

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const env = {
  // --- Service ---
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: int(process.env.PORT, 3000),
  serviceName: 'transaction-scheduler-service',

  // --- Database ---
  mongoUri:
    process.env.MONGO_URI ?? 'mongodb://localhost:27017/transaction_scheduler',

  // --- BitGo (hardcoded for hackathon demo; NOT KMS-backed) ---
  bitgoEnv: (process.env.BITGO_ENV ?? 'test') as 'test' | 'prod',
  bitgoAccessToken: process.env.BITGO_ACCESS_TOKEN ?? '<set-your-testnet-access-token>',
  // Test-env token for BitGo test endpoints; falls back to the main token when unset.
  bitgoTestAccessToken:
    process.env.BITGO_TEST_ACCESS_TOKEN ?? process.env.BITGO_ACCESS_TOKEN ?? '',
  // REST base for the TxRequests API (staging by default for this demo).
  bitgoBaseUrl: process.env.BITGO_BASE_URL ?? 'https://app.bitgo-test.com',
  // Wallet passphrase used to decrypt the user key share for signing.
  // NOT required for custody wallets (BitGo holds the keys) — only set it
  // for self-custody/hot wallets.
  bitgoWalletPassphrase: process.env.BITGO_WALLET_PASSPHRASE ?? '',
  // Demo mode (hackathon): bypass the BitGo SDK entirely. Default 'real'.
  bitgoMode: (process.env.BITGO_MODE ?? 'real') as 'real' | 'demo',
  // Spendable balance (base units, string) reported by the demo precheck.
  demoSpendable: process.env.DEMO_SPENDABLE ?? '0',
  // When set, demo TxRequest stays pending approval instead of broadcasting.
  demoPendingApprovalId: process.env.DEMO_PENDING_APPROVAL_ID ?? '',
  // Comma-separated coin list the SDK should register (e.g. "tbaseeth,tbtc").
  coins: (process.env.COINS ?? 'tbaseeth').split(',').filter(Boolean),

  // --- Auth (demo: static API key, hardcoded) ---
  apiKey: process.env.API_KEY ?? 'dev-api-key',

  // --- Worker / scheduling ---
  workerPollIntervalMs: int(process.env.WORKER_POLL_INTERVAL_MS, 30_000),
  workerLeaseTtlMs: int(process.env.WORKER_LEASE_TTL_MS, 120_000),
  workerStuckClaimMs: int(process.env.WORKER_STUCK_CLAIM_MS, 15 * 60_000),
  workerMaxAttempts: int(process.env.WORKER_MAX_ATTEMPTS, 3),
  workerBatchSize: int(process.env.WORKER_BATCH_SIZE, 100),
  // Re-arm cadence for balance-conditioned smart transactions: every check
  // (fired or not) reschedules the next check this far out (user: 5 minutes).
  balanceCheckIntervalMs: int(process.env.BALANCE_CHECK_INTERVAL_MS, 5 * 60_000),
  // Promised timeline + buffer: a timestamp occurrence that has not proceeded
  // within this window after its scheduled time is never retried (user promise);
  // balance rules are exempt (standing monitors).
  occurrenceDeadlineMs: int(process.env.OCCURRENCE_DEADLINE_MS, 20 * 60_000),
  // Inline post-creation poll of the created txrequest (best-effort).
  txRequestPollAttempts: int(process.env.TX_REQUEST_POLL_ATTEMPTS, 5),
  txRequestPollIntervalMs: int(process.env.TX_REQUEST_POLL_INTERVAL_MS, 2_000),
  // Tick-poller re-fetch cadence for in-flight txrequests; 0 = every tick.
  txRequestStatusRefreshMs: int(process.env.TX_REQUEST_STATUS_REFRESH_MS, 0),
  // Retry backoff schedule in ms (FR-9: 1m / 5m / 25m).
  retryBackoffMs: (process.env.RETRY_BACKOFF_MS ?? '60000,300000,1500000')
    .split(',')
    .map((v) => int(v, 60_000)),

  // --- Reminders (FR-14) ---
  defaultReminderOffsetMs: int(
    process.env.DEFAULT_REMINDER_OFFSET_MS,
    24 * 60 * 60 * 1000,
  ),
  minReminderOffsetMs: int(process.env.MIN_REMINDER_OFFSET_MS, 60 * 60 * 1000),

  // --- Notifications (demo: NCC/Kafka or simple webhook/log sink) ---
  // If set, a JSON payload is POSTed here on reminder/defaulted/failed events.
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL ?? '',
  // Optional Kafka bootstrap servers (NCC path). Empty = webhook/log only.
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? '').split(',').filter(Boolean),
  kafkaTopicPrefix: process.env.KAFKA_TOPIC_PREFIX ?? 'tx-scheduler',

  // --- Webhook (BitGo transfer-confirmed → execution 'confirmed') ---
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret',
  // --- Staking (scheduled-staking feature) ---
  stakingPollIntervalMs: int(process.env.STAKING_POLL_INTERVAL_MS, 24 * 60 * 60 * 1000),
  solValidatorAddress: process.env.SOL_VALIDATOR_ADDRESS ?? '',
  stakingMinimumStakeAmount: process.env.STAKING_MINIMUM_STAKE_AMOUNT ?? '0.01',
  stakingBatchSize: int(process.env.STAKING_BATCH_SIZE, 50),
} as const;

export type Env = typeof env;
