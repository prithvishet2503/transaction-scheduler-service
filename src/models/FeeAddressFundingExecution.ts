import { Schema, model, Types } from 'mongoose';

export interface FeeAddressFundingExecutionDoc {
  _id: Types.ObjectId;
  fundingId: Types.ObjectId;
  status: 'executed' | 'pending_approval' | 'defaulted' | 'failed';
  amount: string;
  balanceAtCheck: string;
  txid?: string;
  pendingApprovalId?: string;
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const feeAddressFundingExecutionSchema = new Schema<FeeAddressFundingExecutionDoc>(
  {
    fundingId: { type: Schema.Types.ObjectId, ref: 'FeeAddressFunding', required: true, index: true },
    status: {
      type: String,
      required: true,
      enum: ['executed', 'pending_approval', 'defaulted', 'failed'],
    },
    amount: { type: String, required: true },
    balanceAtCheck: { type: String, required: true },
    txid: { type: String },
    pendingApprovalId: { type: String },
    reason: { type: String },
  },
  { timestamps: true, collection: 'feeAddressFundingExecutions' },
);

export const FeeAddressFundingExecution = model<FeeAddressFundingExecutionDoc>(
  'FeeAddressFundingExecution',
  feeAddressFundingExecutionSchema,
);
