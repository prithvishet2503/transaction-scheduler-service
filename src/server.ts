import { createApp } from './app';
import { connectDb, disconnectDb } from './utils/db';
import { env } from './config/env';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  await connectDb();
  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info({ port: env.port }, 'transaction-scheduler-service listening');
  });

  const stop = async () => {
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start server');
  process.exit(1);
});
