import { Schema, model, Types } from 'mongoose';
import type { BalanceConditionOperator, Frequency, ScheduleStatus } from '../types';

export interface ScheduledTransactionDoc {
  _id: Types.ObjectId;
  userId: string;
  enterpriseId?: string;
  walletId: string;
  coin: string;
  destinationAddress: string;
  amount: string; // base units, string to avoid precision loss
  tokenName?: string; // e.g. 'hteth:cusdt' — when set, sends use a transferToken intent
  frequency: Frequency;
  startAt?: Date;
  endAt?: Date;
  timezone: string; // IANA
  note?: string;
  reminderOffsetMs: number;
  status: ScheduleStatus;
  nextRunAt: Date | null;
  lastRunAt?: Date | null;
  consecutiveDefaultedCount: number;
  lastReminderSentForRunAt?: Date | null;
  // Trigger condition (mutually exclusive variants), stored flat:
  // 'balance' → conditionOperator + conditionLimit; 'timestamp' → conditionAt.
  conditionType?: 'balance' | 'timestamp';
  conditionOperator?: BalanceConditionOperator;
  conditionLimit?: string; // base units
  conditionAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const scheduledTransactionSchema = new Schema<ScheduledTransactionDoc>(
  {
    userId: { type: String, required: true, index: true },
    enterpriseId: { type: String },
    walletId: { type: String, required: true, index: true },
    coin: { type: String, required: true },
    destinationAddress: { type: String, required: true },
    amount: { type: String, required: true },
    frequency: {
      type: String,
      required: true,
      enum: ['one_time', 'daily', 'weekly', 'monthly'],
    },
    startAt: { type: Date },
    endAt: { type: Date },
    tokenName: { type: String },
    timezone: { type: String, required: true, default: 'UTC' },
    note: { type: String },
    reminderOffsetMs: { type: Number, required: true },
    status: {
      type: String,
      required: true,
      default: 'active',
      enum: ['active', 'paused', 'cancelled', 'completed'],
    },
    nextRunAt: { type: Date, index: true },
    lastRunAt: { type: Date },
    consecutiveDefaultedCount: { type: Number, default: 0 },
    conditionType: { type: String, enum: ['balance', 'timestamp'] },
    conditionOperator: { type: String, enum: ['above', 'below', 'equals'] },
    conditionLimit: { type: String },
    conditionAt: { type: Date },
    lastReminderSentForRunAt: { type: Date },
  },
  { timestamps: true, collection: 'scheduledTransactions' },
);

// Compound index for the worker's due-schedule scan.
scheduledTransactionSchema.index({ status: 1, nextRunAt: 1 });

export const ScheduledTransaction = model<ScheduledTransactionDoc>(
  'ScheduledTransaction',
  scheduledTransactionSchema,
);
