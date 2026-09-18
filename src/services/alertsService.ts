import { ScheduledTransaction } from '../models/ScheduledTransaction';
import { toRecord } from './smartTransactionService';
import type { ScheduleRecord } from '../types';

export type AlertKind = 'defaulted' | 'reminder';

export interface AlertRecord {
  kind: AlertKind;
  scheduleId: string;
  /** defaulted: when the defaulted count was last updated. */
  occurredAt?: string;
  /** defaulted: consecutiveDefaultedCount (UI escalation, FR-12). */
  count?: number;
  /** reminder: when the upcoming occurrence runs. */
  nextRunAt?: string;
  content: {
    walletId: string;
    coin: string;
    destinationAddress: string;
    amount: string;
    frequency: string;
    note?: string;
  };
}

function contentOf(schedule: ScheduleRecord): AlertRecord['content'] {
  return {
    walletId: schedule.walletId,
    coin: schedule.coin,
    destinationAddress: schedule.destinationAddress,
    amount: schedule.amount,
    frequency: schedule.frequency,
    ...(schedule.note ? { note: schedule.note } : {}),
  };
}

/**
 * In-app alerts for the current user, derived from active smart transactions:
 * a `defaulted` alert per transaction with `consecutiveDefaultedCount >= 1`
 * and an upcoming-payment `reminder` alert inside the reminder window
 * (`nextRunAt - reminderOffset <= now < nextRunAt`).
 */
export async function listAlerts(userId: string): Promise<AlertRecord[]> {
  const now = Date.now();
  const docs = await ScheduledTransaction.find({ userId, status: 'active' })
    .sort({ nextRunAt: 1 })
    .lean();
  const alerts: AlertRecord[] = [];
  for (const doc of docs) {
    const schedule = toRecord(doc as unknown as InstanceType<typeof ScheduledTransaction>);
    if (schedule.consecutiveDefaultedCount >= 1) {
      alerts.push({
        kind: 'defaulted',
        scheduleId: schedule.id,
        occurredAt: new Date(schedule.updatedAt).toISOString(),
        count: schedule.consecutiveDefaultedCount,
        content: contentOf(schedule),
      });
    }
    if (schedule.nextRunAt) {
      const due = new Date(schedule.nextRunAt).getTime();
      if (now >= due - schedule.reminderOffsetMs && now < due) {
        alerts.push({
          kind: 'reminder',
          scheduleId: schedule.id,
          nextRunAt: new Date(due).toISOString(),
          content: contentOf(schedule),
        });
      }
    }
  }
  return alerts;
}
