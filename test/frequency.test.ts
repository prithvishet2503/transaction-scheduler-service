import { describe, expect, it } from 'vitest';
import { computeNextRun, initialNextRunAt } from '../src/utils/frequency';

describe('computeNextRun', () => {
  it('advances daily by one day in the given zone', () => {
    const from = new Date('2026-09-17T12:00:00Z');
    const next = computeNextRun('daily', from, 'UTC');
    expect(next!.toISOString()).toBe('2026-09-18T12:00:00.000Z');
  });

  it('advances weekly by seven days', () => {
    const from = new Date('2026-09-17T00:00:00Z');
    const next = computeNextRun('weekly', from, 'UTC');
    expect(next!.toISOString()).toBe('2026-09-24T00:00:00.000Z');
  });

  it('clamps monthly month-end (Jan 31 -> Feb 28) [FR-19]', () => {
    const from = new Date('2026-01-31T10:00:00Z');
    const next = computeNextRun('monthly', from, 'UTC');
    // leap year 2028 → Feb 29; 2026 is not a leap year → Feb 28
    expect(next!.getUTCMonth()).toBe(1); // February
    expect(next!.getUTCDate()).toBe(28);
  });

  it('returns null for one_time (schedule completes)', () => {
    const from = new Date('2026-09-17T00:00:00Z');
    expect(computeNextRun('one_time', from, 'UTC')).toBeNull();
  });

  it('handles a non-UTC IANA zone', () => {
    const from = new Date('2026-09-17T12:00:00Z');
    const next = computeNextRun('daily', from, 'America/New_York');
    // 12:00Z = 08:00 EDT; next day also 08:00 EDT
    expect(next!.toISOString()).toBe('2026-09-18T12:00:00.000Z');
  });
});

describe('initialNextRunAt', () => {
  it('defaults to now-based next run when no startAt given', () => {
    const next = initialNextRunAt('daily', undefined, 'UTC');
    expect(next).toBeInstanceOf(Date);
  });
});
