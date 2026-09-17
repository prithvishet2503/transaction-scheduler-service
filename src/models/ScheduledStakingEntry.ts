import { Schema, model, Types } from 'mongoose';
import type { StakingEntryStatus } from '../types';

export interface ScheduledStakingEntryDoc {
  _id: Types.ObjectId;
  walletId: string;
  coin: string;
  enterpriseId: string;
  userId: string;
  targetRatio: number; // default 0.80
  threshold: number; // default 0.02
  status: StakingEntryStatus;
  nextPollAt: Date | null;
  lastPolledAt?: Date | null;
  consecutiveFailureCount: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const scheduledStakingEntrySchema = new Schema<ScheduledStakingEntryDoc>(
  {
    walletId: { type: String, required: true, index: true },
    coin: { type: String, required: true },
    enterpriseId: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    targetRatio: { type: Number, required: true, default: 0.8, min: 0, max: 1 },
    threshold: { type: Number, required: true, default: 0.02, min: 0, max: 1 },
    status: {
      type: String,
      required: true,
      default: 'active',
      enum: ['active', 'paused', 'cancelled'],
    },
    nextPollAt: { type: Date, index: true },
    lastPolledAt: { type: Date },
    consecutiveFailureCount: { type: Number, default: 0 },
    lastError: { type: String },
  },
  { timestamps: true, collection: 'scheduledStakingEntries' },
);

// Compound index for the worker's due-poll scan.
scheduledStakingEntrySchema.index({ status: 1, nextPollAt: 1 });

export const ScheduledStakingEntry = model<ScheduledStakingEntryDoc>(
  'ScheduledStakingEntry',
  scheduledStakingEntrySchema,
);
