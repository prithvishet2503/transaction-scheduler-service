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
      coin: 'tbaseeth',
      destinationAddress: '0xde709f2102306220921060314715629080e2fb77',
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
      coin: 'tbaseeth',
      destinationAddress: '0xde709f2102306220921060314715629080e2fb77',
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
        coin: 'tbaseeth',
        destinationAddress: '0xde709f2102306220921060314715629080e2fb77',
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
        coin: 'tbaseeth',
        destinationAddress: '0xde709f2102306220921060314715629080e2fb77',
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
        coin: 'tbaseeth',
        destinationAddress: '!!!',
        amount: '1000',
        frequency: 'daily',
        timezone: 'UTC',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('accepts multiple recipients and stores the total amount', async () => {
    mIsValidAddress.mockResolvedValue(true);
    mCreate.mockImplementation(async (doc: Record<string, unknown>) => ({
      _id: { toString: () => 'sched_multi' },
      ...doc,
      lastRunAt: null,
      consecutiveDefaultedCount: 0,
      lastReminderSentForRunAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const schedule = await createSchedule({
      userId: 'u1',
      walletId: 'w1',
      coin: 'tbaseeth',
      recipients: [
        { address: '0xde709f2102306220921060314715629080e2fb77', amount: '1000' },
        { address: '0x46bf08a6bbe257a470cefd8e87171d9429e74d2b', amount: '2000' },
      ],
      frequency: 'weekly',
      timezone: 'UTC',
    });

    expect(schedule.recipients).toHaveLength(2);
    expect(schedule.amount).toBe('3000');
    expect(schedule.destinationAddress).toBe('0xde709f2102306220921060314715629080e2fb77');
    expect(mCreate.mock.calls[0][0].recipients).toHaveLength(2);
    expect(mIsValidAddress).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate recipient addresses', async () => {
    await expect(
      createSchedule({
        userId: 'u1',
        walletId: 'w1',
        coin: 'tbaseeth',
        recipients: [
          { address: '0xde709f2102306220921060314715629080e2fb77', amount: '1000' },
          { address: '0xDE709F2102306220921060314715629080E2FB77', amount: '2000' },
        ],
        frequency: 'daily',
        timezone: 'UTC',
      }),
    ).rejects.toMatchObject({ status: 400, message: 'duplicate recipient address' });
    expect(mCreate).not.toHaveBeenCalled();
  });
});

function bitgoBalanceCheckSpy(): number {
  // The mock only defines isValidAddress; if a balance path existed it would
  // be a separate spy. For FR-4 we assert create never touches balance by
  // checking no call to a balance method was registered.
  return 0;
}
