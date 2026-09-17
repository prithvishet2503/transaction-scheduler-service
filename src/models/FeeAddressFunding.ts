import { Schema, model, Types } from 'mongoose';

export type FundingStatus = 'active' | 'paused' | 'cancelled' | 'completed';

export interface FeeAddressFundingDoc {
  _id: Types.ObjectId;
  userId: string;
  enterpriseId: string;
  coin: string;
  feeAddress: string; // the enterprise gas-tank / fee address (to)
  fromWalletId: string; // custodial wallet funding it (from)
  thresholdAmount: string; // base units; fund when fee-address balance < this
  topUpAmount: string; // base units; amount sent on each funding
  emailOnDefault: boolean;
  status: FundingStatus;
  lastBalance: string | null;
  lastCheckAt: Date | null;
  lastFundedAt: Date | null;
  consecutiveDefaultedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const feeAddressFundingSchema = new Schema<FeeAddressFundingDoc>(
  {
    userId: { type: String, required: true, index: true },
    enterpriseId: { type: String, required: true, index: true },
    coin: { type: String, required: true },
    feeAddress: { type: String, required: true },
    fromWalletId: { type: String, required: true, index: true },
    thresholdAmount: { type: String, required: true },
    topUpAmount: { type: String, required: true },
    emailOnDefault: { type: Boolean, default: true },
    status: {
      type: String,
      required: true,
      default: 'active',
      enum: ['active', 'paused', 'cancelled', 'completed'],
    },
    lastBalance: { type: String, default: null },
    lastCheckAt: { type: Date, default: null },
    lastFundedAt: { type: Date, default: null },
    consecutiveDefaultedCount: { type: Number, default: 0 },
  },
  { timestamps: true, collection: 'feeAddressFundings' },
);

// Monitor hot path: active fundings, batched by (enterpriseId, coin).
feeAddressFundingSchema.index({ status: 1, enterpriseId: 1, coin: 1 });

export const FeeAddressFunding = model<FeeAddressFundingDoc>(
  'FeeAddressFunding',
  feeAddressFundingSchema,
);
