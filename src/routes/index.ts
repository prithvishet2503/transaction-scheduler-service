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
import {
  cancelFundingHandler,
  createFundingHandler,
  feeAddressBalanceHandler,
  getFundingHandler,
  listFundingExecutionsHandler,
  listFundingsHandler,
  monitorHandler,
  pauseFundingHandler,
  resumeFundingHandler,
} from '../controllers/feeAddressController';

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

// Fee-address (gas tank) auto-funding
apiRouter.get('/fee-address/balance', asyncHandler(feeAddressBalanceHandler));
apiRouter.post('/fee-address/fundings', asyncHandler(createFundingHandler));
apiRouter.get('/fee-address/fundings', asyncHandler(listFundingsHandler));
apiRouter.get('/fee-address/fundings/:id', asyncHandler(getFundingHandler));
apiRouter.post('/fee-address/fundings/:id/pause', asyncHandler(pauseFundingHandler));
apiRouter.post('/fee-address/fundings/:id/resume', asyncHandler(resumeFundingHandler));
apiRouter.delete('/fee-address/fundings/:id', asyncHandler(cancelFundingHandler));
apiRouter.get('/fee-address/fundings/:id/executions', asyncHandler(listFundingExecutionsHandler));
apiRouter.post('/fee-address/monitor', asyncHandler(monitorHandler));
