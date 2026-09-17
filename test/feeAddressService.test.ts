import { beforeEach, describe, expect, it, vi } from 'vitest';

const mFind = vi.fn();
const mCreate = vi.fn();
const mFindOneAndUpdate = vi.fn();
vi.mock('../src/models/ScheduledTransaction', () => ({
  ScheduledTransaction: {
    find: (...a: unknown[]) => mFind(...a),
    create: (...a: unknown[]) => mCreate(...a),
    findOne: (...a: unknown[]) => mFindOne(...a),
    findOneAndUpdate: (...a: unknown[]) => mFindOneAndUpdate(...a),
  },
}));
const mFindOne = vi.fn();

const mExecCreate = vi.fn();
const mExecFind = vi.fn();
vi.mock('../src/models/FeeAddressFundingExecution', () => ({
  FeeAddressFundingExecution: {
    create: (...a: unknown[]) => mExecCreate(...a),
    find: (...a: unknown[]) => mExecFind(...a),
  },
}));

const mSendMany = vi.fn();
vi.mock('../src/services/bitgoClient', () => ({
  bitgoClient: { sendMany: (...a: unknown[]) => mSendMany(...a) },
}));

const mNotify = vi.fn();
vi.mock('../src/services/notificationService', () => ({
  notify: (...a: unknown[]) => mNotify(...a),
}));

// eslint-disable-next-line import/first
import { createFunding, getFeeAddressBalance, monitorFeeAddresses } from '../src/services/feeAddressService';

function fakeFunding(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'fund_1' },
    kind: 'fee-address-funding',
    userId: 'u1',
    enterpriseId: 'ent_1',
    coin: 'tbaseeth',
    destinationAddress: '0xfeefee',
    walletId: 'w1',
    conditionType: 'balance',
    conditionOperator: 'below',
    conditionLimit: '500000000000000000',
    amount: '1000000000000000000',
    emailOnDefault: true,
    status: 'active',
    lastBalance: null,
    lastCheckAt: null,
    lastFundedAt: null,
    consecutiveDefaultedCount: 0,
    nextRunAt: null,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockBalanceApi(balance: string) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ balance, address: '0xfeefee' }),
  }) as never;
}

describe('getFeeAddressBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BITGO_ENV = 'test';
    process.env.BITGO_ACCESS_TOKEN = 'tok';
  });

  it('returns balance + address from the BitGo API', async () => {
    mockBalanceApi('1000000000000000000');
    const res = await getFeeAddressBalance('ent_1', 'tbaseeth');
    expect(res).toEqual({ balance: '1000000000000000000', address: '0xfeefee' });
const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v2/tbaseeth/enterprise/ent_1/feeAddressBalance');
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
  });

  it('throws on non-200', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'nope' }) as never;
    await expect(getFeeAddressBalance('ent_1', 'tbaseeth')).rejects.toMatchObject({ status: 502 });
  });
});

describe('createFunding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BITGO_ENV = 'test';
    process.env.BITGO_ACCESS_TOKEN = 'tok';
    mFindOne.mockResolvedValue(null); // no duplicate active funding
    mockBalanceApi('0');
  });

  it('rejects non-positive amounts', async () => {
    await expect(
      createFunding({
        userId: 'u1',
        enterpriseId: 'ent_1',
        coin: 'tbaseeth',
        fromWalletId: 'w1',
        thresholdAmount: '0',
        topUpAmount: '1000',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('resolves the fee address from the API and persists the funding', async () => {
    mCreate.mockResolvedValue(fakeFunding());
    const funding = await createFunding({
      userId: 'u1',
      enterpriseId: 'ent_1',
      coin: 'tbaseeth',
      fromWalletId: 'w1',
      thresholdAmount: '500000000000000000',
      topUpAmount: '1000000000000000000',
    });
    expect(funding.feeAddress).toBe('0xfeefee');
    expect(funding.thresholdAmount).toBe('500000000000000000');
    expect(mCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'fee-address-funding',
        destinationAddress: '0xfeefee',
        walletId: 'w1',
        conditionType: 'balance',
        conditionOperator: 'below',
        conditionLimit: '500000000000000000',
      }),
    );
  });
});

describe('monitorFeeAddresses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.BITGO_ENV = 'test';
    process.env.BITGO_ACCESS_TOKEN = 'tok';
  });

  it('does NOT fund when balance is above the threshold', async () => {
    mFind.mockResolvedValue([fakeFunding()]);
    mockBalanceApi('9000000000000000000');
    const res = await monitorFeeAddresses();
    expect(res.funded).toBe(0);
    expect(mSendMany).not.toHaveBeenCalled();
  });

  it('funds the fee address when balance is below the threshold', async () => {
    mFind.mockResolvedValue([fakeFunding()]);
    mockBalanceApi('100000000000000000');
    mSendMany.mockResolvedValue({ txid: '0xabc' });
    const res = await monitorFeeAddresses();
    expect(res.funded).toBe(1);
    expect(mSendMany).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'w1',
        address: '0xfeefee',
        amount: '1000000000000000000',
      }),
    );
    expect(mExecCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'executed', txid: '0xabc' }));
  });

  it('defaults + emails when the funding wallet has no balance', async () => {
    mFind.mockResolvedValue([fakeFunding()]);
    mockBalanceApi('100000000000000000');
    mSendMany.mockRejectedValue({ code: 'insufficient_funds' });
    const res = await monitorFeeAddresses();
    expect(res.defaulted).toBe(1);
    expect(mExecCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'defaulted', reason: 'INSUFFICIENT_BALANCE' }),
    );
    expect(mNotify).toHaveBeenCalledWith(expect.objectContaining({ type: 'defaulted', reason: 'INSUFFICIENT_BALANCE' }));
  });

  it('batches one balance fetch per (enterpriseId, coin) pair', async () => {
    mFind.mockResolvedValue([fakeFunding(), fakeFunding({ _id: { toString: () => 'fund_2' } })]);
    mockBalanceApi('9000000000000000000');
    await monitorFeeAddresses();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
