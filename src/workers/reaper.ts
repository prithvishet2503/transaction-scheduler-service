import { ScheduleExecution } from '../models/ScheduleExecution';
import { connectDb, disconnectDb } from '../utils/db';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Reaper: re-arms claims that a worker crashed on before finishing.
 *
 * A claim is considered stuck when `leasedUntil` has passed while the
 * execution is still `claimed` (lease window = WORKER_LEASE_TTL_MS; anything
 * older than WORKER_STUCK_CLAIM_MS is re-armed). Re-arming flips it back to
 * `scheduled` so the main cron worker re-claims and retries it. This mirrors
 * wallet-platform's stuck-state CronJobs pattern.
 */
export async function reapStuckClaims(): Promise<number> {
  const threshold = new Date(Date.now() - env.workerStuckClaimMs);
  const res = await ScheduleExecution.updateMany(
    { status: 'claimed', leasedUntil: { $lt: threshold } },
    { $set: { status: 'scheduled', leasedBy: null, leasedUntil: null } },
  );
  if (res.modifiedCount > 0) {
    logger.warn({ count: res.modifiedCount }, 're-armed stuck claims');
  }
  return res.modifiedCount;
}

async function run(): Promise<void> {
  await connectDb();
  logger.info('reaper started');
  const intervalMs = Math.max(env.workerPollIntervalMs, 30_000);
  setInterval(() => {
    reapStuckClaims().catch((err) => logger.error({ err }, 'reaper tick failed'));
  }, intervalMs);
  const stop = async () => {
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  run().catch((err) => {
    logger.fatal({ err }, 'reaper failed to start');
    process.exit(1);
  });
}

export { run as runReaper };
