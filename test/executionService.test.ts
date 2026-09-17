import { beforeEach, describe, expect, it, vi } from 'vitest';

const mFindOneAndUpdate = vi.fn();
const mUpdateOne = vi.fn();
vi.mock('../src/models/ScheduleExecution', () => ({
  ScheduleExecution: {
    findOneAndUpdate: (...a: unknown[]) => mFindOneAndUpdate(...a),
    updateOne: (...a: unknown[]) => mUpdateOne(...a),
  },
}));

const mCheckBalance = vi.fn();
const mSendMany = vi.fn();
vi.mock('../src/services/bitgoClient', () => ({
  bitgoClient: {
    checkBalance: (...a: unknown[]) => mCheckBalance(...a),
    sendMany: (...a: unknown[]) => mSendMany(...a),
  },
}));

const mNotify = vi.fn();
vi.mock('../src/services/notificationService', () => ({
  notify: (...a: unknown[]) => mNotify(...a),
}));

// eslint-disable-next-line import/first
import { processDueSchedule } from '../src/services/executionService';

function fakeSchedule() {
  const schedule: Record<string, unknown> = {
    _id: { toString: () => 'sched_1' },
    userId: 'u1',
    walletId: 'w1',
    coin: 'tbaseeth',
    destinationAddress: '0xde709f2102306220921060314715629080e2fb77',
    amount: '100000',
    frequency: 'weekly',
    timezone: 'UTC',
    status: 'active',
    nextRunAt: new Date('2026-09-17T00:00:00Z'),
    endAt: null,
    consecutiveDefaultedCount: 0,
    lastRunAt: null,
    save: vi.fn().mockResolvedValue(undefined),
  };
  return schedule;
}

function executionDoc(id: string, status: string) {
  return {
    _id: { toString: () => id },
    status,
    attempt: 0,
  };
}

describe('processDueSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WORKER_LEASE_TTL_MS = '120000';
    process.env.WORKER_MAX_ATTEMPTS = '3';
    process.env.RETRY_BACKOFF_MS = '60000,300000,1500000';
  });

  it('defaults the occurrence (no tx) when spendable < amount, then advances next run [FR-10/FR-13]', async () => {
    const schedule = fakeSchedule();
    // ensure → returns a scheduled execution; claim → returns claimed execution
    mFindOneAndUpdate
      .mockResolvedValueOnce(executionDoc('exec_1', 'scheduled'))
      .mockResolvedValueOnce(executionDoc('exec_1', 'claimed'));
    // balance: spendable 100 < amount 100000
    mCheckBalance.mockResolvedValue({ spendable: '100', maximumSpendable: '100' });

    await processDueSchedule(schedule as never, 'worker-1');

    // No transaction was initiated.
    expect(mSendMany).not.toHaveBeenCalled();
    // Execution marked defaulted with INSUFFICIENT_BALANCE.
    const updateCall = mUpdateOne.mock.calls[0];
    expect(updateCall[1].$set.status).toBe('defaulted');
    expect(updateCall[1].$set.reason).toBe('INSUFFICIENT_BALANCE');
    // Consecutive default counter incremented; schedule stays active, next run advanced.
    expect(schedule.consecutiveDefaultedCount).toBe(1);
    expect(schedule.status).toBe('active');
    expect((schedule.nextRunAt as Date).toISOString()).toBe('2026-09-24T00:00:00.000Z');
    // Defaulted notification emitted.
    expect(mNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'defaulted', reason: 'INSUFFICIENT_BALANCE' }),
    );
  });

  it('executes via sendMany when balance is sufficient and records txid', async () => {
    const schedule = fakeSchedule();
    mFindOneAndUpdate
      .mockResolvedValueOnce(executionDoc('exec_2', 'scheduled'))
      .mockResolvedValueOnce(executionDoc('exec_2', 'claimed'));
    mCheckBalance.mockResolvedValue({ spendable: '200000', maximumSpendable: '200000' });
    mSendMany.mockResolvedValue({ txid: '0x1234', pendingApprovalId: undefined });

    await processDueSchedule(schedule as never, 'worker-1');

    expect(mSendMany).toHaveBeenCalledTimes(1);
    const sendArgs = mSendMany.mock.calls[0][0];
    expect(sendArgs.amount).toBe('100000');
    const updateCall = mUpdateOne.mock.calls[0];
    expect(updateCall[1].$set.status).toBe('executed');
    expect(updateCall[1].$set.txid).toBe('0x1234');
    // Non-default resets the default counter.
    expect(schedule.consecutiveDefaultedCount).toBe(0);
  });
});
