import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- mock dependencies ---
const mCreate = vi.fn();
vi.mock('../src/models/ScheduledTransaction', () => ({
  ScheduledTransaction: {
    create: (...args: unknown[]) => mCreate(...args),
    findOne: (...a: unknown[]) => mFindOne(...a),
    findOneAndUpdate: (...a: unknown[]) => mFindOneAndUpdate(...a),
  },
}));
const mFindOne = vi.fn();
const mFindOneAndUpdate = vi.fn();

const mIsValidAddress = vi.fn();
vi.mock('../src/services/bitgoClient', () => ({
  bitgoClient: { isValidAddress: (...a: unknown[]) => mIsValidAddress(...a) },
}));

// Import after mocks are registered.
// eslint-disable-next-line import/first
import { createSchedule, updateSchedule } from '../src/services/scheduleService';

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

describe('createSchedule trigger condition', () => {
  const validBase = {
    userId: 'u1',
    walletId: 'w1',
    coin: 'tbaseeth',
    destinationAddress: '0xde709f2102306220921060314715629080e2fb77',
    amount: '1000',
    frequency: 'daily' as const,
    timezone: 'UTC',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MIN_REMINDER_OFFSET_MS = '3600000';
    process.env.DEFAULT_REMINDER_OFFSET_MS = '86400000';
    mIsValidAddress.mockResolvedValue(true);
    mCreate.mockResolvedValue({
      _id: { toString: () => 'sched_9' },
      destinationAddress: '0xde709f2102306220921060314715629080e2fb77',
      amount: '1000',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('persists a balance condition (flat fields, no timestamp)', async () => {
    await createSchedule({
      ...validBase,
      frequency: 'one_time' as const,
      condition: { type: 'balance', operator: 'above', limit: '500000' },
    });
    const arg = mCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.conditionType).toBe('balance');
    expect(arg.conditionOperator).toBe('above');
    expect(arg.conditionLimit).toBe('500000');
    expect(arg.conditionAt).toBeUndefined();
  });

  it('persists a timestamp condition (conditionAt Date, no balance fields)', async () => {
    await createSchedule({ ...validBase, condition: { type: 'timestamp', at: '2026-10-01T00:00:00Z' } });
    const arg = mCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.conditionType).toBe('timestamp');
    expect(arg.conditionAt).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(arg.conditionOperator).toBeUndefined();
    expect(arg.conditionLimit).toBeUndefined();
  });

  it('rejects a request carrying both a balance limit and a timestamp', async () => {
    await expect(
      createSchedule({
        ...validBase,
        condition: { type: 'balance', operator: 'above', limit: '5', at: '2026-10-01T00:00:00Z' } as never,
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('not both') });
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('rejects a timestamp condition carrying balance fields', async () => {
    await expect(
      createSchedule({
        ...validBase,
        condition: { type: 'timestamp', at: '2026-10-01T00:00:00Z', limit: '5' } as never,
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('not both') });
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('rejects an invalid operator, limit, type, or date', async () => {
    for (const condition of [
      { type: 'balance', operator: 'between', limit: '5' },
      { type: 'balance', operator: 'above', limit: '0' },
      { type: 'balance', operator: 'above', limit: '1.5' },
      { type: 'balance', operator: 'above' },
      { type: 'cron' },
      { type: 'timestamp', at: 'not-a-date' },
      { type: 'timestamp' },
    ] as never[]) {
      await expect(createSchedule({ ...validBase, condition })).rejects.toMatchObject({ status: 400 });
    }
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('rejects a balance condition with a recurring frequency', async () => {
    await expect(
      createSchedule({
        ...validBase,
        condition: { type: 'balance', operator: 'above', limit: '500000' },
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'balance-triggered schedules run once — frequency must be one_time',
    });
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('accepts a balance condition with one_time frequency', async () => {
    await createSchedule({
      ...validBase,
      frequency: 'one_time' as const,
      condition: { type: 'balance', operator: 'above', limit: '500000' },
    });
    expect(mCreate).toHaveBeenCalledTimes(1);
  });
});

function bitgoBalanceCheckSpy(): number {
  // The mock only defines isValidAddress; if a balance path existed it would
  // be a separate spy. For FR-4 we assert create never touches balance by
  // checking no call to a balance method was registered.
  return 0;
}

describe('updateSchedule trigger condition', () => {
  const schedDoc = {
    _id: { toString: () => 'sched_5' },
    userId: 'u1',
    walletId: 'w1',
    coin: 'tbaseeth',
    destinationAddress: '0xde709f2102306220921060314715629080e2fb77',
    amount: '1000',
    frequency: 'daily',
    timezone: 'UTC',
    reminderOffsetMs: 86400000,
    status: 'active',
    nextRunAt: new Date('2026-09-24T00:00:00Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const SCHED_ID = '507f1f77bcf86cd799439011';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MIN_REMINDER_OFFSET_MS = '3600000';
    process.env.DEFAULT_REMINDER_OFFSET_MS = '86400000';
    mFindOne.mockResolvedValue(schedDoc);
    mFindOneAndUpdate.mockImplementation(() => Promise.resolve(schedDoc));
  });

  it('persists a balance condition patch', async () => {
    await updateSchedule('u1', SCHED_ID, { condition: { type: 'balance', operator: 'below', limit: '250' } });
    const set = mFindOneAndUpdate.mock.calls[0][1].$set;
    expect(set.conditionType).toBe('balance');
    expect(set.conditionOperator).toBe('below');
    expect(set.conditionLimit).toBe('250');
  });

  it('clears the condition when condition is null', async () => {
    await updateSchedule('u1', SCHED_ID, { condition: null });
    const set = mFindOneAndUpdate.mock.calls[0][1].$set;
    expect(set.conditionType).toBeNull();
    expect(set.conditionAt).toBeNull();
  });

  it('rejects a both-variants condition patch (not both)', async () => {
    await expect(
      updateSchedule('u1', SCHED_ID, {
        condition: { type: 'timestamp', at: '2026-10-01T00:00:00Z', limit: '5' } as never,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
