/** Shared domain types for the transaction scheduler service. */

export type Frequency = 'one_time' | 'daily' | 'weekly' | 'monthly';

export type ScheduleStatus = 'active' | 'paused' | 'cancelled' | 'completed';

export type ExecutionStatus =
  | 'scheduled'
  | 'claimed'
  | 'executed'
  | 'defaulted'
  | 'pending_approval'
  | 'failed'
  | 'confirmed';

export type DefaultReason = 'INSUFFICIENT_BALANCE';

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
  /** One or more payees. One BitGo `sendMany` per occurrence. */
  recipients?: Recipient[];
  frequency: Frequency;
  startAt?: string; // ISO
  endAt?: string; // ISO
  timezone: string; // IANA
  note?: string;
  reminderOffsetMs?: number;
}

export interface ScheduleRecord {
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
  status: ScheduleStatus;
  nextRunAt: Date | null;
  lastRunAt?: Date | null;
  consecutiveDefaultedCount: number;
  lastReminderSentForRunAt?: Date | null;
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
  pendingApprovalId?: string;
  attempt: number;
  leasedBy?: string;
  leasedUntil?: Date;
  sequenceId: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}
