import { Types } from 'mongoose';
import { FeeAddressFunding, type FeeAddressFundingDoc } from '../models/FeeAddressFunding';
import { FeeAddressFundingExecution } from '../models/FeeAddressFundingExecution';
import { bitgoClient } from './bitgoClient';
import { notify } from './notificationService';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export class FeeAddressError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface FeeAddressBalance {
  balance: string; // base units
  address: string;
}

/** BitGo API base URL for the configured env (test → app.bitgo-test.com). */
export function bitgoApiBaseUrl(): string {
  return env.bitgoEnv === 'prod' ? 'https://app.bitgo.com' : 'https://app.bitgo-test.com';
}

/**
 * GET /api/v2/{coin}/enterprise/{enterpriseId}/feeAddressBalance
 * Returns the enterprise gas-tank (fee) address and its balance.
 */
export async function getFeeAddressBalance(enterpriseId: string, coin: string): Promise<FeeAddressBalance> {
  const url = `${bitgoApiBaseUrl()}/api/v2/${coin}/enterprise/${enterpriseId}/feeAddressBalance`;
  const res = await fetch(url, {
    headers: {
    accept: 'application/json',
    authorization: `Bearer ${env.bitgoTestAccessToken}`,
  },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new FeeAddressError(`fee address balance failed: ${res.status} ${body.slice(0, 200)}`, 502);
  }
  const data = (await res.json()) as { balance?: string | number; address?: string };
  if (
    (typeof data.balance !== 'string' && typeof data.balance !== 'number') ||
    typeof data.address !== 'string'
  ) {
    throw new FeeAddressError('fee address balance response malformed', 502);
  }
  // BitGo may return balance as a JSON number for some coins; normalize to string.
  return { balance: String(data.balance), address: data.address };
}

export interface CreateFundingInput {
  userId: string;
  enterpriseId: string;
  coin: string;
  fromWalletId: string;
  thresholdAmount: string;
  topUpAmount: string;
  emailOnDefault?: boolean;
}

function toRecord(doc: InstanceType<typeof FeeAddressFunding>) {
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    enterpriseId: doc.enterpriseId,
    coin: doc.coin,
    feeAddress: doc.feeAddress,
    fromWalletId: doc.fromWalletId,
    thresholdAmount: doc.thresholdAmount,
    topUpAmount: doc.topUpAmount,
    emailOnDefault: doc.emailOnDefault,
    status: doc.status,
    lastBalance: doc.lastBalance,
    lastCheckAt: doc.lastCheckAt,
    lastFundedAt: doc.lastFundedAt,
    consecutiveDefaultedCount: doc.consecutiveDefaultedCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Create a fee-address funding schedule. Resolves the fee address from the
 * enterprise gas-tank API so the caller never supplies it manually.
 */
export async function createFunding(input: CreateFundingInput) {
  if (!input.enterpriseId || !input.coin || !input.fromWalletId) {
    throw new FeeAddressError('enterpriseId, coin and fromWalletId are required', 400);
  }
  if (BigInt(input.thresholdAmount) <= 0n || BigInt(input.topUpAmount) <= 0n) {
    throw new FeeAddressError('thresholdAmount and topUpAmount must be positive (base units)', 400);
  }
  const { address } = await getFeeAddressBalance(input.enterpriseId, input.coin);
  const doc = await FeeAddressFunding.create({
    userId: input.userId,
    enterpriseId: input.enterpriseId,
    coin: input.coin,
    feeAddress: address,
    fromWalletId: input.fromWalletId,
    thresholdAmount: input.thresholdAmount,
    topUpAmount: input.topUpAmount,
    emailOnDefault: input.emailOnDefault ?? true,
    status: 'active',
    lastBalance: null,
    lastCheckAt: null,
    lastFundedAt: null,
    consecutiveDefaultedCount: 0,
  });
  logger.info(
    { fundingId: doc._id.toString(), enterpriseId: input.enterpriseId, coin: input.coin, feeAddress: address },
    'fee-address funding created',
  );
  return toRecord(doc);
}

export async function listFundings(userId: string, opts: { status?: string; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const query: Record<string, unknown> = { userId };
  if (opts.status) {
    query.status = opts.status;
  }
  const docs = await FeeAddressFunding.find(query as never).sort({ createdAt: -1 }).limit(limit);
  return docs.map(toRecord);
}

export async function getFunding(userId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) {
    throw new FeeAddressError('invalid funding id', 400);
  }
  const doc = await FeeAddressFunding.findOne({ _id: id, userId });
  if (!doc) {
    throw new FeeAddressError('funding not found', 404);
  }
  return toRecord(doc);
}

export async function setFundingStatus(userId: string, id: string, status: FeeAddressFundingDoc['status']) {
  const doc = await FeeAddressFunding.findOneAndUpdate({ _id: id, userId }, { $set: { status } }, { new: true });
  if (!doc) {
    throw new FeeAddressError('funding not found', 404);
  }
  return toRecord(doc);
}

export const pauseFunding = (userId: string, id: string) => setFundingStatus(userId, id, 'paused');
export const resumeFunding = (userId: string, id: string) => setFundingStatus(userId, id, 'active');
export const cancelFunding = (userId: string, id: string) => setFundingStatus(userId, id, 'cancelled');

export async function listFundingExecutions(userId: string, fundingId: string) {
  await getFunding(userId, fundingId); // ownership check
  return FeeAddressFundingExecution.find({ fundingId }).sort({ createdAt: -1 }).limit(100).lean();
}

/**
 * Monitor pass: for every active funding, batch balance fetches by
 * (enterpriseId, coin) — one API call per pair — then fund any fee address
 * whose balance is below its threshold.
 */
export async function monitorFeeAddresses(): Promise<{ checked: number; funded: number; defaulted: number }> {
  const active = await FeeAddressFunding.find({ status: 'active' });
  const byPair = new Map<string, Array<InstanceType<typeof FeeAddressFunding>>>();
  for (const f of active) {
    const key = `${f.enterpriseId}:${f.coin}`;
    const arr = byPair.get(key) ?? [];
    arr.push(f);
    byPair.set(key, arr);
  }

  let funded = 0;
  let defaulted = 0;
  for (const [key, fundings] of byPair) {
    const [enterpriseId, coin] = key.split(':');
    let balance: string;
    try {
      balance = (await getFeeAddressBalance(enterpriseId, coin)).balance;
    } catch (err) {
      logger.error({ err, enterpriseId, coin }, 'fee address balance fetch failed');
      continue;
    }
    for (const funding of fundings) {
      const outcome = await evaluateFunding(funding, balance);
      if (outcome === 'funded') funded += 1;
      if (outcome === 'defaulted') defaulted += 1;
    }
  }
  logger.info({ checked: active.length, funded, defaulted }, 'fee-address monitor pass complete');
  return { checked: active.length, funded, defaulted };
}

async function evaluateFunding(funding: InstanceType<typeof FeeAddressFunding>, balance: string): Promise<'ok' | 'funded' | 'defaulted'> {
  // Track balance reduction for observability.
  if (funding.lastBalance !== null && BigInt(balance) < BigInt(funding.lastBalance)) {
    logger.info(
      { fundingId: funding._id.toString(), lastBalance: funding.lastBalance, balance },
      'fee address balance decreased',
    );
  }
  funding.lastBalance = balance;
  funding.lastCheckAt = new Date();
  await funding.save();

  if (BigInt(balance) >= BigInt(funding.thresholdAmount)) {
    return 'ok';
  }

  // Below threshold → fund from the selected wallet.
  try {
    const result = await bitgoClient.sendMany({
      coin: funding.coin,
      walletId: funding.fromWalletId,
      address: funding.feeAddress,
      amount: funding.topUpAmount,
      sequenceId: `fee-fund:${funding._id.toString()}:${Date.now()}`,
      comment: `fee-address top-up:${funding._id.toString()}`,
    });
    const pendingApprovalId =
      typeof result?.pendingApprovalId === 'string'
        ? result.pendingApprovalId
        : (result?.pendingApproval as { id?: string } | undefined)?.id;
    await FeeAddressFundingExecution.create({
      fundingId: funding._id,
      status: pendingApprovalId ? 'pending_approval' : 'executed',
      amount: funding.topUpAmount,
      balanceAtCheck: balance,
      txid: result?.txid,
      pendingApprovalId,
    });
    funding.lastFundedAt = new Date();
    funding.consecutiveDefaultedCount = 0;
    await funding.save();
    logger.info({ fundingId: funding._id.toString(), amount: funding.topUpAmount }, 'fee address funded');
    return 'funded';
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'insufficient_funds') {
      funding.consecutiveDefaultedCount += 1;
      await funding.save();
      await FeeAddressFundingExecution.create({
        fundingId: funding._id,
        status: 'defaulted',
        amount: funding.topUpAmount,
        balanceAtCheck: balance,
        reason: 'INSUFFICIENT_BALANCE',
      });
      if (funding.emailOnDefault) {
        await notify({
          type: 'defaulted',
          userId: funding.userId,
          scheduleId: funding._id.toString(),
          walletId: funding.fromWalletId,
          coin: funding.coin,
          destinationAddress: funding.feeAddress,
          amount: funding.topUpAmount,
          reason: 'INSUFFICIENT_BALANCE',
          idempotencyKey: `fee-fund:${funding._id.toString()}:${Date.now()}:defaulted`,
        });
      }
      logger.warn({ fundingId: funding._id.toString() }, 'fee address funding defaulted (insufficient balance)');
      return 'defaulted';
    }
    logger.error({ err, fundingId: funding._id.toString() }, 'fee address funding failed');
    await FeeAddressFundingExecution.create({
      fundingId: funding._id,
      status: 'failed',
      amount: funding.topUpAmount,
      balanceAtCheck: balance,
      reason: (err as Error)?.message ?? 'UNKNOWN',
    });
    return 'ok';
  }
}
