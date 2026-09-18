import { ScheduleExecution } from '../models/ScheduleExecution';
import { ScheduledTransaction } from '../models/ScheduledTransaction';
import { bitgoClient } from './bitgoClient';
import { notify } from './notificationService';
import { computeNextRun } from '../utils/frequency';
import { recipientsFromSchedule, sumAmounts } from '../utils/recipients';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { BalanceSnapshot, TxRequestView } from './bitgoClient';
import type { DefaultReason, NotificationType, Recipient } from '../types';

/**
 * Core execution state machine for one smart transaction occurrence.
 * Balance rules monitor until true; an unmet condition does not create an execution row.
 */

function occurrenceSeq(scheduleId: string, scheduledFor: Date): string {
  return `${scheduleId}:${scheduledFor.getTime()}`;
}

/** Atomically create the occurrence row for a due smart transaction. */
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

async function advanceSchedule(schedule: InstanceType<typeof ScheduledTransaction>) {
  if (schedule.status !== 'active') {
    return;
  }
  if (schedule.conditionType === 'balance') {
    // Balance rules are standing monitors (top-up / rebalance): never complete.
    // Every check re-arms the next check at the configured interval regardless
    // of `repeat`, so a one-shot-looking schedule keeps watching the balance.
    schedule.nextRunAt = new Date(Date.now() + env.balanceCheckIntervalMs);
    await schedule.save();
    return;
  }
  if (!schedule.repeat) {
    schedule.status = 'completed';
    schedule.nextRunAt = null;
    await schedule.save();
    return;
  }
  const next = computeNextRun(schedule.frequency, schedule.nextRunAt ?? new Date(), schedule.timezone);
  if (next === null || (schedule.endAt && next > schedule.endAt)) {
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
  const recipients = recipientsFromSchedule(schedule);
  await notify({
    type,
    userId: schedule.userId,
    scheduleId: schedule._id.toString(),
    walletId: schedule.walletId,
    coin: schedule.coin,
    destinationAddress: recipients[0].address,
    amount: sumAmounts(recipients),
    recipients: recipients.map((r) => ({ address: r.address, amount: r.amount ?? '0' })),
    consecutiveDefaultedCount: schedule.consecutiveDefaultedCount,
    idempotencyKey: `${schedule._id.toString()}:${type}:${Date.now()}`,
    ...extra,
  });
}

function retryBackoff(attempt: number): number {
  return env.retryBackoffMs[Math.min(attempt - 1, env.retryBackoffMs.length - 1)] ?? 60_000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ExecutionPlan = {
  recipients: Recipient[];
  senderSnapshot?: BalanceSnapshot;
};

type OccurrenceOutcome =
  | { outcome: 'defaulted'; reason: DefaultReason; snapshot: BalanceSnapshot }
  | { outcome: 'sent'; snapshot: BalanceSnapshot; txRequestId: string; view: TxRequestView }
  | { outcome: 'token_error'; snapshot: BalanceSnapshot; err: unknown }
  | { outcome: 'error'; snapshot: BalanceSnapshot; err: unknown };

function balanceConditionMet(
  operator: 'above' | 'below',
  balance: bigint,
  threshold: bigint,
): boolean {
  return operator === 'above' ? balance > threshold : balance < threshold;
}

async function monitoredBalance(schedule: InstanceType<typeof ScheduledTransaction>, recipient: Recipient): Promise<BalanceSnapshot> {
  if (schedule.conditionMonitor === 'sender') {
    return bitgoClient.checkBalance(schedule.coin, schedule.walletId, recipient.address);
  }
  if (recipient.walletId) {
    return bitgoClient.checkBalance(schedule.coin, recipient.walletId, recipient.address);
  }
  if (schedule.enterpriseId) {
    const recipientBalance = await bitgoClient.getEnterpriseRecipientBalance(schedule.enterpriseId, schedule.coin);
    return { spendable: recipientBalance.balance, maximumSpendable: null };
  }
  const resolvedWalletId = await bitgoClient.resolveWalletIdByAddress(schedule.coin, recipient.address);
  if (!resolvedWalletId) {
    throw new Error('recipient balance rules require a BitGo wallet address or enterpriseId');
  }
  return bitgoClient.checkBalance(schedule.coin, resolvedWalletId, recipient.address);
}

async function executionPlan(schedule: InstanceType<typeof ScheduledTransaction>): Promise<ExecutionPlan | null> {
  const recipient = recipientsFromSchedule(schedule)[0];
  if (schedule.conditionType === 'timestamp') {
    if (schedule.conditionAt && new Date() < schedule.conditionAt) {
      return null;
    }
    return { recipients: [recipient] };
  }
  if (schedule.conditionType !== 'balance' || !schedule.conditionOperator || !schedule.conditionLimit) {
    return { recipients: [recipient] };
  }
  const snapshot = await monitoredBalance(schedule, recipient);
  schedule.lastBalance = snapshot.spendable;
  schedule.lastCheckAt = new Date();
  await schedule.save();
  const ready = balanceConditionMet(
    schedule.conditionOperator,
    BigInt(snapshot.spendable),
    BigInt(schedule.conditionLimit),
  );
  if (!ready) {
    logger.debug(
      { smartTransactionId: schedule._id.toString(), balance: snapshot.spendable, threshold: schedule.conditionLimit },
      'smart transaction rule not met',
    );
    // Re-arm the next check at the configured interval instead of re-checking
    // on every worker poll.
    schedule.nextRunAt = new Date(Date.now() + env.balanceCheckIntervalMs);
    await schedule.save();
    return null;
  }
  if (ready) {
    // Condition met, but don't stack sends while a previous occurrence is
    // still awaiting signature/broadcast - defer to the next check.
    const inFlight = await ScheduleExecution.findOne({
      scheduleId: schedule._id,
      status: { $in: ['claimed', 'pending_approval'] },
    })
      .lean();
    if (inFlight) {
      logger.debug(
        { smartTransactionId: schedule._id.toString(), executionId: String(inFlight._id) },
        'balance rule met but an execution is still in flight; deferring',
      );
      schedule.nextRunAt = new Date(Date.now() + env.balanceCheckIntervalMs);
      await schedule.save();
      return null;
    }
  }
  if (schedule.leaveBalance) {
    const sendAmount = BigInt(snapshot.spendable) - BigInt(schedule.leaveBalance);
    if (sendAmount <= 0n) {
      // Nothing to sweep above the leave balance yet - re-arm and keep watching.
      schedule.nextRunAt = new Date(Date.now() + env.balanceCheckIntervalMs);
      await schedule.save();
      return null;
    }
    return {
      recipients: [{ address: recipient.address, walletId: recipient.walletId, amount: sendAmount.toString() }],
      senderSnapshot: snapshot,
    };
  }
  return { recipients: [recipient], senderSnapshot: schedule.conditionMonitor === 'sender' ? snapshot : undefined };
}

async function executeOccurrence(
  schedule: InstanceType<typeof ScheduledTransaction>,
  recipients: Recipient[],
  senderSnapshot?: BalanceSnapshot,
): Promise<OccurrenceOutcome> {
  const snapshot = senderSnapshot ?? await bitgoClient.checkBalance(schedule.coin, schedule.walletId, recipients[0].address);
  const totalAmount = sumAmounts(recipients);
  const spendable = BigInt(snapshot.spendable);
  const maximumSpendable = snapshot.maximumSpendable ? BigInt(snapshot.maximumSpendable) : spendable;
  if (spendable < BigInt(totalAmount) || maximumSpendable < BigInt(totalAmount)) {
    return { outcome: 'defaulted', reason: 'INSUFFICIENT_BALANCE', snapshot };
  }
  const intentRecipients = recipients.map((recipient) => {
    const entry: Record<string, unknown> = {
      address: { address: recipient.address },
      amount: { value: recipient.amount, symbol: schedule.tokenName ?? schedule.coin },
    };
    if (schedule.tokenName) {
      entry.tokenData = {
        tokenName: schedule.tokenName,
        tokenType: 'ERC20',
        tokenQuantity: recipient.amount,
      };
    }
    return entry;
  });
  const intent: Record<string, unknown> = {
    intentType: schedule.tokenName ? 'transferToken' : 'payment',
    recipients: intentRecipients,
    sequenceId: `${schedule._id.toString()}:${schedule.nextRunAt?.getTime() ?? Date.now()}`,
    comment: `smart-transaction:${schedule._id.toString()}`,
  };
  try {
    const created = await bitgoClient.createTxRequest(schedule.walletId, intent);
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
      logger.error({ err }, 'bitgo access token invalid — executions pause-safe');
      return { outcome: 'token_error', snapshot, err };
    }
    return { outcome: 'error', snapshot, err };
  }
}

/** Claim + run one occurrence for a due smart transaction. */
export async function processDueSchedule(
  schedule: InstanceType<typeof ScheduledTransaction>,
  workerId: string,
): Promise<void> {
  const scheduledFor = schedule.nextRunAt;
  if (!scheduledFor) {
    return;
  }
  const plan = await executionPlan(schedule);
  if (!plan) {
    return;
  }
  const execution = await ensureExecution(schedule._id.toString(), scheduledFor);
  if (!execution) {
    return;
  }
  // Promised timeline + buffer (timestamp rules only): once the scheduled time
  // plus the buffer window has passed, the occurrence is never attempted or
  // retried again - retries (attempt backoff) and reaper re-arms both funnel
  // through here, so the user is never surprised by a late send.
  if (
    schedule.conditionType === 'timestamp' &&
    Date.now() > scheduledFor.getTime() + env.occurrenceDeadlineMs
  ) {
    const window = Math.round(env.occurrenceDeadlineMs / 60_000);
    await ScheduleExecution.updateOne(
      { _id: execution._id, status: { $in: ['scheduled', 'claimed'] } },
      {
        $set: {
          status: 'failed',
          error: `missed execution window: scheduled ${scheduledFor.toISOString()} + ${window} min buffer exceeded`,
        },
      },
    );
    schedule.lastRunAt = scheduledFor;
    await advanceSchedule(schedule);
    await emit('execution_failed', schedule, {
      executionId: execution._id.toString(),
      scheduledFor: scheduledFor.toISOString(),
    });
    logger.warn(
      { smartTransactionId: schedule._id.toString(), executionId: execution._id.toString(), scheduledFor: scheduledFor.toISOString() },
      'timestamp occurrence expired past promised window; not retrying',
    );
    return;
  }
  const claimed = await claimExecution(execution._id.toString(), workerId);
  if (!claimed) {
    return;
  }

  const run = await executeOccurrence(schedule, plan.recipients, plan.senderSnapshot);

  if (run.outcome === 'defaulted') {
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
      { smartTransactionId: schedule._id.toString(), executionId: claimed._id.toString(), reason: run.reason },
      'smart transaction defaulted',
    );
    return;
  }

  if (run.outcome === 'token_error') {
    return;
  }

  if (run.outcome === 'error') {
    const attempt = (claimed.attempt ?? 0) + 1;
    const err = run.err as Error;
    if (attempt < env.workerMaxAttempts) {
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
      logger.warn({ smartTransactionId: schedule._id.toString(), attempt, err: err?.message }, 'send failed, will retry');
    } else {
      await ScheduleExecution.updateOne(
        { _id: claimed._id },
        { $set: { status: 'failed', attempt, error: err?.message } },
      );
      await emit('execution_failed', schedule, {
        executionId: claimed._id.toString(),
        scheduledFor: scheduledFor.toISOString(),
      });
      logger.error({ smartTransactionId: schedule._id.toString(), attempt, err: err?.message }, 'smart transaction failed');
    }
    return;
  }

  const { txRequestId, view } = run;
  if (view.isCanceled) {
    await ScheduleExecution.updateOne(
      { _id: claimed._id },
      { $set: { status: 'failed', txRequestId, error: 'txrequest canceled', balanceSnapshot: run.snapshot } },
    );
    logger.warn(
      { smartTransactionId: schedule._id.toString(), executionId: claimed._id.toString(), txRequestId },
      'txrequest canceled',
    );
    return;
  }

  const txid = view.txHashes[0];
  if (txid) {
    await ScheduleExecution.updateOne(
      { _id: claimed._id },
      { $set: { status: 'executed', txid, txRequestId, coin: schedule.coin, walletId: schedule.walletId, balanceSnapshot: run.snapshot } },
    );
    schedule.consecutiveDefaultedCount = 0;
    schedule.lastRunAt = scheduledFor;
    await advanceSchedule(schedule);
    logger.info(
      { smartTransactionId: schedule._id.toString(), executionId: claimed._id.toString(), txRequestId, txid },
      'smart transaction executed (awaiting confirmation)',
    );
    return;
  }

  await ScheduleExecution.updateOne(
    { _id: claimed._id },
    { $set: { status: 'pending_approval', txRequestId, coin: schedule.coin, walletId: schedule.walletId, balanceSnapshot: run.snapshot } },
  );
  schedule.lastRunAt = scheduledFor;
  await advanceSchedule(schedule);
  logger.info(
    { smartTransactionId: schedule._id.toString(), executionId: claimed._id.toString(), txRequestId, state: view.state },
    'smart transaction txrequest awaiting signing/approval',
  );
}

/** Poll txrequests created on earlier ticks until they broadcast or fail. */
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
      continue;
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
    await ScheduleExecution.updateOne(
      { _id: exec._id },
      { $set: { txRequestLastPolledAt: now } },
    );
  }
}

/** Poll on-chain confirmation for broadcast executions. */
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

/** Send the upcoming-payment reminder once per timestamp occurrence. */
export async function sendReminderIfDue(schedule: InstanceType<typeof ScheduledTransaction>) {
  if (schedule.status !== 'active' || !schedule.nextRunAt || schedule.conditionType === 'balance') {
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
  logger.info({ smartTransactionId: schedule._id.toString() }, 'upcoming reminder sent');
}
