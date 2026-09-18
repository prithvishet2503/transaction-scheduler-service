import { bitgoClient } from './bitgoClient';
import { evaluateRebalance } from './stakingEvaluator';
import type { StakingAction } from '../types';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { ScheduledStakingEntry } from '../models/ScheduledStakingEntry';

/**
 * Orchestrates one poll cycle for a scheduled staking entry:
 *   1. Fetch wallet spendable balance from wallet-platform via SDK
 *   2. Fetch auto-staked delegations from BitGo staking API via SDK
 *   3. Evaluate ratio drift
 *   4. If action needed, execute stake/unstake via SDK (toStakingWallet)
 *
 * All staking requests authenticate with BITGO_ACCESS_TOKEN — no separate
 * staking-service API key needed. This matches the STAKING-TDD approach
 * of using wallet.toStakingWallet().stake()/.unstake().
 */

export interface StakingCycleResult {
  action: StakingAction;
  entryId: string;
  walletId: string;
  coin: string;
  spendableBalance: number;
  autoStaked: number;
  currentRatio: number;
  drift: number;
  requestId?: string;
  /** delegation used for UNSTAKE; undefined for STAKE/NONE */
  unstakeDelegationId?: string;
  error?: string;
}

/**
 * Pick which delegation to unstake. Picks the largest
 * AUTO_STAKE delegation that covers the needed amount.
 */
function pickUnstakeDelegation(
  delegations: Array<{ id: string; amount: string; source: string; status: string }>,
  neededAmount: number,
): { id: string; amount: string } | null {
  const auto = delegations
    .filter((d) => d.source === 'AUTO_STAKE' && d.status === 'ACTIVE' && d.id)
    .sort((a, b) => Number(b.amount) - Number(a.amount));

  for (const d of auto) {
    if (Number(d.amount) >= neededAmount) {
      return { id: d.id, amount: d.amount };
    }
  }
  return auto[0] ?? null;
}

/**
 * Run one full poll cycle for a staking entry.
 * Returns the cycle result including any action taken or error encountered.
 */
export async function runStakingCycle(
  entry: InstanceType<typeof ScheduledStakingEntry>,
): Promise<StakingCycleResult> {
  const { walletId, coin, targetRatio, threshold, _id: entryId } = entry;

  try {
    // 1. Fetch wallet info via SDK to get spendable balance
    const wallet = await bitgoClient.getWallet(coin, walletId);
    const spendableBalance = Number(wallet.spendableBalanceString());
    const coinName = wallet.coin;

    // 2. Fetch staking info (delegations) via SDK.
    // Runtime payloads include amount/source beyond the SDK Delegation type.
    const stakingInfo = await bitgoClient.getStakingInfo(coin, walletId);
    const delegations = (stakingInfo.delegations ?? []).map((d) => {
      const raw = d as typeof d & { amount?: string; source?: string; validator?: string };
      return {
        id: raw.id,
        amount: raw.amount ?? String(raw.delegated ?? 0),
        source: raw.source ?? '',
        status: String(raw.status),
        validator: raw.validator ?? '',
      };
    });
    const autoStaked = delegations
      .filter((d: { source: string }) => d.source === 'AUTO_STAKE')
      .reduce((sum: number, d: { amount: string }) => sum + Number(d.amount), 0);

    // 3. Evaluate ratio drift
    const minimumStakeAmount = Number(env.stakingMinimumStakeAmount);
    const result = evaluateRebalance({
      spendableBalance,
      autoStaked,
      targetRatio,
      threshold,
      minimumStakeAmount,
      minimumLiquidBalance: minimumStakeAmount,
    });

    // 4. Execute action if needed
    if (result.action.type === 'NONE') {
      logger.debug({ walletId, currentRatio: result.currentRatio, drift: result.drift, reason: result.reason },
        'no staking action needed');
      return {
        action: result.action,
        entryId: entryId.toString(),
        walletId,
        coin,
        spendableBalance,
        autoStaked,
        currentRatio: result.currentRatio,
        drift: result.drift,
      };
    }

    if (result.action.type === 'STAKE') {
      const sdkResult = await bitgoClient.stake(coin, walletId, result.action.amount);
      logger.info({ walletId, amount: result.action.amount, requestId: sdkResult.id },
        'stake request submitted via SDK');
      return {
        action: result.action,
        entryId: entryId.toString(),
        walletId,
        coin,
        spendableBalance,
        autoStaked,
        currentRatio: result.currentRatio,
        drift: result.drift,
        requestId: sdkResult.id,
      };
    }

    // UNSTAKE — needs delegationId
    const neededAmount = Number(result.action.amount);
    const delegation = pickUnstakeDelegation(delegations, neededAmount);
    if (!delegation) {
      throw new Error('no suitable AUTO_STAKE delegation found for UNSTAKE');
    }

    const sdkResult = await bitgoClient.unstake(coin, walletId, delegation.id);
    logger.info({
      walletId, amount: result.action.amount, delegationId: delegation.id, requestId: sdkResult.id,
    }, 'unstake request submitted via SDK');

    return {
      action: result.action,
      entryId: entryId.toString(),
      walletId,
      coin,
      spendableBalance,
      autoStaked,
      currentRatio: result.currentRatio,
      drift: result.drift,
      requestId: sdkResult.id,
      unstakeDelegationId: delegation.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, walletId, entryId: entryId.toString() }, 'staking cycle failed');
    return {
      action: { type: 'NONE', amount: '0' },
      entryId: entryId.toString(),
      walletId,
      coin,
      spendableBalance: 0,
      autoStaked: 0,
      currentRatio: 0,
      drift: 0,
      error: message,
    };
  }
}

const MAX_CONSECUTIVE_FAILURES = 10;

export async function updateEntryAfterCycle(
  entryId: string,
  result: StakingCycleResult,
  pollIntervalMs: number,
): Promise<void> {
  const baseUpdate: Record<string, unknown> = {
    lastPolledAt: new Date(),
    nextPollAt: new Date(Date.now() + pollIntervalMs),
  };

  if (result.error) {
    const entry = await ScheduledStakingEntry.findOneAndUpdate(
      { _id: entryId },
      { $set: { ...baseUpdate, lastError: result.error }, $inc: { consecutiveFailureCount: 1 } },
      { new: true },
    );
    if (entry && entry.consecutiveFailureCount >= MAX_CONSECUTIVE_FAILURES) {
      await ScheduledStakingEntry.updateOne(
        { _id: entryId },
        { $set: { status: 'paused' } },
      );
      logger.warn({ entryId, failures: entry.consecutiveFailureCount },
        'auto-paused staking entry after repeated failures');
    }
  } else {
    await ScheduledStakingEntry.updateOne(
      { _id: entryId },
      { $set: { ...baseUpdate, consecutiveFailureCount: 0, lastError: null } },
    );
  }
}