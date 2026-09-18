import type { Request, Response } from 'express';
import { ScheduledStakingEntry } from '../models/ScheduledStakingEntry';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * CRUD handlers for scheduled-staking entries.
 *
 * Follows the same pattern as schedulesController.ts.
 * All handlers require authentication (apiKey middleware).
 */

/**
 * POST /api/v1/scheduled-staking
 * Create a new scheduled-staking entry.
 */
export async function createStakingEntryHandler(req: Request, res: Response) {
  const body = req.body ?? {};
  const targetRatio = body.targetRatio !== undefined ? Number(body.targetRatio) : 0.8;
  const threshold = body.threshold !== undefined ? Number(body.threshold) : 0.02;

  if (targetRatio < 0 || targetRatio > 1) {
    return res.status(400).json({ error: 'targetRatio must be between 0 and 1' });
  }
  if (threshold < 0 || threshold > 1) {
    return res.status(400).json({ error: 'threshold must be between 0 and 1' });
  }
  if (!body.walletId) {
    return res.status(400).json({ error: 'walletId is required' });
  }
  if (!body.coin) {
    return res.status(400).json({ error: 'coin is required' });
  }

  const entry = await ScheduledStakingEntry.create({
    walletId: body.walletId,
    coin: body.coin,
    enterpriseId: body.enterpriseId ?? '',
    userId: req.userId!,
    targetRatio,
    threshold,
    status: 'active',
    nextPollAt: new Date(), // poll on next worker tick
  });

  logger.info({ entryId: entry._id.toString(), walletId: body.walletId, coin: body.coin },
    'scheduled staking entry created');

  res.status(201).json({ data: entry });
}

/**
 * GET /api/v1/scheduled-staking?walletId=
 * List scheduled-staking entries for the authenticated user,
 * optionally filtered by wallet.
 */
export async function listStakingEntriesHandler(req: Request, res: Response) {
  const query: { userId: string; walletId?: string } = { userId: req.userId! };
  if (req.query.walletId) {
    query.walletId = String(req.query.walletId);
  }
  const entries = await ScheduledStakingEntry.find(query).sort({ createdAt: -1 });
  res.json({ data: entries });
}

/**
 * GET /api/v1/scheduled-staking/:id
 * Get a single scheduled-staking entry.
 */
export async function getStakingEntryHandler(req: Request, res: Response) {
  const entry = await ScheduledStakingEntry.findOne({
    _id: req.params.id,
    userId: req.userId!,
  });
  if (!entry) {
    return res.status(404).json({ error: 'staking entry not found' });
  }
  res.json({ data: entry });
}

/**
 * PATCH /api/v1/scheduled-staking/:id
 * Update a scheduled-staking entry (targetRatio, threshold, status).
 */
export async function updateStakingEntryHandler(req: Request, res: Response) {
  const body = req.body ?? {};
  const update: Record<string, unknown> = {};

  if (body.targetRatio !== undefined) {
    const v = Number(body.targetRatio);
    if (v < 0 || v > 1) {
      return res.status(400).json({ error: 'targetRatio must be between 0 and 1' });
    }
    update.targetRatio = v;
  }
  if (body.threshold !== undefined) {
    const v = Number(body.threshold);
    if (v < 0 || v > 1) {
      return res.status(400).json({ error: 'threshold must be between 0 and 1' });
    }
    update.threshold = v;
  }
  if (body.status !== undefined) {
    if (!['active', 'paused', 'cancelled'].includes(body.status)) {
      return res.status(400).json({ error: 'status must be active, paused, or cancelled' });
    }
    update.status = body.status;
    // Reset nextPollAt when reactivating so the worker picks it up
    if (body.status === 'active') {
      update.nextPollAt = new Date();
    }
  }

  const entry = await ScheduledStakingEntry.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId! },
    { $set: update },
    { new: true },
  );
  if (!entry) {
    return res.status(404).json({ error: 'staking entry not found' });
  }

  logger.info({ entryId: entry._id.toString(), updates: Object.keys(update) },
    'scheduled staking entry updated');

  res.json({ data: entry });
}

/**
 * POST /api/v1/scheduled-staking/:id/pause
 * Pause a scheduled-staking entry.
 */
export async function pauseStakingEntryHandler(req: Request, res: Response) {
  const entry = await ScheduledStakingEntry.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId! },
    { $set: { status: 'paused' } },
    { new: true },
  );
  if (!entry) {
    return res.status(404).json({ error: 'staking entry not found' });
  }
  res.json({ data: entry });
}

/**
 * POST /api/v1/scheduled-staking/:id/resume
 * Resume a paused scheduled-staking entry.
 */
export async function resumeStakingEntryHandler(req: Request, res: Response) {
  const entry = await ScheduledStakingEntry.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId! },
    { $set: { status: 'active', nextPollAt: new Date() } },
    { new: true },
  );
  if (!entry) {
    return res.status(404).json({ error: 'staking entry not found' });
  }
  res.json({ data: entry });
}

/**
 * DELETE /api/v1/scheduled-staking/:id
 * Cancel (soft-delete) a scheduled-staking entry.
 */
export async function cancelStakingEntryHandler(req: Request, res: Response) {
  const entry = await ScheduledStakingEntry.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId! },
    { $set: { status: 'cancelled' } },
    { new: true },
  );
  if (!entry) {
    return res.status(404).json({ error: 'staking entry not found' });
  }
  res.json({ data: entry });
}

/**
 * DELETE /api/v1/scheduled-staking?walletId=
 * Disable scheduled staking for a wallet by hard-deleting all its entries.
 */
export async function disableStakingByWalletHandler(req: Request, res: Response) {
  const walletId = req.query.walletId;
  if (!walletId) {
    return res.status(400).json({ error: 'walletId is required' });
  }
  const result = await ScheduledStakingEntry.deleteMany({ walletId: String(walletId) });
  if (result.deletedCount === 0) {
    return res.status(404).json({ error: 'staking entry not found' });
  }
  logger.info({ walletId, deletedCount: result.deletedCount },
    'scheduled staking disabled for wallet');
  res.json({ data: { walletId, deletedCount: result.deletedCount } });
}
