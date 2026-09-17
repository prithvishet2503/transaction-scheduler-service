import { connectDb, disconnectDb } from '../utils/db';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { monitorFeeAddresses } from '../services/feeAddressService';

/**
 * Fee-address (gas tank) monitor worker.
 *
 * Polls active fee-address fundings every `FEE_ADDRESS_POLL_INTERVAL_MS`
 * (default 5 min). The monitor batches balance fetches by (enterpriseId,
 * coin) — one BitGo API call per pair — then funds any fee address whose
 * balance is below its threshold. Balance reduction is tracked per funding
 * (`lastBalance`) for observability.
 */
async function run(): Promise<void> {
  await connectDb();
  logger.info({ pollIntervalMs: env.feeAddressPollIntervalMs }, 'fee-address monitor started');

  const tick = () => {
    monitorFeeAddresses().catch((err) => logger.error({ err }, 'fee-address monitor tick failed'));
  };
  setInterval(tick, env.feeAddressPollIntervalMs);

  const stop = async () => {
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  run().catch((err) => {
    logger.fatal({ err }, 'fee-address monitor failed to start');
    process.exit(1);
  });
}

export { run as runFeeAddressMonitor };
