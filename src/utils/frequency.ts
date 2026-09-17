import { DateTime } from 'luxon';
import type { Frequency } from '../types';

/**
 * Compute the next run time for a schedule, in the schedule's IANA timezone.
 * - daily/weekly: luxon `.plus`
 * - monthly: luxon clamps month-end overflow automatically (Jan 31 → Feb 28) [FR-19]
 * - one_time: no next run (schedule completes after the single execution)
 */
export function computeNextRun(
  frequency: Frequency,
  from: Date,
  timezone: string,
): Date | null {
  if (frequency === 'one_time') {
    return null;
  }
  const zoned = DateTime.fromJSDate(from, { zone: timezone });
  let next: DateTime;
  switch (frequency) {
    case 'daily':
      next = zoned.plus({ days: 1 });
      break;
    case 'weekly':
      next = zoned.plus({ weeks: 1 });
      break;
    case 'monthly':
      next = zoned.plus({ months: 1 });
      break;
    default:
      next = zoned.plus({ days: 1 });
  }
  if (!next.isValid) {
    // fall back to naive arithmetic if the zone is invalid
    return new Date(from.getTime() + 24 * 60 * 60 * 1000);
  }
  return next.toJSDate();
}

/**
 * Initial nextRunAt: the first occurrence runs AT the start instant
 * (LLD §3.1 — a new schedule's nextRunAt equals its startDate). Subsequent
 * occurrences advance via computeNextRun after each execution resolves;
 * one_time completes there (computeNextRun → null → status 'completed').
 */
export function initialNextRunAt(
  frequency: Frequency,
  startAt: Date | undefined,
  timezone: string,
): Date | null {
  void frequency;
  void timezone;
  return startAt ?? new Date();
}

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}
