import { Types } from 'mongoose';
import { ScheduledTransaction } from '../models/ScheduledTransaction';
import { FeeAddressFundingExecution } from '../models/FeeAddressFundingExecution';
import { bitgoClient } from './bitgoClient';
import { notify } from './notificationService';
import { env } from '../config/env';
import type { FeeAddressFundingRecord } from '../types';
import { logger } from '../utils/logger';

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

export interface FeeAddressBalance {
  balance: string;
  address: string;
}

export class FeeAddressError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** funding doc = ScheduledTransaction with kind 'fee-address-funding'. */
type FundingDoc = InstanceType<typeof ScheduledTransaction>;

function toRecord(doc: FundingDoc) {
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    enterpriseId: doc.enterpriseId,
    coin: doc.coin,
    feeAddress: doc.destinationAddress,
    fromWalletId: doc.walletId,
    thresholdAmount: doc.conditionLimit ?? '',
    topUpAmount: doc.amount,
    emailOnDefault: doc.emailOnDefault ?? true,
    status: doc.status,
    lastBalance: doc.lastBalance ?? null,
    lastCheckAt: doc.lastCheckAt ?? null,
    lastFundedAt: doc.lastFundedAt ?? null,
    consecutiveDefaultedCount: doc.consecutiveDefaultedCount ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
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

/**
 * Create a fee-address funding schedule. Resolves the fee address from the
 * enterprise gas-tank API so the caller never supplies it manually.
 * Stored in the unified scheduledTransactions collection (kind
 * 'fee-address-funding'); execution is monitor-driven, not occurrence-driven.
 */
export async function createFunding(input: CreateFundingInput) {
  if (!input.enterpriseId || !input.coin || !input.fromWalletId) {
    throw new FeeAddressError('enterpriseId, coin and fromWalletId are required', 400);
  }
  if (BigInt(input.thresholdAmount) <= 0n || BigInt(input.topUpAmount) <= 0n) {
    throw new FeeAddressError('thresholdAmount and topUpAmount must be positive (base units)', 400);
  }
  const { address } = await getFeeAddressBalance(input.enterpriseId, input.coin);

  // One active funding per user + coin + fee address.
  const duplicate = await ScheduledTransaction.findOne({
    kind: 'fee-address-funding',
    userId: input.userId,
    coin: input.coin,
    destinationAddress: address,
    status: 'active',
  });
  if (duplicate) {
    throw new FeeAddressError(
      'an active funding already exists for this fee address',
      409,
    );
  }

  const doc = await ScheduledTransaction.create({
    kind: 'fee-address-funding',
    userId: input.userId,
    enterpriseId: input.enterpriseId,
    coin: input.coin,
    walletId: input.fromWalletId,
    destinationAddress: address,
    amount: input.topUpAmount,
    // The funding trigger is a balance condition: fund whenever the fee
    // address balance falls below the threshold. Monitor-driven — the
    // occurrence worker ignores these documents (nextRunAt is null).
    conditionType: 'balance',
    conditionOperator: 'below',
    conditionLimit: input.thresholdAmount,
    frequency: 'one_time',
    nextRunAt: null,
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
  const query: Record<string, unknown> = { kind: 'fee-address-funding', userId };
  if (opts.status) {
    query.status = opts.status;
  }
  const docs = await ScheduledTransaction.find(query as never).sort({ createdAt: -1 }).limit(limit);
  return docs.map(toRecord);
}

export async function getFunding(userId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) {
    throw new FeeAddressError('invalid funding id', 400);
  }
  const doc = await ScheduledTransaction.findOne({ _id: id, userId, kind: 'fee-address-funding' });
  if (!doc) {
    throw new FeeAddressError('funding not found', 404);
  }
  return toRecord(doc);
}

export async function setFundingStatus(userId: string, id: string, status: 'active' | 'paused' | 'cancelled') {
  const doc = await ScheduledTransaction.findOneAndUpdate(
    { _id: id, userId, kind: 'fee-address-funding' },
    { $set: { status } },
    { new: true },
  );
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
  const active = await ScheduledTransaction.find({ kind: 'fee-address-funding', status: 'active' });
  const byPair = new Map<string, FundingDoc[]>();
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

async function evaluateFunding(funding: FundingDoc, balance: string): Promise<'ok' | 'funded' | 'defaulted'> {
  // Track balance reduction for observability.
  if (funding.lastBalance != null && BigInt(balance) < BigInt(funding.lastBalance)) {
    logger.info(
      { fundingId: funding._id.toString(), lastBalance: funding.lastBalance, balance },
      'fee address balance decreased',
    );
  }
  funding.lastBalance = balance;
  funding.lastCheckAt = new Date();
  await funding.save();

  if (BigInt(balance) >= BigInt(funding.conditionLimit ?? '0')) {
    return 'ok';
  }

  // Below threshold → fund from the selected wallet.
  try {
    const result = await bitgoClient.sendMany({
      coin: funding.coin,
      walletId: funding.walletId,
      address: funding.destinationAddress,
      amount: funding.amount,
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
      amount: funding.amount,
      balanceAtCheck: balance,
      txid: result?.txid,
      pendingApprovalId,
    });
    funding.lastFundedAt = new Date();
    await funding.save();
    logger.info({ fundingId: funding._id.toString(), amount: funding.amount }, 'fee address funded');
    return 'funded';
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'insufficient_funds') {
      funding.consecutiveDefaultedCount += 1;
      await funding.save();
      await FeeAddressFundingExecution.create({
        fundingId: funding._id,
        status: 'defaulted',
        amount: funding.amount,
        balanceAtCheck: balance,
        reason: 'INSUFFICIENT_BALANCE',
      });
      if (funding.emailOnDefault) {
        await notify({
          type: 'defaulted',
          userId: funding.userId,
          scheduleId: funding._id.toString(),
          walletId: funding.walletId,
          coin: funding.coin,
          destinationAddress: funding.destinationAddress,
          amount: funding.amount,
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
      amount: funding.amount,
      balanceAtCheck: balance,
      reason: (err as Error)?.message ?? 'UNKNOWN',
    });
    return 'ok';
  }
}
