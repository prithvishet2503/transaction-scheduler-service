import express from 'express';
import type { Express } from 'express';
import { apiRouter } from './routes';
import { errorHandler } from './middleware/auth';
import { env } from './config/env';
import { logger } from './utils/logger';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use((req, _res, next) => {
    logger.debug({ method: req.method, path: req.path }, 'request');
    next();
  });

  app.use('/api/v1', apiRouter);

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  app.use(errorHandler);

  logger.info({ service: env.serviceName, port: env.port }, 'app initialized');
  return app;
}
