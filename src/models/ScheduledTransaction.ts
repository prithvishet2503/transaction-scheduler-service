import { Schema, model, Types } from 'mongoose';
import type { Frequency, Recipient, ScheduleStatus } from '../types';

export interface ScheduledTransactionDoc {
  _id: Types.ObjectId;
  userId: string;
  enterpriseId?: string;
  walletId: string;
  coin: string;
  destinationAddress: string;
  amount: string; // total of recipients, base units as string
  recipients?: Recipient[];
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
    recipients: {
      type: [
        {
          address: { type: String, required: true },
          amount: { type: String, required: true },
          _id: false,
        },
      ],
      default: undefined,
    },
    frequency: {
      type: String,
      required: true,
      enum: ['one_time', 'daily', 'weekly', 'monthly'],
    },
    startAt: { type: Date },
    endAt: { type: Date },
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
