import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  name: env.serviceName,
  level: env.nodeEnv === 'production' ? 'info' : 'debug',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});
