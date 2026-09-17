import { Router } from 'express';
import { requireApiKey } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import {
  cancelScheduleHandler,
  createScheduleHandler,
  getScheduleHandler,
  listExecutionsHandler,
  listSchedulesHandler,
  pauseScheduleHandler,
  resumeScheduleHandler,
  updateScheduleHandler,
} from '../controllers/schedulesController';
import { webhookHandler } from '../controllers/webhookController';
import { workerTickHandler } from '../controllers/workerController';
import { listAlertsHandler } from '../controllers/alertsController';

export const apiRouter = Router();

// Public / operational
apiRouter.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
apiRouter.post('/webhooks/bitgo', asyncHandler(webhookHandler));

// Authenticated schedule API (demo: static API key)
apiRouter.use(requireApiKey);
apiRouter.get('/me/alerts', asyncHandler(listAlertsHandler));
apiRouter.post('/worker/tick', asyncHandler(workerTickHandler));
apiRouter.post('/schedules', asyncHandler(createScheduleHandler));
apiRouter.get('/schedules', asyncHandler(listSchedulesHandler));
apiRouter.get('/schedules/:id', asyncHandler(getScheduleHandler));
apiRouter.patch('/schedules/:id', asyncHandler(updateScheduleHandler));
apiRouter.post('/schedules/:id/pause', asyncHandler(pauseScheduleHandler));
apiRouter.post('/schedules/:id/resume', asyncHandler(resumeScheduleHandler));
apiRouter.delete('/schedules/:id', asyncHandler(cancelScheduleHandler));
apiRouter.get('/schedules/:id/executions', asyncHandler(listExecutionsHandler));
