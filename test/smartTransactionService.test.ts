import { beforeEach, describe, expect, it, vi } from 'vitest';

const mCreate = vi.fn();
const mFindOne = vi.fn();
const mFindOneAndUpdate = vi.fn();
vi.mock('../src/models/ScheduledTransaction', () => ({
  ScheduledTransaction: {
    create: (...args: unknown[]) => mCreate(...args),
    findOne: (...args: unknown[]) => mFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mFindOneAndUpdate(...args),
  },
}));

vi.mock('../src/models/ScheduleExecution', () => ({
  ScheduleExecution: {
    find: vi.fn(),
  },
}));

const mIsValidAddress = vi.fn();
const mResolveWalletIdByAddress = vi.fn();
vi.mock('../src/services/bitgoClient', () => ({
  bitgoClient: {
    isValidAddress: (...args: unknown[]) => mIsValidAddress(...args),
    resolveWalletIdByAddress: (...args: unknown[]) => mResolveWalletIdByAddress(...args),
  },
}));

// eslint-disable-next-line import/first
import { createSmartTransaction, updateSmartTransaction } from '../src/services/smartTransactionService';

function doc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'smart_1' },
    kind: 'smart-transaction',
    userId: 'u1',
    walletId: 'from_wallet',
    coin: 'tbaseeth',
    destinationAddress: '0xde709f2102306220921060314715629080e2fb77',
    amount: '1000',
    recipients: [{ address: '0xde709f2102306220921060314715629080e2fb77', amount: '1000' }],
    frequency: 'one_time',
    repeat: false,
    timezone: 'UTC',
    reminderOffsetMs: 86400000,
    status: 'active',
    nextRunAt: new Date('2026-10-01T00:00:00Z'),
    consecutiveDefaultedCount: 0,
    lastReminderSentForRunAt: null,
    createdAt: new Date('2026-09-17T00:00:00Z'),
    updatedAt: new Date('2026-09-17T00:00:00Z'),
    ...overrides,
  };
}

describe('createSmartTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mIsValidAddress.mockResolvedValue(true);
    mCreate.mockImplementation(async (arg: Record<string, unknown>) => doc(arg));
  });

  it('creates a timestamp smart transaction', async () => {
    const smartTransaction = await createSmartTransaction({
      userId: 'u1',
      fromWalletId: 'from_wallet',
      coin: 'tbaseeth',
      recipient: { address: '0xde709f2102306220921060314715629080e2fb77', amount: '1000' },
      rule: { type: 'timestamp', at: '2026-10-01T00:00:00Z' },
    });

    expect(smartTransaction.kind).toBe('smart-transaction');
    expect(smartTransaction.fromWalletId).toBe('from_wallet');
    expect(smartTransaction.rule).toEqual({ type: 'timestamp', at: new Date('2026-10-01T00:00:00Z') });
    expect(mCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'smart-transaction',
        conditionType: 'timestamp',
        conditionAt: new Date('2026-10-01T00:00:00Z'),
      }),
    );
  });

  it('creates a recipient-balance top-up rule', async () => {
    await createSmartTransaction({
      userId: 'u1',
      enterpriseId: 'enterprise_1',
      fromWalletId: 'cold_wallet',
      coin: 'tbaseeth',
      recipient: { address: '0xde709f2102306220921060314715629080e2fb77', amount: '500' },
      rule: { type: 'balance', monitor: 'recipient', operator: 'below', threshold: '100' },
      repeat: true,
    });

    expect(mCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'cold_wallet',
        conditionType: 'balance',
        conditionMonitor: 'recipient',
        conditionOperator: 'below',
        conditionLimit: '100',
        repeat: true,
      }),
    );
  });

  it('creates a sender sweep rule with leaveBalance and no fixed amount', async () => {
    await createSmartTransaction({
      userId: 'u1',
      fromWalletId: 'hot_wallet',
      coin: 'tbaseeth',
      recipient: { address: '0xde709f2102306220921060314715629080e2fb77' },
      rule: { type: 'balance', monitor: 'sender', operator: 'above', threshold: '150', leaveBalance: '100' },
    });

    expect(mCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: '0',
        conditionMonitor: 'sender',
        conditionOperator: 'above',
        conditionLimit: '150',
        leaveBalance: '100',
      }),
    );
  });

  it('resolves the recipient wallet from the address when no wallet id or enterprise is given', async () => {
    mResolveWalletIdByAddress.mockResolvedValue('resolved_wallet');
    await createSmartTransaction({
      userId: 'u1',
      fromWalletId: 'cold_wallet',
      coin: 'tbaseeth',
      recipient: { address: '0xde709f2102306220921060314715629080e2fb77', amount: '500' },
      rule: { type: 'balance', monitor: 'recipient', operator: 'below', threshold: '100' },
    });

    expect(mResolveWalletIdByAddress).toHaveBeenCalledWith(
      'tbaseeth',
      '0xde709f2102306220921060314715629080e2fb77',
    );
    expect(mCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: [
          expect.objectContaining({ walletId: 'resolved_wallet' }),
        ],
      }),
    );
  });

  it('rejects recipient monitor when the address belongs to no BitGo wallet', async () => {
    mResolveWalletIdByAddress.mockResolvedValue(null);
    await expect(
      createSmartTransaction({
        userId: 'u1',
        fromWalletId: 'cold_wallet',
        coin: 'tbaseeth',
        recipient: { address: '0xde709f2102306220921060314715629080e2fb77', amount: '500' },
        rule: { type: 'balance', monitor: 'recipient', operator: 'below', threshold: '100' },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects multiple recipients', async () => {
    await expect(
      createSmartTransaction({
        userId: 'u1',
        fromWalletId: 'from_wallet',
        coin: 'tbaseeth',
        recipients: [
          { address: '0xde709f2102306220921060314715629080e2fb77', amount: '1000' },
          { address: '0x46bf08a6bbe257a470cefd8e87171d9429e74d2b', amount: '1000' },
        ],
        rule: { type: 'timestamp', at: '2026-10-01T00:00:00Z' },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('updateSmartTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mIsValidAddress.mockResolvedValue(true);
    mFindOne.mockResolvedValue(doc());
    mFindOneAndUpdate.mockResolvedValue(doc({ note: 'updated' }));
  });

  it('updates rule fields', async () => {
    await updateSmartTransaction('u1', '507f1f77bcf86cd799439011', {
      rule: { type: 'balance', monitor: 'sender', operator: 'above', threshold: '500', leaveBalance: '400' },
    });

    expect(mFindOneAndUpdate.mock.calls[0][1].$set).toMatchObject({
      conditionType: 'balance',
      conditionMonitor: 'sender',
      conditionOperator: 'above',
      conditionLimit: '500',
      leaveBalance: '400',
    });
  });
});
