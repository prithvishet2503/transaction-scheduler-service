import { Types } from 'mongoose';
import { ScheduledTransaction } from '../models/ScheduledTransaction';
import { ScheduleExecution } from '../models/ScheduleExecution';
import { bitgoClient } from './bitgoClient';
import { computeNextRun, initialNextRunAt, isValidTimezone } from '../utils/frequency';
import {
  RecipientError,
  normalizeRecipient,
  recipientsFromSchedule,
  sumAmounts,
} from '../utils/recipients';
import { env } from '../config/env';
import type {
  BalanceConditionOperator,
  BalanceMonitor,
  Recipient,
  ScheduleInput,
  ScheduleRecord,
  SmartTransactionInput,
  SmartTransactionRule,
  SmartTransactionRuleInput,
} from '../types';
import { logger } from '../utils/logger';

export class SmartTransactionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export const ScheduleError = SmartTransactionError;

type SmartTransactionDoc = InstanceType<typeof ScheduledTransaction>;

export function toRecord(doc: SmartTransactionDoc): ScheduleRecord {
  const recipients = recipientsFromSchedule(doc);
  const recipient = recipients[0];
  return {
    kind: 'smart-transaction',
    id: doc._id.toString(),
    userId: doc.userId,
    enterpriseId: doc.enterpriseId,
    fromWalletId: doc.walletId,
    walletId: doc.walletId,
    coin: doc.coin,
    recipient,
    destinationAddress: recipient.address,
    amount: sumAmounts(recipients),
    tokenName: doc.tokenName,
    frequency: doc.frequency,
    repeat: doc.repeat ?? false,
    rule: docRule(doc),
    condition: docRule(doc),
    startAt: doc.startAt,
    endAt: doc.endAt,
    timezone: doc.timezone,
    note: doc.note,
    reminderOffsetMs: doc.reminderOffsetMs,
    status: doc.status,
    nextRunAt: doc.nextRunAt,
    lastRunAt: doc.lastRunAt,
    consecutiveDefaultedCount: doc.consecutiveDefaultedCount,
    lastReminderSentForRunAt: doc.lastReminderSentForRunAt,
    lastBalance: doc.lastBalance,
    lastCheckAt: doc.lastCheckAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function reminderOffset(input: SmartTransactionInput): number {
  const offset = input.reminderOffsetMs ?? env.defaultReminderOffsetMs;
  return Math.max(offset, env.minReminderOffsetMs);
}

function positiveBaseUnit(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SmartTransactionError(`${field} must be a string amount in base units`, 400);
  }
  try {
    if (BigInt(value) <= 0n) {
      throw new SmartTransactionError(`${field} must be a positive integer in base units`, 400);
    }
  } catch (err) {
    if (err instanceof SmartTransactionError) {
      throw err;
    }
    throw new SmartTransactionError(`${field} must be a positive integer in base units`, 400);
  }
  return value;
}

function normalizeRule(raw: SmartTransactionRuleInput | undefined | null): {
  conditionType: 'balance' | 'timestamp';
  conditionMonitor?: BalanceMonitor;
  conditionOperator?: BalanceConditionOperator;
  conditionLimit?: string;
  leaveBalance?: string;
  conditionAt?: Date;
} {
  if (raw === undefined || raw === null) {
    throw new SmartTransactionError('rule is required', 400);
  }
  const rule = raw as Record<string, unknown>;
  if (rule.type === 'timestamp') {
    if (typeof rule.at !== 'string' || Number.isNaN(new Date(rule.at).getTime())) {
      throw new SmartTransactionError('rule.at must be a valid ISO date', 400);
    }
    return { conditionType: 'timestamp', conditionAt: new Date(rule.at) };
  }
  if (rule.type !== 'balance') {
    throw new SmartTransactionError("rule.type must be 'timestamp' or 'balance'", 400);
  }
  if (rule.monitor !== 'sender' && rule.monitor !== 'recipient') {
    throw new SmartTransactionError("rule.monitor must be 'sender' or 'recipient'", 400);
  }
  if (rule.operator !== 'above' && rule.operator !== 'below') {
    throw new SmartTransactionError("rule.operator must be 'above' or 'below'", 400);
  }
  const threshold = positiveBaseUnit(rule.threshold ?? rule.limit, 'rule.threshold');
  const normalized: {
    conditionType: 'balance';
    conditionMonitor: BalanceMonitor;
    conditionOperator: BalanceConditionOperator;
    conditionLimit: string;
    leaveBalance?: string;
  } = {
    conditionType: 'balance',
    conditionMonitor: rule.monitor,
    conditionOperator: rule.operator,
    conditionLimit: threshold,
  };
  if (rule.leaveBalance !== undefined) {
    const leaveBalance = positiveBaseUnit(rule.leaveBalance, 'rule.leaveBalance');
    if (rule.monitor !== 'sender' || rule.operator !== 'above') {
      throw new SmartTransactionError('rule.leaveBalance is only supported for sender balance above rules', 400);
    }
    if (BigInt(leaveBalance) > BigInt(threshold)) {
      throw new SmartTransactionError('rule.leaveBalance must be less than or equal to rule.threshold', 400);
    }
    normalized.leaveBalance = leaveBalance;
  }
  return normalized;
}

function docRule(doc: SmartTransactionDoc): SmartTransactionRule | undefined {
  switch (doc.conditionType) {
    case 'balance':
      return {
        type: 'balance',
        monitor: doc.conditionMonitor as BalanceMonitor,
        operator: doc.conditionOperator as BalanceConditionOperator,
        threshold: doc.conditionLimit as string,
        ...(doc.leaveBalance ? { leaveBalance: doc.leaveBalance } : {}),
      };
    case 'timestamp':
      return { type: 'timestamp', at: doc.conditionAt as Date };
    default:
      return undefined;
  }
}

async function validateRecipientAddress(coin: string, recipient: Recipient): Promise<void> {
  const ok = await bitgoClient.isValidAddress(coin, recipient.address);
  if (!ok) {
    throw new SmartTransactionError(`recipient.address is invalid for coin: ${recipient.address}`, 400);
  }
}

function normalizeSmartInput(input: SmartTransactionInput | ScheduleInput): SmartTransactionInput {
  return {
    ...input,
    fromWalletId: input.fromWalletId ?? input.walletId ?? '',
    rule: input.rule ?? input.condition,
    timezone: input.timezone ?? 'UTC',
    frequency: input.frequency ?? 'one_time',
  };
}

export async function createSmartTransaction(rawInput: SmartTransactionInput | ScheduleInput): Promise<ScheduleRecord> {
  const input = normalizeSmartInput(rawInput);
  if (!input.fromWalletId || !input.coin) {
    throw new SmartTransactionError('fromWalletId and coin are required', 400);
  }
  if (!isValidTimezone(input.timezone ?? 'UTC')) {
    throw new SmartTransactionError(`invalid IANA timezone: ${input.timezone}`, 400);
  }
  const rule = normalizeRule(input.rule);
  let recipient: Recipient;
  try {
    recipient = normalizeRecipient(input);
  } catch (err) {
    if (err instanceof RecipientError) {
      throw new SmartTransactionError(err.message, err.status);
    }
    throw err;
  }
  if (rule.conditionType === 'balance' && rule.conditionMonitor === 'recipient' && !recipient.walletId && !input.enterpriseId) {
    const resolvedWalletId = await bitgoClient.resolveWalletIdByAddress(input.coin, recipient.address);
    if (!resolvedWalletId) {
      throw new SmartTransactionError(`recipient address does not belong to a BitGo wallet: ${recipient.address}`, 400);
    }
    recipient = { ...recipient, walletId: resolvedWalletId };
  }
  if (!rule.leaveBalance && !recipient.amount) {
    throw new SmartTransactionError('recipient.amount is required unless rule.leaveBalance computes the send amount', 400);
  }
  await validateRecipientAddress(input.coin, recipient);

  const startAt = input.startAt ? new Date(input.startAt) : undefined;
  const endAt = input.endAt ? new Date(input.endAt) : undefined;
  const nextRunAt = rule.conditionType === 'timestamp'
    ? rule.conditionAt ?? initialNextRunAt(input.frequency ?? 'one_time', startAt, input.timezone ?? 'UTC')
    : initialNextRunAt(input.frequency ?? 'one_time', startAt, input.timezone ?? 'UTC');
  const amount = recipient.amount ?? '0';
  const doc = await ScheduledTransaction.create({
    kind: 'smart-transaction',
    userId: input.userId,
    enterpriseId: input.enterpriseId,
    walletId: input.fromWalletId,
    coin: input.coin,
    destinationAddress: recipient.address,
    amount,
    recipients: [{ ...recipient, amount }],
    tokenName: input.tokenName || undefined,
    frequency: input.frequency ?? 'one_time',
    repeat: input.repeat ?? false,
    startAt,
    endAt,
    timezone: input.timezone ?? 'UTC',
    note: input.note,
    reminderOffsetMs: reminderOffset(input),
    status: 'active',
    nextRunAt,
    lastRunAt: null,
    consecutiveDefaultedCount: 0,
    lastReminderSentForRunAt: null,
    lastBalance: null,
    lastCheckAt: null,
    ...rule,
  });

  logger.info({ smartTransactionId: doc._id.toString(), userId: input.userId, walletId: input.fromWalletId }, 'smart transaction created');
  return toRecord(doc);
}

export async function listSmartTransactions(
  userId: string,
  opts: { status?: string; walletId?: string; limit?: number; cursor?: string } = {},
): Promise<{ items: ScheduleRecord[]; nextCursor?: string }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const query: Record<string, unknown> = { userId };
  if (opts.status) {
    query.status = opts.status;
  }
  if (opts.walletId) {
    query.walletId = opts.walletId;
  }
  const cursorDoc = opts.cursor ? await ScheduledTransaction.findById(opts.cursor).lean() : null;
  if (cursorDoc) {
    query._id = { $gt: cursorDoc._id };
  }
  const docs = await ScheduledTransaction.find(query as never)
    .sort({ _id: 1 })
    .limit(limit + 1);
  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const nextCursor = hasMore ? page[page.length - 1]?._id.toString() : undefined;
  const smartTransactionIds = page.map((d) => d._id);
  const executions = await ScheduleExecution.find({ scheduleId: { $in: smartTransactionIds } })
    .sort({ scheduledFor: -1 })
    .limit(smartTransactionIds.length * 5)
    .lean();
  const latestBySchedule = new Map<string, ScheduleRecord['lastExecution']>();
  for (const execution of executions) {
    const key = execution.scheduleId.toString();
    if (!latestBySchedule.has(key)) {
      latestBySchedule.set(key, {
        status: execution.status,
        reason: execution.reason,
        error: execution.error,
        txid: execution.txid,
        scheduledFor: execution.scheduledFor,
      });
    }
  }
  return {
    items: page.map((doc) => ({ ...toRecord(doc), lastExecution: latestBySchedule.get(doc._id.toString()) })),
    nextCursor,
  };
}

export async function getSmartTransaction(userId: string, id: string): Promise<ScheduleRecord> {
  if (!Types.ObjectId.isValid(id)) {
    throw new SmartTransactionError('invalid smart transaction id', 400);
  }
  const doc = await ScheduledTransaction.findOne({ _id: id, userId });
  if (!doc) {
    throw new SmartTransactionError('smart transaction not found', 404);
  }
  return toRecord(doc);
}

export async function updateSmartTransaction(
  userId: string,
  id: string,
  patch: {
    recipient?: Recipient;
    destinationAddress?: string;
    amount?: string;
    endAt?: string | null;
    note?: string;
    reminderOffsetMs?: number;
    rule?: SmartTransactionRuleInput | null;
  },
): Promise<ScheduleRecord> {
  const smartTransaction = await getSmartTransaction(userId, id);
  const changes: Record<string, unknown> = {};
  if (patch.recipient !== undefined || patch.destinationAddress !== undefined || patch.amount !== undefined) {
    const recipient = normalizeRecipient({
      recipient: patch.recipient,
      destinationAddress: patch.destinationAddress ?? smartTransaction.destinationAddress,
      amount: patch.amount ?? smartTransaction.recipient.amount,
    });
    await validateRecipientAddress(smartTransaction.coin, recipient);
    changes.recipients = [{ ...recipient, amount: recipient.amount ?? '0' }];
    changes.destinationAddress = recipient.address;
    changes.amount = recipient.amount ?? '0';
  }
  if (patch.endAt !== undefined) {
    changes.endAt = patch.endAt ? new Date(patch.endAt) : null;
  }
  if (patch.note !== undefined) {
    changes.note = patch.note;
  }
  if (patch.reminderOffsetMs !== undefined) {
    changes.reminderOffsetMs = Math.max(patch.reminderOffsetMs, env.minReminderOffsetMs);
  }
  if (patch.rule !== undefined) {
    if (patch.rule === null) {
      throw new SmartTransactionError('rule cannot be cleared', 400);
    }
    Object.assign(changes, normalizeRule(patch.rule));
  }
  const doc = await ScheduledTransaction.findOneAndUpdate(
    { _id: id, userId },
    { $set: changes },
    { new: true },
  );
  if (!doc) {
    throw new SmartTransactionError('smart transaction not found', 404);
  }
  logger.info({ smartTransactionId: id, userId }, 'smart transaction updated');
  return toRecord(doc);
}

export async function setSmartTransactionStatus(
  userId: string,
  id: string,
  status: ScheduleRecord['status'],
): Promise<ScheduleRecord> {
  const doc = await ScheduledTransaction.findOneAndUpdate({ _id: id, userId }, { $set: { status } }, { new: true });
  if (!doc) {
    throw new SmartTransactionError('smart transaction not found', 404);
  }
  if (status === 'active' && !doc.nextRunAt) {
    doc.nextRunAt = computeNextRun(doc.frequency, new Date(), doc.timezone) ?? new Date();
    await doc.save();
  }
  logger.info({ smartTransactionId: id, userId, status }, 'smart transaction status changed');
  return toRecord(doc);
}

export const cancelSmartTransaction = (userId: string, id: string) => setSmartTransactionStatus(userId, id, 'cancelled');
export const pauseSmartTransaction = (userId: string, id: string) => setSmartTransactionStatus(userId, id, 'paused');
export const resumeSmartTransaction = (userId: string, id: string) => setSmartTransactionStatus(userId, id, 'active');

export const createSchedule = createSmartTransaction;
export const listSchedules = listSmartTransactions;
export const getSchedule = getSmartTransaction;
export const updateSchedule = updateSmartTransaction;
export const cancelSchedule = cancelSmartTransaction;
export const pauseSchedule = pauseSmartTransaction;
export const resumeSchedule = resumeSmartTransaction;
