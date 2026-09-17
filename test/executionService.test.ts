import { beforeEach, describe, expect, it, vi } from 'vitest';

const mFindOneAndUpdate = vi.fn();
const mUpdateOne = vi.fn();
const mFind = vi.fn();
vi.mock('../src/models/ScheduleExecution', () => ({
  ScheduleExecution: {
    findOneAndUpdate: (...a: unknown[]) => mFindOneAndUpdate(...a),
    updateOne: (...a: unknown[]) => mUpdateOne(...a),
    find: (...a: unknown[]) => ({ limit: () => mFind(...a) }),
  },
}));

const mCheckBalance = vi.fn();
const mCreateTxRequest = vi.fn();
const mFetchLatestTxRequest = vi.fn();
vi.mock('../src/services/bitgoClient', () => ({
  bitgoClient: {
    checkBalance: (...a: unknown[]) => mCheckBalance(...a),
    createTxRequest: (...a: unknown[]) => mCreateTxRequest(...a),
    fetchLatestTxRequest: (...a: unknown[]) => mFetchLatestTxRequest(...a),
  },
}));

const mNotify = vi.fn();
vi.mock('../src/services/notificationService', () => ({
  notify: (...a: unknown[]) => mNotify(...a),
}));

// eslint-disable-next-line import/first
import { pollPendingTxRequests, processDueSchedule } from '../src/services/executionService';

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
    process.env.TX_REQUEST_POLL_ATTEMPTS = '0';
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
    expect(mCreateTxRequest).not.toHaveBeenCalled();
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

  it('creates a txrequest, polls it, and records txid when broadcast', async () => {
    const schedule = fakeSchedule();
    mFindOneAndUpdate
      .mockResolvedValueOnce(executionDoc('exec_2', 'scheduled'))
      .mockResolvedValueOnce(executionDoc('exec_2', 'claimed'));
    mCheckBalance.mockResolvedValue({ spendable: '200000', maximumSpendable: '200000' });
    mCreateTxRequest.mockResolvedValue({ txRequestId: 'txr_2', state: 'initialized' });
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_2', state: 'delivered', isCanceled: false, txHashes: ['0x1234'] });

    await processDueSchedule(schedule as never, 'worker-1');

    expect(mCreateTxRequest).toHaveBeenCalledTimes(1);
    const intent = mCreateTxRequest.mock.calls[0][1] as { recipients: Array<{ amount: { value: string } }> };
    expect(intent.recipients[0].amount.value).toBe('100000');
    const updateCall = mUpdateOne.mock.calls[0];
    expect(updateCall[1].$set.status).toBe('executed');
    expect(updateCall[1].$set.txid).toBe('0x1234');
    expect(updateCall[1].$set.txRequestId).toBe('txr_2');
    // Non-default resets the default counter.
    expect(schedule.consecutiveDefaultedCount).toBe(0);
  });
  it('executes when a balance condition is met (spendable above limit)', async () => {
    const schedule = fakeSchedule();
    schedule.conditionType = 'balance';
    schedule.conditionOperator = 'above';
    schedule.conditionLimit = '150000';
    mFindOneAndUpdate
      .mockResolvedValueOnce(executionDoc('exec_3', 'scheduled'))
      .mockResolvedValueOnce(executionDoc('exec_3', 'claimed'));
    mCheckBalance.mockResolvedValue({ spendable: '200000', maximumSpendable: '200000' });
    mCreateTxRequest.mockResolvedValue({ txRequestId: 'txr_3', state: 'initialized' });
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_3', state: 'delivered', isCanceled: false, txHashes: ['0xabcd'] });

    await processDueSchedule(schedule as never, 'worker-1');

    expect(mCreateTxRequest).toHaveBeenCalledTimes(1);
    expect(mUpdateOne.mock.calls[0][1].$set.status).toBe('executed');
  });

  it('defaults with BALANCE_CONDITION_NOT_MET when the balance condition is unmet (no tx)', async () => {
    const schedule = fakeSchedule();
    schedule.conditionType = 'balance';
    schedule.conditionOperator = 'above';
    schedule.conditionLimit = '500000';
    mFindOneAndUpdate
      .mockResolvedValueOnce(executionDoc('exec_4', 'scheduled'))
      .mockResolvedValueOnce(executionDoc('exec_4', 'claimed'));
    mCheckBalance.mockResolvedValue({ spendable: '200000', maximumSpendable: '200000' });

    await processDueSchedule(schedule as never, 'worker-1');

    expect(mCreateTxRequest).not.toHaveBeenCalled();
    const updateCall = mUpdateOne.mock.calls[0];
    expect(updateCall[1].$set.status).toBe('defaulted');
    expect(updateCall[1].$set.reason).toBe('BALANCE_CONDITION_NOT_MET');
    expect(mNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'defaulted', reason: 'BALANCE_CONDITION_NOT_MET' }),
    );
  });

  it('skips the occurrence while a timestamp condition is in the future', async () => {
    const schedule = fakeSchedule();
    schedule.conditionType = 'timestamp';
    schedule.conditionAt = new Date(Date.now() + 3_600_000);

    await processDueSchedule(schedule as never, 'worker-1');

    expect(mFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mCheckBalance).not.toHaveBeenCalled();
    expect(mCreateTxRequest).not.toHaveBeenCalled();
  });

  it('executes once a timestamp condition is in the past', async () => {
    const schedule = fakeSchedule();
    schedule.conditionType = 'timestamp';
    schedule.conditionAt = new Date(Date.now() - 3_600_000);
    mFindOneAndUpdate
      .mockResolvedValueOnce(executionDoc('exec_5', 'scheduled'))
      .mockResolvedValueOnce(executionDoc('exec_5', 'claimed'));
    mCheckBalance.mockResolvedValue({ spendable: '200000', maximumSpendable: '200000' });
    mCreateTxRequest.mockResolvedValue({ txRequestId: 'txr_5', state: 'initialized' });
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_5', state: 'delivered', isCanceled: false, txHashes: ['0x5678'] });

    await processDueSchedule(schedule as never, 'worker-1');

    expect(mCreateTxRequest).toHaveBeenCalledTimes(1);
  });

  it('sends all payees in one txrequest when recipients is set', async () => {
    const schedule = fakeSchedule();
    schedule.recipients = [
      { address: '0xde709f2102306220921060314715629080e2fb77', amount: '100000' },
      { address: '0x46bf08a6bbe257a470cefd8e87171d9429e74d2b', amount: '50000' },
    ];
    schedule.amount = '150000';
    mFindOneAndUpdate
      .mockResolvedValueOnce(executionDoc('exec_6', 'scheduled'))
      .mockResolvedValueOnce(executionDoc('exec_6', 'claimed'));
    mCheckBalance.mockResolvedValue({ spendable: '200000', maximumSpendable: '200000' });
    mCreateTxRequest.mockResolvedValue({ txRequestId: 'txr_6', state: 'initialized' });
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_6', state: 'delivered', isCanceled: false, txHashes: ['0xbeef'] });

    await processDueSchedule(schedule as never, 'worker-1');

    expect(mCreateTxRequest).toHaveBeenCalledTimes(1);
    const intent = mCreateTxRequest.mock.calls[0][1] as { recipients: Array<{ amount: { value: string } }> };
    expect(intent.recipients).toHaveLength(2);
    expect(intent.recipients.map((r) => r.amount.value)).toEqual(['100000', '50000']);
    expect(mUpdateOne.mock.calls[0][1].$set.status).toBe('executed');
  });
});

describe('pollPendingTxRequests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function inFlightExec(id: string, txRequestId: string, status: string) {
    return {
      _id: { toString: () => id },
      walletId: 'w1',
      txRequestId,
      status,
    };
  }

  it('marks the execution executed when the txrequest has a txhash', async () => {
    mFind.mockResolvedValue([inFlightExec('exec_9', 'txr_9', 'pending_approval')]);
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_9', state: 'delivered', isCanceled: false, txHashes: ['0xdead'] });

    await pollPendingTxRequests();

    expect(mFetchLatestTxRequest).toHaveBeenCalledWith('w1', 'txr_9');
    const call = mUpdateOne.mock.calls[0];
    expect(call[1].$set.status).toBe('executed');
    expect(call[1].$set.txid).toBe('0xdead');
  });

  it('marks the execution failed when the txrequest is canceled', async () => {
    mFind.mockResolvedValue([inFlightExec('exec_10', 'txr_10', 'pending_approval')]);
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_10', state: 'canceled', isCanceled: true, txHashes: [] });

    await pollPendingTxRequests();

    expect(mUpdateOne.mock.calls[0][1].$set.status).toBe('failed');
  });

  it('records the fetch while the txrequest is still in flight', async () => {
    mFind.mockResolvedValue([inFlightExec('exec_11', 'txr_11', 'pending_approval')]);
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_11', state: 'pendingDelivery', isCanceled: false, txHashes: [] });

    await pollPendingTxRequests();

    const call = mUpdateOne.mock.calls[0];
    expect(call[1].$set.status).toBeUndefined();
    expect(call[1].$set.txRequestLastPolledAt).toBeInstanceOf(Date);
  });

  it('skips the fetch when the refresh interval has not elapsed', async () => {
    // env is read at module load — reset modules so the new value is picked up.
    vi.resetModules();
    process.env.TX_REQUEST_STATUS_REFRESH_MS = '60000';
    try {
      const { pollPendingTxRequests: poll } = await import('../src/services/executionService');
      mFind.mockResolvedValue([
        { ...inFlightExec('exec_12', 'txr_12', 'pending_approval'), txRequestLastPolledAt: new Date() },
      ]);

      await poll();

      expect(mFetchLatestTxRequest).not.toHaveBeenCalled();
      expect(mUpdateOne).not.toHaveBeenCalled();
    } finally {
      delete process.env.TX_REQUEST_STATUS_REFRESH_MS;
    }
  });
});
