/** Shared domain types for the transaction scheduler service. */

export type Frequency = 'one_time' | 'daily' | 'weekly' | 'monthly';

export type SmartTransactionKind = 'smart-transaction';
export type ScheduleKind = SmartTransactionKind;

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

export type BalanceConditionOperator = 'above' | 'below';
export type BalanceMonitor = 'sender' | 'recipient';

export type SmartTransactionRuleInput =
  | { type: 'timestamp'; at: string }
  | {
      type: 'balance';
      monitor: BalanceMonitor;
      operator: BalanceConditionOperator;
      threshold?: string;
      limit?: string;
      leaveBalance?: string;
    };

export type SmartTransactionRule =
  | { type: 'timestamp'; at: Date }
  | {
      type: 'balance';
      monitor: BalanceMonitor;
      operator: BalanceConditionOperator;
      threshold: string;
      leaveBalance?: string;
    };

export type ScheduleConditionInput = SmartTransactionRuleInput;
export type ScheduleCondition = SmartTransactionRule;

export type NotificationType =
  | 'schedule_created'
  | 'upcoming_reminder'
  | 'defaulted'
  | 'execution_failed';

/** One payee in a smart transaction. Amount is optional for sender sweep rules. */
export interface Recipient {
  address: string;
  amount?: string;
  walletId?: string;
}

/** Amounts are stored as strings in base units to avoid JS precision loss. */
export interface SmartTransactionInput {
  userId: string;
  enterpriseId?: string;
  fromWalletId: string;
  walletId?: string;
  coin: string;
  /** Single-recipient shortcut. */
  recipient?: Recipient;
  /** Legacy single-payee shortcut. */
  destinationAddress?: string;
  /** Legacy single-payee shortcut. */
  amount?: string;
  tokenName?: string;
  rule: SmartTransactionRuleInput;
  condition?: SmartTransactionRuleInput;
  repeat?: boolean;
  frequency?: Frequency;
  startAt?: string;
  endAt?: string;
  timezone?: string;
  note?: string;
  reminderOffsetMs?: number;
}

export type ScheduleInput = SmartTransactionInput & {
  recipients?: Recipient[];
};

export interface SmartTransactionRecord {
  kind: SmartTransactionKind;
  id: string;
  userId: string;
  enterpriseId?: string;
  fromWalletId: string;
  walletId: string;
  coin: string;
  recipient: Recipient;
  destinationAddress: string;
  amount: string;
  tokenName?: string;
  rule?: SmartTransactionRule;
  condition?: SmartTransactionRule;
  repeat: boolean;
  frequency: Frequency;
  startAt?: Date;
  endAt?: Date;
  timezone: string;
  note?: string;
  reminderOffsetMs: number;
  status: ScheduleStatus;
  nextRunAt: Date | null;
  lastRunAt?: Date | null;
  lastBalance?: string | null;
  lastCheckAt?: Date | null;
  consecutiveDefaultedCount: number;
  lastReminderSentForRunAt?: Date | null;
  /** Latest execution summary embedded by listSmartTransactions. */
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

export type ScheduleRecord = SmartTransactionRecord;

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
