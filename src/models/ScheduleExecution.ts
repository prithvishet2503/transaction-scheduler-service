import { Schema, model, Types } from 'mongoose';
import type { ExecutionStatus } from '../types';

export interface ScheduleExecutionDoc {
  _id: Types.ObjectId;
  scheduleId: Types.ObjectId;
  scheduledFor: Date;
  status: ExecutionStatus;
  reason?: string;
  balanceSnapshot?: { spendable: string; maximumSpendable: string | null };
  txid?: string;
  pendingApprovalId?: string;
  attempt: number;
  leasedBy?: string;
  leasedUntil?: Date;
  sequenceId: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const scheduleExecutionSchema = new Schema<ScheduleExecutionDoc>(
  {
    scheduleId: {
      type: Schema.Types.ObjectId,
      ref: 'ScheduledTransaction',
      required: true,
    },
    scheduledFor: { type: Date, required: true },
    status: {
      type: String,
      required: true,
      default: 'scheduled',
      enum: [
        'scheduled',
        'claimed',
        'executed',
        'defaulted',
        'pending_approval',
        'failed',
        'confirmed',
      ],
      index: true,
    },
    reason: { type: String },
    balanceSnapshot: {
      spendable: { type: String },
      maximumSpendable: { type: String, default: null },
    },
    txid: { type: String, index: true },
    pendingApprovalId: { type: String },
    attempt: { type: Number, default: 0 },
    leasedBy: { type: String },
    leasedUntil: { type: Date },
    sequenceId: { type: String, required: true, index: true },
    error: { type: String },
  },
  { timestamps: true, collection: 'scheduleExecutions' },
);

// Exactly one execution per (schedule, occurrence) — prevents duplicate ticks.
scheduleExecutionSchema.index(
  { scheduleId: 1, scheduledFor: 1 },
  { unique: true },
);
// Worker's due-scan + reaper's stuck-claim scan.
scheduleExecutionSchema.index({ status: 1, scheduledFor: 1 });

export const ScheduleExecution = model<ScheduleExecutionDoc>(
  'ScheduleExecution',
  scheduleExecutionSchema,
);
