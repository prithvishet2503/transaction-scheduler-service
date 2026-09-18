import { Schema, model, Types } from 'mongoose';
import type {
  BalanceConditionOperator,
  BalanceMonitor,
  Frequency,
  Recipient,
  ScheduleKind,
  ScheduleStatus,
} from '../types';

export interface ScheduledTransactionDoc {
  _id: Types.ObjectId;
  kind: ScheduleKind;
  userId: string;
  enterpriseId?: string;
  walletId: string; // sender / source wallet id
  coin: string;
  destinationAddress: string;
  amount: string; // fixed amount, or computed amount recorded as '0' for sweep rules
  tokenName?: string;
  recipients?: Recipient[];
  frequency: Frequency;
  repeat: boolean;
  startAt?: Date;
  endAt?: Date;
  timezone: string;
  note?: string;
  reminderOffsetMs: number;
  status: ScheduleStatus;
  nextRunAt: Date | null;
  lastRunAt?: Date | null;
  consecutiveDefaultedCount: number;
  lastReminderSentForRunAt?: Date | null;
  lastBalance?: string | null;
  lastCheckAt?: Date | null;
  conditionType?: 'balance' | 'timestamp';
  conditionMonitor?: BalanceMonitor;
  conditionOperator?: BalanceConditionOperator;
  conditionLimit?: string; // threshold in base units
  leaveBalance?: string; // sender sweep: balance left after execution
  conditionAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const scheduledTransactionSchema = new Schema<ScheduledTransactionDoc>(
  {
    kind: {
      type: String,
      enum: ['smart-transaction'],
      default: 'smart-transaction',
      required: true,
    },
    userId: { type: String, required: true, index: true },
    enterpriseId: { type: String },
    walletId: { type: String, required: true, index: true },
    coin: { type: String, required: true },
    destinationAddress: { type: String, required: true },
    amount: { type: String, required: true },
    recipients: {
      type: [
        {
          address: { type: String, required: true },
          amount: { type: String },
          walletId: { type: String },
          _id: false,
        },
      ],
      default: undefined,
    },
    frequency: {
      type: String,
      required: true,
      enum: ['one_time', 'daily', 'weekly', 'monthly'],
      default: 'one_time',
    },
    repeat: { type: Boolean, required: true, default: false },
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
    conditionMonitor: { type: String, enum: ['sender', 'recipient'] },
    conditionOperator: { type: String, enum: ['above', 'below'] },
    conditionLimit: { type: String },
    leaveBalance: { type: String },
    conditionAt: { type: Date },
    lastReminderSentForRunAt: { type: Date },
    lastBalance: { type: String, default: null },
    lastCheckAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'smartTxns' },
);

// Worker due-scan. Balance rules remain due while active, so the worker keeps monitoring them.
scheduledTransactionSchema.index({ status: 1, nextRunAt: 1 });
scheduledTransactionSchema.index({ kind: 1, status: 1, coin: 1 });

export const ScheduledTransaction = model<ScheduledTransactionDoc>(
  'ScheduledTransaction',
  scheduledTransactionSchema,
);
