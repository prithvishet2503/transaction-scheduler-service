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
  bitgoAccessToken:
    process.env.BITGO_ACCESS_TOKEN ?? '<set-your-testnet-access-token>',
  // Wallet passphrase used to decrypt the user key share for signing.
  bitgoWalletPassphrase:
    process.env.BITGO_WALLET_PASSPHRASE ?? '<set-your-wallet-passphrase>',
  // Comma-separated coin list the SDK should register (e.g. "tbtc,teth").
  coins: (process.env.COINS ?? 'tbtc').split(',').filter(Boolean),

  // --- Auth (demo: static API key, hardcoded) ---
  apiKey: process.env.API_KEY ?? 'dev-api-key',

  // --- Worker / scheduling ---
  workerPollIntervalMs: int(process.env.WORKER_POLL_INTERVAL_MS, 30_000),
  workerLeaseTtlMs: int(process.env.WORKER_LEASE_TTL_MS, 120_000),
  workerStuckClaimMs: int(process.env.WORKER_STUCK_CLAIM_MS, 15 * 60_000),
  workerMaxAttempts: int(process.env.WORKER_MAX_ATTEMPTS, 3),
  workerBatchSize: int(process.env.WORKER_BATCH_SIZE, 100),
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
} as const;

export type Env = typeof env;
