import { Types } from 'mongoose';
import { ScheduledTransaction } from '../models/ScheduledTransaction';
import { bitgoClient } from './bitgoClient';
import { computeNextRun, initialNextRunAt, isValidTimezone } from '../utils/frequency';
import {
  RecipientError,
  normalizeRecipients,
  recipientsFromSchedule,
  sumAmounts,
} from '../utils/recipients';
import { env } from '../config/env';
import type {
  BalanceConditionOperator,
  Recipient,
  ScheduleCondition,
  ScheduleConditionInput,
  ScheduleInput,
  ScheduleRecord,
} from '../types';
import { logger } from '../utils/logger';

export class ScheduleError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function toRecord(doc: InstanceType<typeof ScheduledTransaction>): ScheduleRecord {
  const recipients = recipientsFromSchedule(doc);
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    enterpriseId: doc.enterpriseId,
    walletId: doc.walletId,
    coin: doc.coin,
    destinationAddress: recipients[0].address,
    amount: sumAmounts(recipients),
    recipients,
    tokenName: doc.tokenName,
    frequency: doc.frequency,
    condition: docCondition(doc),
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
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function reminderOffset(input: ScheduleInput): number {
  const offset = input.reminderOffsetMs ?? env.defaultReminderOffsetMs;
  return Math.max(offset, env.minReminderOffsetMs);
}

/**
 * Validate + normalize the trigger condition. A request carries exactly one
 * variant — balance-relative or timestamp — never both; anything else is a
 * 400. Returns the flat doc fields to persist.
 */
function normalizeCondition(raw: ScheduleConditionInput | undefined | null): {
  conditionType?: 'balance' | 'timestamp';
  conditionOperator?: BalanceConditionOperator;
  conditionLimit?: string;
  conditionAt?: Date;
} {
  if (raw === undefined || raw === null) {
    return {};
  }
  const c = raw as Record<string, unknown>;
  if (c.type !== 'balance' && c.type !== 'timestamp') {
    throw new ScheduleError("condition.type must be 'balance' or 'timestamp'", 400);
  }
  if (c.type === 'balance') {
    if (c.at !== undefined) {
      throw new ScheduleError('condition: provide either a balance limit or a timestamp (at), not both', 400);
    }
    if (c.operator !== 'above' && c.operator !== 'below' && c.operator !== 'equals') {
      throw new ScheduleError("condition.operator must be 'above', 'below' or 'equals'", 400);
    }
    if (typeof c.limit !== 'string') {
      throw new ScheduleError('condition.limit must be a string amount in base units', 400);
    }
    let limit: bigint;
    try {
      limit = BigInt(c.limit);
    } catch {
      throw new ScheduleError('condition.limit must be a positive integer in base units', 400);
    }
    if (limit <= 0n) {
      throw new ScheduleError('condition.limit must be a positive integer in base units', 400);
    }
    return { conditionType: 'balance', conditionOperator: c.operator, conditionLimit: c.limit };
  }
  // type === 'timestamp'
  if (c.operator !== undefined || c.limit !== undefined) {
    throw new ScheduleError('condition: provide either a balance limit or a timestamp (at), not both', 400);
  }
  if (typeof c.at !== 'string' || Number.isNaN(new Date(c.at).getTime())) {
    throw new ScheduleError('condition.at must be a valid ISO date', 400);
  }
  return { conditionType: 'timestamp', conditionAt: new Date(c.at) };
}

/** Rebuild the structured condition from the flat doc fields. */
function docCondition(doc: InstanceType<typeof ScheduledTransaction>): ScheduleCondition | undefined {
  switch (doc.conditionType) {
    case 'balance':
      return {
        type: 'balance',
        operator: doc.conditionOperator as BalanceConditionOperator,
        limit: doc.conditionLimit as string,
      };
    case 'timestamp':
      return { type: 'timestamp', at: doc.conditionAt as Date };
    default:
      return undefined;
  }
}

async function validateRecipientAddresses(coin: string, recipients: Recipient[]): Promise<void> {
  for (const r of recipients) {
    const ok = await bitgoClient.isValidAddress(coin, r.address);
    if (!ok) {
      throw new ScheduleError(`destination address is invalid for coin: ${r.address}`, 400);
    }
  }
}

export async function createSchedule(input: ScheduleInput): Promise<ScheduleRecord> {
  if (!input.walletId || !input.coin) {
    throw new ScheduleError('walletId, coin and destinationAddress (or recipients) are required', 400);
  }
  let recipients: Recipient[];
  try {
    recipients = normalizeRecipients(input);
  } catch (err) {
    if (err instanceof RecipientError) {
      throw new ScheduleError(err.message, err.status);
    }
    throw err;
  }
  if (!['one_time', 'daily', 'weekly', 'monthly'].includes(input.frequency)) {
    throw new ScheduleError('invalid frequency', 400);
  }
  if (!isValidTimezone(input.timezone)) {
    throw new ScheduleError(`invalid IANA timezone: ${input.timezone}`, 400);
  }
  const condition = normalizeCondition(input.condition);
  await validateRecipientAddresses(input.coin, recipients);

  const startAt = input.startAt ? new Date(input.startAt) : undefined;
  const endAt = input.endAt ? new Date(input.endAt) : undefined;
  const nextRunAt = initialNextRunAt(input.frequency, startAt, input.timezone);

  // FR-4: schedule creation never checks balance — zero-balance wallets are accepted.
  const doc = await ScheduledTransaction.create({
    userId: input.userId,
    enterpriseId: input.enterpriseId,
    walletId: input.walletId,
    coin: input.coin,
    destinationAddress: recipients[0].address,
    amount: sumAmounts(recipients),
    recipients,
    tokenName: input.tokenName || undefined,
    frequency: input.frequency,
    startAt,
    endAt,
    timezone: input.timezone,
    note: input.note,
    reminderOffsetMs: reminderOffset(input),
    status: 'active',
    nextRunAt,
    lastRunAt: null,
    consecutiveDefaultedCount: 0,
    lastReminderSentForRunAt: null,
    ...condition,
  });

  logger.info({ scheduleId: doc._id.toString(), userId: input.userId, walletId: input.walletId }, 'schedule created');
  return toRecord(doc);
}

export async function listSchedules(
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
  return { items: page.map(toRecord), nextCursor };
}

export async function getSchedule(userId: string, id: string): Promise<ScheduleRecord> {
  if (!Types.ObjectId.isValid(id)) {
    throw new ScheduleError('invalid schedule id', 400);
  }
  const doc = await ScheduledTransaction.findOne({ _id: id, userId });
  if (!doc) {
    throw new ScheduleError('schedule not found', 404);
  }
  return toRecord(doc);
}

export async function updateSchedule(
  userId: string,
  id: string,
  patch: {
    destinationAddress?: string;
    amount?: string;
    recipients?: Recipient[];
    frequency?: ScheduleRecord['frequency'];
    endAt?: string | null;
    note?: string;
    reminderOffsetMs?: number;
    condition?: ScheduleConditionInput | null;
  },
): Promise<ScheduleRecord> {
  const schedule = await getSchedule(userId, id);
  const changes: Record<string, unknown> = {};

  if (patch.recipients !== undefined) {
    let recipients: Recipient[];
    try {
      recipients = normalizeRecipients({ recipients: patch.recipients });
    } catch (err) {
      if (err instanceof RecipientError) {
        throw new ScheduleError(err.message, err.status);
      }
      throw err;
    }
    await validateRecipientAddresses(schedule.coin, recipients);
    changes.recipients = recipients;
    changes.destinationAddress = recipients[0].address;
    changes.amount = sumAmounts(recipients);
  } else {
    if (
      (patch.destinationAddress !== undefined || patch.amount !== undefined) &&
      schedule.recipients.length > 1
    ) {
      throw new ScheduleError('use recipients to update a multi-payee schedule', 400);
    }
    if (patch.destinationAddress !== undefined) {
      const ok = await bitgoClient.isValidAddress(schedule.coin, patch.destinationAddress);
      if (!ok) {
        throw new ScheduleError('destination address is invalid for coin', 400);
      }
      changes.destinationAddress = patch.destinationAddress;
    }
    if (patch.amount !== undefined) {
      if (BigInt(patch.amount) <= 0n) {
        throw new ScheduleError('amount must be a positive integer in base units', 400);
      }
      changes.amount = patch.amount;
    }
    if (patch.destinationAddress !== undefined || patch.amount !== undefined) {
      const nextAddress =
        (changes.destinationAddress as string | undefined) ?? schedule.destinationAddress;
      const nextAmount = (changes.amount as string | undefined) ?? schedule.amount;
      changes.recipients = [{ address: nextAddress, amount: nextAmount }];
    }
  }
  if (patch.frequency !== undefined) {
    if (!['one_time', 'daily', 'weekly', 'monthly'].includes(patch.frequency)) {
      throw new ScheduleError('invalid frequency', 400);
    }
    changes.frequency = patch.frequency;
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
  if (patch.condition !== undefined) {
    if (patch.condition === null) {
      // Explicit clear: the schedule loses its trigger condition.
      changes.conditionType = null;
      changes.conditionOperator = null;
      changes.conditionLimit = null;
      changes.conditionAt = null;
    } else {
      // Same mutual-exclusivity + field validation as creation.
      Object.assign(changes, normalizeCondition(patch.condition));
    }
  }

  const effective = { ...schedule, ...changes };
  // Recompute next run if a scheduling-affecting field changed and it's active.
  if (
    schedule.status === 'active' &&
    (changes.frequency !== undefined ||
      changes.amount !== undefined ||
      changes.destinationAddress !== undefined ||
      changes.recipients !== undefined)
  ) {
    changes.nextRunAt = computeNextRun(effective.frequency, new Date(), effective.timezone);
  }

  const doc = await ScheduledTransaction.findOneAndUpdate(
    { _id: id, userId },
    { $set: changes },
    { new: true },
  );
  if (!doc) {
    throw new ScheduleError('schedule not found', 404);
  }
  logger.info({ scheduleId: id, userId }, 'schedule updated');
  return toRecord(doc);
}

export async function setScheduleStatus(
  userId: string,
  id: string,
  status: ScheduleRecord['status'],
): Promise<ScheduleRecord> {
  const doc = await ScheduledTransaction.findOneAndUpdate({ _id: id, userId }, { $set: { status } }, { new: true });
  if (!doc) {
    throw new ScheduleError('schedule not found', 404);
  }
  if (status === 'active' && !doc.nextRunAt) {
    doc.nextRunAt = computeNextRun(doc.frequency, new Date(), doc.timezone);
    await doc.save();
  }
  logger.info({ scheduleId: id, userId, status }, 'schedule status changed');
  return toRecord(doc);
}

export const cancelSchedule = (userId: string, id: string) => setScheduleStatus(userId, id, 'cancelled');
export const pauseSchedule = (userId: string, id: string) => setScheduleStatus(userId, id, 'paused');
export const resumeSchedule = (userId: string, id: string) => setScheduleStatus(userId, id, 'active');
