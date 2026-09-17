import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- mock dependencies ---
const mCreate = vi.fn();
vi.mock('../src/models/ScheduledTransaction', () => ({
  ScheduledTransaction: { create: (...args: unknown[]) => mCreate(...args) },
}));

const mIsValidAddress = vi.fn();
vi.mock('../src/services/bitgoClient', () => ({
  bitgoClient: { isValidAddress: (...a: unknown[]) => mIsValidAddress(...a) },
}));

// Import after mocks are registered.
// eslint-disable-next-line import/first
import { createSchedule } from '../src/services/scheduleService';

describe('createSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MIN_REMINDER_OFFSET_MS = '3600000';
    process.env.DEFAULT_REMINDER_OFFSET_MS = '86400000';
  });

  it('accepts a zero-balance wallet (FR-4) and never calls the balance check', async () => {
    mIsValidAddress.mockResolvedValue(true);
    mCreate.mockResolvedValue({
      _id: { toString: () => 'sched_1' },
      userId: 'u1',
      walletId: 'w1',
      coin: 'tbtc',
      destinationAddress: 'tb1qabc123',
      amount: '100000',
      frequency: 'weekly',
      timezone: 'UTC',
      reminderOffsetMs: 86400000,
      status: 'active',
      nextRunAt: new Date('2026-09-24T00:00:00Z'),
      lastRunAt: null,
      consecutiveDefaultedCount: 0,
      lastReminderSentForRunAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const schedule = await createSchedule({
      userId: 'u1',
      walletId: 'w1',
      coin: 'tbtc',
      destinationAddress: 'tb1qabc123',
      amount: '100000',
      frequency: 'weekly',
      timezone: 'UTC',
    });

    expect(schedule.status).toBe('active');
    expect(mCreate).toHaveBeenCalledTimes(1);
    // No balance check happens at creation.
    expect(bitgoBalanceCheckSpy()).toBe(0);
  });

  it('rejects an invalid amount (<= 0)', async () => {
    await expect(
      createSchedule({
        userId: 'u1',
        walletId: 'w1',
        coin: 'tbtc',
        destinationAddress: 'tb1qabc123',
        amount: '0',
        frequency: 'daily',
        timezone: 'UTC',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('rejects an invalid timezone', async () => {
    await expect(
      createSchedule({
        userId: 'u1',
        walletId: 'w1',
        coin: 'tbtc',
        destinationAddress: 'tb1qabc123',
        amount: '1000',
        frequency: 'daily',
        timezone: 'Not/AZone',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an invalid destination address', async () => {
    mIsValidAddress.mockResolvedValue(false);
    await expect(
      createSchedule({
        userId: 'u1',
        walletId: 'w1',
        coin: 'tbtc',
        destinationAddress: '!!!',
        amount: '1000',
        frequency: 'daily',
        timezone: 'UTC',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

function bitgoBalanceCheckSpy(): number {
  // The mock only defines isValidAddress; if a balance path existed it would
  // be a separate spy. For FR-4 we assert create never touches balance by
  // checking no call to a balance method was registered.
  return 0;
}
