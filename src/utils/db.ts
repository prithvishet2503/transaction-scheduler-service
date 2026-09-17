import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from './logger';

export async function connectDb(): Promise<void> {
  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'mongodb connection error');
  });
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  logger.info({ uri: env.mongoUri }, 'connected to mongodb');
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
