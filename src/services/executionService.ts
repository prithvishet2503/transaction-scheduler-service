import { ScheduleExecution } from '../models/ScheduleExecution';
import { ScheduledTransaction } from '../models/ScheduledTransaction';
import { bitgoClient } from './bitgoClient';
import { notify } from './notificationService';
import { computeNextRun } from '../utils/frequency';
import { recipientsFromSchedule, sumAmounts } from '../utils/recipients';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { NotificationType } from '../types';

/**
 * Core execution state machine for one schedule occurrence.
 *
 * Lifecycle: scheduled → claimed → { executed | defaulted | pending_approval
 * | failed } → confirmed (via transfer webhook). Retries re-arm the
 * occurrence back to `scheduled` with exponential backoff (FR-9).
 */

function occurrenceSeq(scheduleId: string, scheduledFor: Date): string {
  return `${scheduleId}:${scheduledFor.getTime()}`;
}

/** Atomically create the occurrence row for a due schedule (unique per occurrence). */
export async function ensureExecution(scheduleId: string, scheduledFor: Date) {
  return ScheduleExecution.findOneAndUpdate(
    { scheduleId, scheduledFor },
    {
      $setOnInsert: {
        scheduledFor,
        status: 'scheduled',
        sequenceId: occurrenceSeq(scheduleId, scheduledFor),
        attempt: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

/** Atomically claim an occurrence so exactly one worker executes it. */
export async function claimExecution(executionId: string, workerId: string) {
  return ScheduleExecution.findOneAndUpdate(
    { _id: executionId, status: 'scheduled' },
    {
      $set: {
        status: 'claimed',
        leasedBy: workerId,
        leasedUntil: new Date(Date.now() + env.workerLeaseTtlMs),
      },
    },
    { new: true },
  );
}

/** Advance the schedule's nextRunAt after an occurrence resolves. */
async function advanceSchedule(schedule: InstanceType<typeof ScheduledTransaction>) {
  if (schedule.status !== 'active') {
    return;
  }
  const next = computeNextRun(schedule.frequency, schedule.nextRunAt ?? new Date(), schedule.timezone);
  if (next === null) {
    // one_time, or end date reached → completed
    schedule.status = 'completed';
    schedule.nextRunAt = null;
  } else if (schedule.endAt && next > schedule.endAt) {
    schedule.status = 'completed';
    schedule.nextRunAt = null;
  } else {
    schedule.nextRunAt = next;
  }
  await schedule.save();
}

async function emit(
  type: NotificationType,
  schedule: InstanceType<typeof ScheduledTransaction>,
  extra: Partial<Parameters<typeof notify>[0]> = {},
) {
  await notify({
    type,
    userId: schedule.userId,
    scheduleId: schedule._id.toString(),
    walletId: schedule.walletId,
    coin: schedule.coin,
    destinationAddress: schedule.destinationAddress,
    amount: schedule.amount,
    recipients: recipientsFromSchedule(schedule),
    scheduledFor: schedule.nextRunAt?.toISOString(),
    consecutiveDefaultedCount: schedule.consecutiveDefaultedCount,
    idempotencyKey: `${schedule._id.toString()}:${extra.executionId ?? 'none'}:${type}`,
    ...extra,
  });
}

function retryBackoff(attempt: number): number {
  const idx = Math.min(attempt - 1, env.retryBackoffMs.length - 1);
  return env.retryBackoffMs[idx] ?? 60_000;
}

function isObjectWithId(value: unknown): value is { id: unknown } {
  return !!value && typeof value === 'object' && 'id' in value;
}

/**
 * Balance pre-check + send (FR-10/FR-11). Two-layer rule:
 *  - spendableBalanceString < amount  → default (no transaction started)
 *  - server-side `insufficient_funds` → also default
 */
async function executeOccurrence(schedule: InstanceType<typeof ScheduledTransaction>, executionId: string) {
  const recipients = recipientsFromSchedule(schedule);
  const totalAmount = sumAmounts(recipients);
  const snapshot = await bitgoClient.checkBalance(schedule.coin, schedule.walletId, recipients[0].address);
  if (BigInt(snapshot.spendable) < BigInt(totalAmount)) {
    return { outcome: 'defaulted' as const, snapshot };
  }
  try {
    const result = await bitgoClient.sendMany({
      coin: schedule.coin,
      walletId: schedule.walletId,
      recipients,
      sequenceId: `${schedule._id.toString()}:${schedule.nextRunAt?.getTime() ?? Date.now()}`,
      comment: `scheduled:${schedule._id.toString()}`,
    });
    return { outcome: 'sent' as const, snapshot, result };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'insufficient_funds') {
      return { outcome: 'defaulted' as const, snapshot };
    }
    if (code === 'invalidToken') {
      // Ops alert path — token is paused-safe: leave the occurrence claimed.
      logger.error({ err }, 'bitgo access token invalid — executions pause-safe');
      return { outcome: 'token_error' as const, snapshot, err };
    }
    return { outcome: 'error' as const, snapshot, err };
  }
}

/** Claim + run one occurrence for a due schedule. */
export async function processDueSchedule(
  schedule: InstanceType<typeof ScheduledTransaction>,
  workerId: string,
): Promise<void> {
  const scheduledFor = schedule.nextRunAt;
  if (!scheduledFor) {
    return;
  }
  const execution = await ensureExecution(schedule._id.toString(), scheduledFor);
  if (!execution) {
    return;
  }
  const claimed = await claimExecution(execution._id.toString(), workerId);
  if (!claimed) {
    // Someone else claimed it this tick — nothing to do.
    return;
  }

  const run = await executeOccurrence(schedule, claimed._id.toString());

  if (run.outcome === 'defaulted') {
    // FR-10/11: no transaction started; schedule stays active, next occurrence proceeds.
    await ScheduleExecution.updateOne(
      { _id: claimed._id },
      { $set: { status: 'defaulted', reason: 'INSUFFICIENT_BALANCE', balanceSnapshot: run.snapshot } },
    );
    schedule.consecutiveDefaultedCount += 1;
    schedule.lastRunAt = scheduledFor;
    await advanceSchedule(schedule);
    await emit('defaulted', schedule, {
      executionId: claimed._id.toString(),
      reason: 'INSUFFICIENT_BALANCE',
      scheduledFor: scheduledFor.toISOString(),
      nextRunAt: schedule.nextRunAt?.toISOString(),
    });
    logger.warn(
      { scheduleId: schedule._id.toString(), executionId: claimed._id.toString(), balance: run.snapshot.spendable },
      'occurrence defaulted (insufficient balance)',
    );
    return;
  }

  if (run.outcome === 'token_error') {
    // Leave claimed + pause-safe; ops will rotate the token.
    return;
  }

  if (run.outcome === 'error') {
    const attempt = (claimed.attempt ?? 0) + 1;
    const err = run.err as Error;
    if (attempt < env.workerMaxAttempts) {
      // Retry with backoff: re-arm the occurrence (FR-9).
      await ScheduleExecution.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: 'scheduled',
            attempt,
            scheduledFor: new Date(Date.now() + retryBackoff(attempt)),
            error: err?.message,
          },
        },
      );
      logger.warn({ scheduleId: schedule._id.toString(), attempt, err: err?.message }, 'send failed, will retry');
    } else {
      await ScheduleExecution.updateOne(
        { _id: claimed._id },
        { $set: { status: 'failed', attempt, error: err?.message } },
      );
      await emit('execution_failed', schedule, {
        executionId: claimed._id.toString(),
        scheduledFor: scheduledFor.toISOString(),
      });
      logger.error({ scheduleId: schedule._id.toString(), attempt, err: err?.message }, 'occurrence failed');
    }
    return;
  }

  // outcome === 'sent'
  const result = run.result as Record<string, unknown>;
  // Custody sends return { pendingApproval: { id, ... }, ... }; hot sends
  // return { txid, pendingApprovalId? }. Normalize both.
  let pendingApprovalId =
    typeof result?.pendingApprovalId === 'string' ? result.pendingApprovalId : undefined;
  const pa = result?.pendingApproval;
  if (!pendingApprovalId && isObjectWithId(pa) && typeof pa.id === 'string') {
    pendingApprovalId = pa.id;
  }
  const txid = result?.txid as string | undefined;

  if (pendingApprovalId) {
    // FR-7: policy/approval interception is first-class, not an error.
    await ScheduleExecution.updateOne(
      { _id: claimed._id },
      { $set: { status: 'pending_approval', pendingApprovalId, balanceSnapshot: run.snapshot } },
    );
    schedule.lastRunAt = scheduledFor;
    await advanceSchedule(schedule);
    logger.info(
      { scheduleId: schedule._id.toString(), executionId: claimed._id.toString(), pendingApprovalId },
      'occurrence awaiting approval',
    );
    return;
  }

  // Broadcast submitted; settlement is async — 'confirmed' arrives via webhook (FR-8).
  await ScheduleExecution.updateOne(
    { _id: claimed._id },
    { $set: { status: 'executed', txid, balanceSnapshot: run.snapshot } },
  );
  schedule.consecutiveDefaultedCount = 0;
  schedule.lastRunAt = scheduledFor;
  await advanceSchedule(schedule);
  logger.info(
    { scheduleId: schedule._id.toString(), executionId: claimed._id.toString(), txid },
    'occurrence executed (awaiting confirmation)',
  );
}

/** Send the upcoming-payment reminder for a schedule, exactly once per occurrence (FR-14). */
export async function sendReminderIfDue(schedule: InstanceType<typeof ScheduledTransaction>) {
  if (schedule.status !== 'active' || !schedule.nextRunAt) {
    return;
  }
  const dueAt = new Date(schedule.nextRunAt.getTime() - schedule.reminderOffsetMs);
  if (dueAt > new Date()) {
    return;
  }
  if (schedule.lastReminderSentForRunAt && schedule.lastReminderSentForRunAt.getTime() === schedule.nextRunAt.getTime()) {
    return;
  }
  schedule.lastReminderSentForRunAt = schedule.nextRunAt;
  await schedule.save();
  await emit('upcoming_reminder', schedule, {
    scheduledFor: schedule.nextRunAt.toISOString(),
    idempotencyKey: `${schedule._id.toString()}:${schedule.nextRunAt.getTime()}:reminder`,
  });
  logger.info({ scheduleId: schedule._id.toString() }, 'upcoming reminder sent');
}
