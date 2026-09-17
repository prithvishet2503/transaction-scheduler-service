import { ScheduledTransaction } from '../models/ScheduledTransaction';
import { connectDb, disconnectDb } from '../utils/db';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { processDueSchedule, sendReminderIfDue } from '../services/executionService';

const workerId = `${process.env.HOSTNAME ?? 'localhost'}:${process.pid}`;
let shuttingDown = false;

/**
 * Claim-based cron worker. Every `WORKER_POLL_INTERVAL_MS` (default 30 s) it:
 *  1. sends due upcoming-payment reminders (FR-14);
 *  2. scans due schedules and processes each occurrence via an atomic claim
 *     (FR-5) — exactly one worker executes each occurrence.
 *
 * No Temporal: scheduling is plain MongoDB atomic-claim polling, so any
 * number of replicas can run safely. Stuck claims are re-armed by the
 * reaper (src/workers/reaper.ts).
 */
async function tick(): Promise<void> {
  const now = new Date();
  const dueSchedules = await ScheduledTransaction.find({
    status: 'active',
    nextRunAt: { $lte: now },
    $or: [{ endAt: null }, { endAt: { $gte: now } }],
  })
    .sort({ nextRunAt: 1 })
    .limit(env.workerBatchSize);

  for (const schedule of dueSchedules) {
    try {
      await sendReminderIfDue(schedule);
      await processDueSchedule(schedule, workerId);
    } catch (err) {
      logger.error({ err, scheduleId: schedule._id.toString() }, 'error processing due schedule');
    }
  }
}

async function run(): Promise<void> {
  await connectDb();
  logger.info({ workerId, pollIntervalMs: env.workerPollIntervalMs }, 'cron worker started');

  setInterval(() => {
    if (shuttingDown) {
      return;
    }
    tick().catch((err) => logger.error({ err }, 'worker tick failed'));
  }, env.workerPollIntervalMs);

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
    logger.fatal({ err }, 'cron worker failed to start');
    process.exit(1);
  });
}

export { run as runCronWorker, tick as cronTick };
