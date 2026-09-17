import { ScheduledStakingEntry } from '../models/ScheduledStakingEntry';
import { connectDb, disconnectDb } from '../utils/db';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { runStakingCycle,  updateEntryAfterCycle } from '../services/stakingActionService';

const workerId = `${process.env.HOSTNAME ?? 'localhost'}:${process.pid}`;
let shuttingDown = false;

/**
 * Claim-based staking worker. Runs on a configurable interval (default 24h)
 * and processes due scheduled-staking entries.
 *
 * Each entry is claimed atomically via findOneAndUpdate with lease fields
 * so that multiple worker replicas can safely run concurrently. Stuck claims
 * are re-armed by the staking reaper.
 *
 * Follows the same claim-based pattern as cronWorker.ts.
 */
async function tick(): Promise<void> {
  const now = new Date();

  // Atomically claim due entries using findOneAndUpdate.
  // We batch-claim by iterating due entries and claiming each one.
  const dueEntries = await ScheduledStakingEntry.find({
    status: 'active',
    nextPollAt: { $lte: now },
  })
    .sort({ nextPollAt: 1 })
    .limit(env.stakingBatchSize);

  for (const entry of dueEntries) {
    if (shuttingDown) break;

    // Atomic claim: only process if no other worker claimed it.
    // We use a lease-based approach: set a leasedUntil window so the
    // reaper can detect stuck claims.
    const leasedUntil = new Date(Date.now() + env.workerLeaseTtlMs);
    const claimed = await ScheduledStakingEntry.findOneAndUpdate(
      {
        _id: entry._id,
        status: 'active',
        nextPollAt: { $lte: now },
      },
      {
        $set: {
          nextPollAt: leasedUntil, // temporarily block other workers
        },
      },
      { new: false }, // return pre-update doc to verify we got it
    );

    if (!claimed) {
      // Another worker already claimed this entry; skip
      continue;
    }

    try {
      const result = await runStakingCycle(entry);
      await updateEntryAfterCycle(
        entry._id.toString(),
        result,
        env.stakingPollIntervalMs,
      );
    } catch (err) {
      logger.error({ err, entryId: entry._id.toString() }, 'error processing staking entry');
      // Release the entry for retry on next poll cycle
      await ScheduledStakingEntry.updateOne(
        { _id: entry._id },
        {
          $set: {
            nextPollAt: new Date(Date.now() + env.stakingPollIntervalMs),
            lastError: err instanceof Error ? err.message : String(err),
          },
          $inc: { consecutiveFailureCount: 1 },
        },
      );
    }
  }
}

async function run(): Promise<void> {
  await connectDb();
  logger.info({ workerId, pollIntervalMs: env.stakingPollIntervalMs }, 'staking worker started');

  setInterval(() => {
    if (shuttingDown) return;
    tick().catch((err) => logger.error({ err }, 'staking worker tick failed'));
  }, env.stakingPollIntervalMs);

  // Run first tick immediately
  tick().catch((err) => logger.error({ err }, 'staking worker initial tick failed'));

  const stop = async () => {
    shuttingDown = true;
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  run().catch((err) => {
    logger.fatal({ err }, 'staking worker failed to start');
    process.exit(1);
  });
}

export { run as runStakingWorker, tick as stakingTick };
