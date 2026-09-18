import { beforeEach, describe, expect, it, vi } from 'vitest';

const mFindOneAndUpdate = vi.fn();
const mUpdateOne = vi.fn();
const mFind = vi.fn();
const mExecutionFindOne = vi.fn();
vi.mock('../src/models/ScheduleExecution', () => ({
  ScheduleExecution: {
    findOneAndUpdate: (...args: unknown[]) => mFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mUpdateOne(...args),
    findOne: (...args: unknown[]) => ({ lean: () => mExecutionFindOne(...args) }),
    find: (...args: unknown[]) => ({ limit: () => mFind(...args) }),
  },
}));

const mCheckBalance = vi.fn();
const mCreateTxRequest = vi.fn();
const mFetchLatestTxRequest = vi.fn();
const mGetTransferStatus = vi.fn();
const mGetEnterpriseRecipientBalance = vi.fn();
const mResolveWalletIdByAddress = vi.fn();
vi.mock('../src/services/bitgoClient', () => ({
  bitgoClient: {
    checkBalance: (...args: unknown[]) => mCheckBalance(...args),
    createTxRequest: (...args: unknown[]) => mCreateTxRequest(...args),
    fetchLatestTxRequest: (...args: unknown[]) => mFetchLatestTxRequest(...args),
    getTransferStatus: (...args: unknown[]) => mGetTransferStatus(...args),
    getEnterpriseRecipientBalance: (...args: unknown[]) => mGetEnterpriseRecipientBalance(...args),
    resolveWalletIdByAddress: (...args: unknown[]) => mResolveWalletIdByAddress(...args),
  },
}));

const mNotify = vi.fn();
vi.mock('../src/services/notificationService', () => ({
  notify: (...args: unknown[]) => mNotify(...args),
}));

// eslint-disable-next-line import/first
import {
  pollPendingTxRequests,
  pollTransferConfirmations,
  processDueSchedule,
} from '../src/services/executionService';

function fakeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'smart_1' },
    kind: 'smart-transaction',
    userId: 'u1',
    walletId: 'cold_wallet',
    coin: 'tbaseeth',
    destinationAddress: '0xde709f2102306220921060314715629080e2fb77',
    amount: '100000',
    recipients: [{ address: '0xde709f2102306220921060314715629080e2fb77', amount: '100000' }],
    frequency: 'one_time',
    repeat: false,
    timezone: 'UTC',
    status: 'active',
    nextRunAt: new Date('2026-09-17T00:00:00Z'),
    endAt: null,
    consecutiveDefaultedCount: 0,
    lastRunAt: null,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function executionDoc(id: string, status: string) {
  return {
    _id: { toString: () => id },
    status,
    attempt: 0,
  };
}

function claimExecution(id: string) {
  mFindOneAndUpdate
    .mockResolvedValueOnce(executionDoc(id, 'scheduled'))
    .mockResolvedValueOnce(executionDoc(id, 'claimed'));
}

describe('processDueSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults when sender has insufficient balance and creates no txrequest', async () => {
    const schedule = fakeSchedule();
    claimExecution('exec_1');
    mCheckBalance.mockResolvedValue({ spendable: '100', maximumSpendable: '100' });

    await processDueSchedule(schedule as never, 'worker-1');

    expect(mCreateTxRequest).not.toHaveBeenCalled();
    expect(mUpdateOne.mock.calls[0][1].$set).toMatchObject({
      status: 'defaulted',
      reason: 'INSUFFICIENT_BALANCE',
    });
    expect(schedule.consecutiveDefaultedCount).toBe(1);
    expect(schedule.status).toBe('completed');
    expect(mNotify).toHaveBeenCalledWith(expect.objectContaining({ type: 'defaulted' }));
  });

  it('executes a timestamp smart transaction with a fixed amount', async () => {
    const schedule = fakeSchedule({
      conditionType: 'timestamp',
      conditionAt: new Date('2026-09-01T00:00:00Z'),
      // Must still be inside the promised execution window (scheduledFor + occurrenceDeadlineMs).
      nextRunAt: new Date(Date.now() - 60_000),
    });
    claimExecution('exec_2');
    mCheckBalance.mockResolvedValue({ spendable: '200000', maximumSpendable: '200000' });
    mCreateTxRequest.mockResolvedValue({ txRequestId: 'txr_2', state: 'initialized' });
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_2', state: 'delivered', isCanceled: false, txHashes: ['0x1234'] });

    await processDueSchedule(schedule as never, 'worker-1');

    const intent = mCreateTxRequest.mock.calls[0][1] as { recipients: Array<{ amount: { value: string } }> };
    expect(intent.recipients[0].amount.value).toBe('100000');
    expect(mUpdateOne.mock.calls[0][1].$set).toMatchObject({
      status: 'executed',
      txid: '0x1234',
      txRequestId: 'txr_2',
    });
  });

  it('does not create an execution while a balance rule is unmet', async () => {
    const schedule = fakeSchedule({
      conditionType: 'balance',
      conditionMonitor: 'sender',
      conditionOperator: 'above',
      conditionLimit: '500000',
    });
    mCheckBalance.mockResolvedValue({ spendable: '200000', maximumSpendable: '200000' });

    await processDueSchedule(schedule as never, 'worker-1');

    expect(mFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mCreateTxRequest).not.toHaveBeenCalled();
    expect(schedule.lastBalance).toBe('200000');
  });

  it('tops up a monitored recipient wallet when below threshold', async () => {
    const schedule = fakeSchedule({
      conditionType: 'balance',
      conditionMonitor: 'recipient',
      conditionOperator: 'below',
      conditionLimit: '1000',
      recipients: [{ address: '0xde709f2102306220921060314715629080e2fb77', amount: '500', walletId: 'hot_wallet' }],
      amount: '500',
      repeat: true,
    });
    claimExecution('exec_3');
    mCheckBalance
      .mockResolvedValueOnce({ spendable: '100', maximumSpendable: '100' })
      .mockResolvedValueOnce({ spendable: '5000', maximumSpendable: '5000' });
    mCreateTxRequest.mockResolvedValue({ txRequestId: 'txr_3', state: 'initialized' });
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_3', state: 'delivered', isCanceled: false, txHashes: ['0xabcd'] });

    await processDueSchedule(schedule as never, 'worker-1');

    expect(mCheckBalance.mock.calls[0][1]).toBe('hot_wallet');
    expect(mCheckBalance.mock.calls[1][1]).toBe('cold_wallet');
    const intent = mCreateTxRequest.mock.calls[0][1] as { recipients: Array<{ amount: { value: string } }> };
    expect(intent.recipients[0].amount.value).toBe('500');
  });

  it('sweeps sender balance down to leaveBalance', async () => {
    const schedule = fakeSchedule({
      conditionType: 'balance',
      conditionMonitor: 'sender',
      conditionOperator: 'above',
      conditionLimit: '1500',
      leaveBalance: '1000',
      recipients: [{ address: '0xde709f2102306220921060314715629080e2fb77', amount: '0' }],
      amount: '0',
    });
    claimExecution('exec_4');
    mCheckBalance.mockResolvedValue({ spendable: '2000', maximumSpendable: '2000' });
    mCreateTxRequest.mockResolvedValue({ txRequestId: 'txr_4', state: 'initialized' });
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_4', state: 'delivered', isCanceled: false, txHashes: ['0xbeef'] });

    await processDueSchedule(schedule as never, 'worker-1');

    const intent = mCreateTxRequest.mock.calls[0][1] as { recipients: Array<{ amount: { value: string } }> };
    expect(intent.recipients[0].amount.value).toBe('1000');
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
    expect(mUpdateOne.mock.calls[0][1].$set).toMatchObject({ status: 'executed', txid: '0xdead' });
  });

  it('marks the execution failed when the txrequest is canceled', async () => {
    mFind.mockResolvedValue([inFlightExec('exec_10', 'txr_10', 'pending_approval')]);
    mFetchLatestTxRequest.mockResolvedValue({ txRequestId: 'txr_10', state: 'canceled', isCanceled: true, txHashes: [] });

    await pollPendingTxRequests();

    expect(mUpdateOne.mock.calls[0][1].$set.status).toBe('failed');
  });
});

describe('pollTransferConfirmations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks executed transfer confirmed when BitGo reports confirmed', async () => {
    mFind.mockResolvedValue([
      { _id: { toString: () => 'exec_13' }, walletId: 'w1', coin: 'tbaseeth', txid: '0xconf' },
    ]);
    mGetTransferStatus.mockResolvedValue({ state: 'confirmed', confirmations: 12 });

    await pollTransferConfirmations();

    expect(mUpdateOne.mock.calls[0][1].$set.status).toBe('confirmed');
  });
});
