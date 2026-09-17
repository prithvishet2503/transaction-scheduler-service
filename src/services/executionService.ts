import { ScheduleExecution } from '../models/ScheduleExecution';
import { ScheduledTransaction } from '../models/ScheduledTransaction';
import { bitgoClient } from './bitgoClient';
import { notify } from './notificationService';
import { computeNextRun } from '../utils/frequency';
import { recipientsFromSchedule, sumAmounts } from '../utils/recipients';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { BalanceSnapshot, TxRequestView } from './bitgoClient';
import type { DefaultReason, NotificationType } from '../types';

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

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}


type OccurrenceOutcome =
  | { outcome: 'defaulted'; reason: DefaultReason; snapshot: BalanceSnapshot }
  | { outcome: 'sent'; snapshot: BalanceSnapshot; txRequestId: string; view: TxRequestView }
  | { outcome: 'token_error'; snapshot: BalanceSnapshot; err: unknown }
  | { outcome: 'error'; snapshot: BalanceSnapshot; err: unknown };

function balanceConditionMet(
  operator: 'above' | 'below' | 'equals',
  spendable: bigint,
  limit: bigint,
): boolean {
  if (operator === 'above') return spendable > limit;
  if (operator === 'below') return spendable < limit;
  return spendable === limit;
}

/**
 * Balance pre-check + send (FR-10/FR-11). Two-layer rule:
 *  - spendableBalanceString < amount  → default (no transaction started)
 *  - server-side `insufficient_funds` → also default
 * A balance trigger condition is evaluated against the same snapshot; unmet →
 * default with BALANCE_CONDITION_NOT_MET (no transaction started).
 */
async function executeOccurrence(
  schedule: InstanceType<typeof ScheduledTransaction>,
  executionId: string,
): Promise<OccurrenceOutcome> {
  const recipients = recipientsFromSchedule(schedule);
  const totalAmount = sumAmounts(recipients);
  const snapshot = await bitgoClient.checkBalance(schedule.coin, schedule.walletId, recipients[0].address);
  const spendable = BigInt(snapshot.spendable);
  if (schedule.conditionType === 'balance' && schedule.conditionOperator && schedule.conditionLimit) {
    if (!balanceConditionMet(schedule.conditionOperator, spendable, BigInt(schedule.conditionLimit))) {
      return { outcome: 'defaulted', reason: 'BALANCE_CONDITION_NOT_MET', snapshot };
    }
  }
  if (spendable < BigInt(totalAmount)) {
    return { outcome: 'defaulted', reason: 'INSUFFICIENT_BALANCE', snapshot };
  }
  const intentRecipients = recipients.map((r) => {
    const entry: Record<string, unknown> = {
      address: { address: r.address },
      amount: { value: r.amount, symbol: schedule.tokenName ?? schedule.coin },
    };
    if (schedule.tokenName) {
      // Token schedules are EVM ERC-20-like in this service; Wallet Platform
      // rejects a transferToken recipient without tokenData.
      entry.tokenData = {
        tokenName: schedule.tokenName,
        tokenType: 'ERC20',
        tokenQuantity: r.amount,
      };
    }
    return entry;
  });
  const intent: Record<string, unknown> = {
    intentType: schedule.tokenName ? 'transferToken' : 'payment',
    recipients: intentRecipients,
    sequenceId: `${schedule._id.toString()}:${schedule.nextRunAt?.getTime() ?? Date.now()}`,
    comment: `scheduled:${schedule._id.toString()}`,
  };
  try {
    const created = await bitgoClient.createTxRequest(schedule.walletId, intent);
    // Bounded inline poll after creating: hot wallets usually sign + broadcast
    // within seconds, so the document can move past 'pending_approval' here.
    let view = await bitgoClient.fetchLatestTxRequest(schedule.walletId, created.txRequestId);
    for (
      let i = 0;
      i < env.txRequestPollAttempts && view && view.txHashes.length === 0 && !view.isCanceled;
      i += 1
    ) {
      await delay(env.txRequestPollIntervalMs);
      view = await bitgoClient.fetchLatestTxRequest(schedule.walletId, created.txRequestId);
    }
    return {
      outcome: 'sent',
      snapshot,
      txRequestId: created.txRequestId,
      view: view ?? { txRequestId: created.txRequestId, state: created.state, isCanceled: false, txHashes: [] },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number } | undefined)?.status;
    if (msg.includes('insufficient_funds')) {
      return { outcome: 'defaulted', reason: 'INSUFFICIENT_BALANCE', snapshot };
    }
    if (status === 401 || status === 403) {
      // Ops alert path — token is paused-safe: leave the occurrence claimed.
      logger.error({ err }, 'bitgo access token invalid — executions pause-safe');
      return { outcome: 'token_error', snapshot, err };
    }
    return { outcome: 'error', snapshot, err };
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
  // Timestamp trigger condition: the occurrence cannot fire before `at`;
  // leave unclaimed and pick it up on a later tick.
  if (schedule.conditionType === 'timestamp' && schedule.conditionAt && new Date() < schedule.conditionAt) {
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
      { $set: { status: 'defaulted', reason: run.reason, balanceSnapshot: run.snapshot } },
    );
    schedule.consecutiveDefaultedCount += 1;
    schedule.lastRunAt = scheduledFor;
    await advanceSchedule(schedule);
    await emit('defaulted', schedule, {
      executionId: claimed._id.toString(),
      reason: run.reason,
      scheduledFor: scheduledFor.toISOString(),
      nextRunAt: schedule.nextRunAt?.toISOString(),
    });
    logger.warn(
      { scheduleId: schedule._id.toString(), executionId: claimed._id.toString(), reason: run.reason },
      'occurrence defaulted',
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
  const { txRequestId, view } = run;
  if (view.isCanceled) {
    await ScheduleExecution.updateOne(
      { _id: claimed._id },
      { $set: { status: 'failed', txRequestId, error: 'txrequest canceled', balanceSnapshot: run.snapshot } },
    );
    logger.warn(
      { scheduleId: schedule._id.toString(), executionId: claimed._id.toString(), txRequestId },
      'txrequest canceled',
    );
    return;
  }

  const txid = view.txHashes[0];
  if (txid) {
    // Broadcast submitted; settlement is async — 'confirmed' arrives via webhook (FR-8).
    await ScheduleExecution.updateOne(
      { _id: claimed._id },
      { $set: { status: 'executed', txid, txRequestId, coin: schedule.coin, walletId: schedule.walletId, balanceSnapshot: run.snapshot } },
    );
    schedule.consecutiveDefaultedCount = 0;
    schedule.lastRunAt = scheduledFor;
    await advanceSchedule(schedule);
    logger.info(
      { scheduleId: schedule._id.toString(), executionId: claimed._id.toString(), txRequestId, txid },
      'occurrence executed (awaiting confirmation)',
    );
    return;
  }

  // Txrequest created + accepted; signing/approval still in flight (FR-7).
  // The tick-driven poller (pollPendingTxRequests) advances the document later.
  await ScheduleExecution.updateOne(
    { _id: claimed._id },
    { $set: { status: 'pending_approval', txRequestId, coin: schedule.coin, walletId: schedule.walletId, balanceSnapshot: run.snapshot } },
  );
  schedule.lastRunAt = scheduledFor;
  await advanceSchedule(schedule);
  logger.info(
    { scheduleId: schedule._id.toString(), executionId: claimed._id.toString(), txRequestId, state: view.state },
    'occurrence txrequest awaiting signing/approval',
  );
}

/**
 * Polling worker: each tick advances in-flight executions.
 * 1. pending_approval + txRequestId → re-fetch the txrequest: canceled →
 *    failed, txHash seen → executed (+txid).
 * 2. executed + txid → check the on-chain transfer state; once BitGo reports
 *    it confirmed, the execution becomes 'confirmed' (no webhook needed).
 */
export async function pollPendingTxRequests(): Promise<void> {
  const inFlight = await ScheduleExecution.find({
    txRequestId: { $exists: true, $ne: null },
    status: { $in: ['pending_approval', 'executed'] },
  }).limit(env.workerBatchSize);
  const refreshMs = env.txRequestStatusRefreshMs;
  const now = new Date();
  for (const exec of inFlight) {
    if (!exec.walletId || !exec.txRequestId) {
      continue;
    }
    if (
      refreshMs > 0 &&
      exec.txRequestLastPolledAt &&
      now.getTime() - exec.txRequestLastPolledAt.getTime() < refreshMs
    ) {
      continue; // fetched recently — next tick will pick it up
    }
    let view: TxRequestView | null;
    try {
      view = await bitgoClient.fetchLatestTxRequest(exec.walletId, exec.txRequestId);
    } catch (err) {
      logger.warn({ executionId: exec._id.toString(), err }, 'txrequest poll failed');
      continue;
    }
    if (!view) {
      continue;
    }
    if (view.isCanceled) {
      await ScheduleExecution.updateOne(
        { _id: exec._id },
        { $set: { status: 'failed', error: 'txrequest canceled', txRequestLastPolledAt: now } },
      );
      logger.warn({ executionId: exec._id.toString(), txRequestId: exec.txRequestId }, 'txrequest canceled');
      continue;
    }
    const txid = view.txHashes[0];
    if (txid && exec.status !== 'executed') {
      await ScheduleExecution.updateOne(
        { _id: exec._id },
        { $set: { status: 'executed', txid, txRequestLastPolledAt: now } },
      );
      logger.info({ executionId: exec._id.toString(), txRequestId: exec.txRequestId, txid }, 'txrequest broadcast');
      continue;
    }
    // Still in flight or already executed — record the poll either way.
    await ScheduleExecution.updateOne(
      { _id: exec._id },
      { $set: { txRequestLastPolledAt: now } },
    );
  }
}

/**
 * Poll on-chain confirmation for broadcast executions: an 'executed'
 * execution whose transfer reaches state 'confirmed' becomes 'confirmed'
 * (same outcome the transfer webhook produces, FR-8 — this covers demos
 * without a webhook configured).
 */
export async function pollTransferConfirmations(): Promise<void> {
  const executed = await ScheduleExecution.find({
    status: 'executed',
    txid: { $exists: true, $ne: null },
    coin: { $exists: true, $ne: null },
  }).limit(env.workerBatchSize);
  for (const exec of executed) {
    if (!exec.coin || !exec.walletId || !exec.txid) {
      continue;
    }
    let transfer: { state?: string; confirmations?: number } | undefined;
    try {
      transfer = await bitgoClient.getTransferStatus(exec.coin, exec.walletId, exec.txid);
    } catch (err) {
      logger.warn({ executionId: exec._id.toString(), err }, 'transfer poll failed');
      continue;
    }
    if (transfer?.state === 'confirmed') {
      await ScheduleExecution.updateOne(
        { _id: exec._id },
        { $set: { status: 'confirmed' } },
      );
      logger.info(
        { executionId: exec._id.toString(), txid: exec.txid, confirmations: transfer.confirmations },
        'transfer confirmed',
      );
    }
  }
}

/** Send the upcoming-payment reminder for a schedule, exactly once per occurrence (FR-14). */
export async function sendReminderIfDue(schedule: InstanceType<typeof ScheduledTransaction>) {
  if (schedule.status !== 'active' || !schedule.nextRunAt) {
    return;
  }
  // Timestamp trigger condition: no reminder before the trigger time.
  if (schedule.conditionType === 'timestamp' && schedule.conditionAt && new Date() < schedule.conditionAt) {
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
