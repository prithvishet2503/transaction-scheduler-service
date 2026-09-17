/** Shared domain types for the transaction scheduler service. */

export type Frequency = 'one_time' | 'daily' | 'weekly' | 'monthly';

/** Discriminator between the two schedule kinds sharing one collection. */
export type ScheduleKind = 'payment' | 'fee-address-funding';

export type ScheduleStatus = 'active' | 'paused' | 'cancelled' | 'completed';

export type ExecutionStatus =
  | 'scheduled'
  | 'claimed'
  | 'executed'
  | 'defaulted'
  | 'pending_approval'
  | 'failed'
  | 'confirmed';

export type DefaultReason = 'INSUFFICIENT_BALANCE' | 'BALANCE_CONDITION_NOT_MET';

/**
 * Trigger condition on a schedule. A creation request carries exactly one
 * variant — balance-relative or timestamp — never both (mutually exclusive).
 */
export type BalanceConditionOperator = 'above' | 'below' | 'equals';

/** Condition as accepted by the creation API. */
export type ScheduleConditionInput =
  | { type: 'balance'; operator: BalanceConditionOperator; limit: string } // base units
  | { type: 'timestamp'; at: string }; // ISO

/** Condition as stored/returned (timestamp materialized to a Date). */
export type ScheduleCondition =
  | { type: 'balance'; operator: BalanceConditionOperator; limit: string } // base units
  | { type: 'timestamp'; at: Date };

export type NotificationType =
  | 'schedule_created'
  | 'upcoming_reminder'
  | 'defaulted'
  | 'execution_failed';

/** One payee in a scheduled send. Amounts are base-unit strings. */
export interface Recipient {
  address: string;
  amount: string;
}

/** Amounts are stored as strings in base units to avoid JS precision loss. */
export interface ScheduleInput {
  userId: string;
  enterpriseId?: string;
  walletId: string;
  coin: string;
  /** Single-payee shortcut; ignored when `recipients` is provided. */
  destinationAddress?: string;
  /** Single-payee shortcut; ignored when `recipients` is provided. */
  amount?: string;
  /** One or more payees. One BitGo send per occurrence. */
  recipients?: Recipient[];
  tokenName?: string; // when set, the send uses a transferToken intent
  frequency: Frequency;
  startAt?: string; // ISO
  endAt?: string; // ISO
  timezone: string; // IANA
  note?: string;
  reminderOffsetMs?: number;
  condition?: ScheduleConditionInput;
}

export interface FeeAddressFundingRecord {
  id: string;
  userId: string;
  enterpriseId?: string;
  coin: string;
  feeAddress: string;
  fromWalletId: string;
  thresholdAmount: string;
  topUpAmount: string;
  emailOnDefault: boolean;
  status: ScheduleStatus;
  lastBalance: string | null;
  lastCheckAt: Date | null;
  lastFundedAt: Date | null;
  consecutiveDefaultedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScheduleRecord {
  kind: ScheduleKind;
  id: string;
  userId: string;
  enterpriseId?: string;
  walletId: string;
  coin: string;
  destinationAddress: string;
  amount: string;
  recipients: Recipient[];
  frequency: Frequency;
  startAt?: Date;
  endAt?: Date;
  timezone: string;
  note?: string;
  reminderOffsetMs: number;
  condition?: ScheduleCondition;
  emailOnDefault?: boolean;
  lastBalance?: string | null;
  lastCheckAt?: Date | null;
  lastFundedAt?: Date | null;
  status: ScheduleStatus;
  nextRunAt: Date | null;
  lastRunAt?: Date | null;
  tokenName?: string;
  consecutiveDefaultedCount: number;
  lastReminderSentForRunAt?: Date | null;
  /** Latest execution summary embedded by listSchedules (FE table column). */
  lastExecution?: {
    status: string;
    reason?: string;
    error?: string;
    txid?: string;
    scheduledFor: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface ExecutionRecord {
  id: string;
  scheduleId: string;
  scheduledFor: Date;
  status: ExecutionStatus;
  reason?: string;
  balanceSnapshot?: { spendable: string; maximumSpendable: string | null };
  txid?: string;
  txRequestId?: string;
  walletId?: string;
  pendingApprovalId?: string;
  attempt: number;
  leasedBy?: string;
  leasedUntil?: Date;
  sequenceId: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}
