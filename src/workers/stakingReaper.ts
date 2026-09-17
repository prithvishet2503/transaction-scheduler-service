import { ScheduledStakingEntry } from '../models/ScheduledStakingEntry';
import { connectDb, disconnectDb } from '../utils/db';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Staking reaper: re-arms stuck claims on scheduled-staking entries.
 *
 * When the staking worker crashes mid-cycle, the entry's nextPollAt is
 * set to a leasedUntil timestamp in the future. Once that timestamp
 * expires (older than WORKER_STUCK_CLAIM_MS), the entry is stuck.
 *
 * The reaper resets nextPollAt to `now` so the main staking worker
 * re-claims and retries it. This mirrors the pattern in reaper.ts for
 * schedule executions.
 */
export async function reapStuckStakingEntries(): Promise<number> {
  const threshold = new Date(Date.now() - env.workerStuckClaimMs);
  const res = await ScheduledStakingEntry.updateMany(
    {
      status: 'active',
      nextPollAt: { $lt: threshold, $ne: null },
    },
    {
      $set: {
        nextPollAt: new Date(),
        lastError: 're-armed by reaper (stuck claim)',
      },
      $inc: { consecutiveFailureCount: 1 },
    },
  );
  if (res.modifiedCount > 0) {
    logger.warn({ count: res.modifiedCount }, 're-armed stuck staking entries');
  }
  return res.modifiedCount;
}

async function run(): Promise<void> {
  await connectDb();
  logger.info('staking reaper started');

  const intervalMs = Math.max(env.workerPollIntervalMs, 30_000);
  setInterval(() => {
    reapStuckStakingEntries().catch((err) => logger.error({ err }, 'staking reaper tick failed'));
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
    logger.fatal({ err }, 'staking reaper failed to start');
    process.exit(1);
  });
}

export { run as runStakingReaper };
