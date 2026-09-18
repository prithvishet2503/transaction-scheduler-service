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
import {
  cancelStakingEntryHandler,
  createStakingEntryHandler,
  disableStakingByWalletHandler,
  getStakingEntryHandler,
  listStakingEntriesHandler,
  pauseStakingEntryHandler,
  resumeStakingEntryHandler,
  updateStakingEntryHandler,
} from '../controllers/scheduledStakingController';

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
// Scheduled staking CRUD
apiRouter.post('/scheduled-staking', asyncHandler(createStakingEntryHandler));
apiRouter.delete('/scheduled-staking', asyncHandler(disableStakingByWalletHandler));
apiRouter.get('/scheduled-staking', asyncHandler(listStakingEntriesHandler));
apiRouter.get('/scheduled-staking/:id', asyncHandler(getStakingEntryHandler));
apiRouter.patch('/scheduled-staking/:id', asyncHandler(updateStakingEntryHandler));
apiRouter.post('/scheduled-staking/:id/pause', asyncHandler(pauseStakingEntryHandler));
apiRouter.post('/scheduled-staking/:id/resume', asyncHandler(resumeStakingEntryHandler));
apiRouter.delete('/scheduled-staking/:id', asyncHandler(cancelStakingEntryHandler));
