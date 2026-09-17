import { ScheduleExecution } from '../models/ScheduleExecution';
import { logger } from '../utils/logger';

export interface TransferWebhook {
  type?: string;
  // BitGo transfer object; includes the txid and, when present, the
  // sequenceId we passed at send time (FR-6) — used to match the execution.
  transfer?: {
    id?: string;
    txid?: string;
    sequenceId?: string;
    state?: string;
  };
}

/**
 * Handle a BitGo transfer-confirmed webhook (FR-8). The execution becomes
 * `confirmed` only once the network has confirmed the transfer; before that
 * it stays `executed` (async settlement via SendQueue → Kafka → coin infra).
 */
export async function confirmExecution(payload: TransferWebhook): Promise<{ matched: number; confirmed: number }> {
  const txid = payload.transfer?.txid;
  const sequenceId = payload.transfer?.sequenceId;
  if (!txid && !sequenceId) {
    return { matched: 0, confirmed: 0 };
  }

  const query = txid ? { txid } : { sequenceId };
  const executions = await ScheduleExecution.find(query as never).exec();
  if (executions.length === 0) {
    logger.warn({ txid, sequenceId }, 'webhook matched no execution');
    return { matched: 0, confirmed: 0 };
  }

  let confirmed = 0;
  for (const exec of executions) {
    if (exec.status === 'executed' || exec.status === 'pending_approval') {
      exec.status = 'confirmed';
      await exec.save();
      confirmed += 1;
    }
  }
  logger.info({ txid, sequenceId, confirmed }, 'executions confirmed via webhook');
  return { matched: executions.length, confirmed };
}
