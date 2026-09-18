import type { Request, Response } from 'express';
import { cronTick } from '../workers/cronWorker';
import { reapStuckClaims } from '../workers/reaper';
import { stakingTick } from '../workers/stakingWorker';
import { env } from '../config/env';

/**
 * Manual worker trigger for demo/testing. Runs one claim + execution tick
 * and/or the reaper on demand. Intended for local verification, not prod.
 */
export async function workerTickHandler(req: Request, res: Response) {
  if (env.nodeEnv === 'production') {
    return res.status(403).json({ error: 'disabled in production' });
  }
  const reaped = await reapStuckClaims();
  await cronTick();
  await stakingTick();
  res.json({ ok: true, reaped });
}
