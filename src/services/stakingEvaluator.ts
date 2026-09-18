import type { StakingAction } from '../types';
import { logger } from '../utils/logger';

/**
 * Balance ratio computation and rebalance decision logic.
 *
 * Given spendable balance and auto-staked amount, computes whether the
 * actual ratio has drifted beyond the configured threshold and determines
 * the action (STAKE / UNSTAKE / NONE) and amount needed.
 *
 * Edge cases:
 * - spendableBalance = 0: cannot stake; skip
 * - portfolioValue = 0: no funds at all; skip
 * - liquidBalance < minimumStakeAmount: cannot stake below minimum
 * - liquidBalance < estimatedGasFee: cannot unstake further; skip
 */

export interface EvaluationInput {
  spendableBalance: number; // in base units (decimal for math)
  autoStaked: number;       // sum of AUTO_STAKE delegations in base units
  targetRatio: number;      // e.g. 0.80
  threshold: number;        // e.g. 0.02
  minimumStakeAmount: number; // minimum stakeable amount
  minimumLiquidBalance: number; // minimum liquid to leave for gas
}

export interface EvaluationResult {
  action: StakingAction;
  currentRatio: number;
  targetStaked: number;
  drift: number;
  reason?: string;
}

/**
 * Evaluate whether a rebalance action is needed.
 *
 * Computation follows staking-engine's logic:
 *   liquidBalance = max(spendableBalance - autoStaked, 0)
 *   portfolioValue = autoStaked + liquidBalance
 *   targetStaked = portfolioValue * targetRatio
 *   currentRatio = autoStaked / portfolioValue
 *   drift = |currentRatio - targetRatio|
 *   if drift > threshold → action = STAKE|UNSTAKE with amount = |targetStaked - autoStaked|
 */
export function evaluateRebalance(input: EvaluationInput): EvaluationResult {
  const { spendableBalance, autoStaked, targetRatio, threshold, minimumStakeAmount, minimumLiquidBalance } = input;

  const portfolioValue = autoStaked + Math.max(spendableBalance - autoStaked, 0);

  // No funds at all — skip
  if (portfolioValue <= 0) {
    logger.debug({ spendableBalance, autoStaked }, 'portfolio value is zero; no action');
    return {
      action: { type: 'NONE', amount: '0' },
      currentRatio: 0,
      targetStaked: 0,
      drift: 0,
      reason: 'portfolio value is zero',
    };
  }

  const currentRatio = autoStaked / portfolioValue;
  const targetStaked = Math.round(portfolioValue * targetRatio); // round to avoid floating dust
  const drift = Math.abs(currentRatio - targetRatio);

  // Drift within threshold — no action needed
  if (drift <= threshold) {
    return {
      action: { type: 'NONE', amount: '0' },
      currentRatio,
      targetStaked,
      drift,
      reason: 'drift within threshold',
    };
  }

  const liquidBalance = Math.max(spendableBalance - autoStaked, 0);

  if (autoStaked < targetStaked) {
    // Need to stake more
    const actionAmount = Math.round(targetStaked - autoStaked);

    if (liquidBalance < minimumStakeAmount) {
      return {
        action: { type: 'NONE', amount: '0' },
        currentRatio,
        targetStaked,
        drift,
        reason: `liquid balance (${liquidBalance}) below minimum stake (${minimumStakeAmount})`,
      };
    }

    const stakeAmount = Math.min(actionAmount, liquidBalance);
    return {
      action: { type: 'STAKE', amount: String(stakeAmount) },
      currentRatio,
      targetStaked,
      drift,
    };
  } else {
    // Need to unstake
    const actionAmount = Math.round(autoStaked - targetStaked);

    if (liquidBalance < minimumLiquidBalance) {
      return {
        action: { type: 'NONE', amount: '0' },
        currentRatio,
        targetStaked,
        drift,
        reason: `liquid balance (${liquidBalance}) below minimum liquid (${minimumLiquidBalance})`,
      };
    }

    return {
      action: { type: 'UNSTAKE', amount: String(actionAmount) },
      currentRatio,
      targetStaked,
      drift,
    };
  }
}
