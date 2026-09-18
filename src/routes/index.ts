import { Router } from 'express';
import { requireApiKey } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import {
  cancelSmartTransactionHandler,
  createSmartTransactionHandler,
  getSmartTransactionHandler,
  listSmartTransactionExecutionsHandler,
  listSmartTransactionsHandler,
  pauseSmartTransactionHandler,
  resumeSmartTransactionHandler,
  updateSmartTransactionHandler,
} from '../controllers/smartTransactionsController';
import { webhookHandler } from '../controllers/webhookController';
import { workerTickHandler } from '../controllers/workerController';
import { listAlertsHandler } from '../controllers/alertsController';

export const apiRouter = Router();

// Public / operational
apiRouter.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
apiRouter.post('/webhooks/bitgo', asyncHandler(webhookHandler));

// Authenticated smart transaction API (demo: static API key)
apiRouter.use(requireApiKey);
apiRouter.get('/me/alerts', asyncHandler(listAlertsHandler));
apiRouter.post('/worker/tick', asyncHandler(workerTickHandler));
apiRouter.post('/smart-transactions', asyncHandler(createSmartTransactionHandler));
apiRouter.get('/smart-transactions', asyncHandler(listSmartTransactionsHandler));
apiRouter.get('/smart-transactions/:id', asyncHandler(getSmartTransactionHandler));
apiRouter.patch('/smart-transactions/:id', asyncHandler(updateSmartTransactionHandler));
apiRouter.post('/smart-transactions/:id/pause', asyncHandler(pauseSmartTransactionHandler));
apiRouter.post('/smart-transactions/:id/resume', asyncHandler(resumeSmartTransactionHandler));
apiRouter.delete('/smart-transactions/:id', asyncHandler(cancelSmartTransactionHandler));
apiRouter.get('/smart-transactions/:id/executions', asyncHandler(listSmartTransactionExecutionsHandler));
