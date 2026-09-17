import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Demo auth: static API key (hardcoded for the hackathon; no KMS).
 * The caller supplies `x-api-key`. Optionally `x-user-id` selects the
 * owning user (defaults to a fixed demo user) — production would resolve
 * the user from an OAuth scoped session instead (see EXTERNAL-INTEGRATIONS.md).
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header('x-api-key');
  if (key !== env.apiKey) {
    logger.warn({ path: req.path }, 'rejected request: invalid api key');
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.userId = req.header('x-user-id') ?? 'demo-user';
  next();
}

export function errorHandler(err: { status?: number; message: string }, _req: Request, res: Response, _next: NextFunction) {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) {
    logger.error({ err }, 'internal error');
  }
  res.status(status).json({ error: err.message });
}
