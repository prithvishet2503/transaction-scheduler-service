import type { Request, Response } from 'express';
import { listAlerts } from '../services/alertsService';

/** GET /api/v1/me/alerts — defaulted/reminder alerts for the current user. */
export async function listAlertsHandler(req: Request, res: Response) {
  res.json({ data: await listAlerts(req.userId!) });
}
