import type { Request, Response } from 'express';
import { confirmExecution, type TransferWebhook } from '../services/webhookService';
import { env } from '../config/env';

/**
 * BitGo transfer webhook receiver (FR-8): marks an execution `confirmed`
 * when the network confirms the transfer. Signed with `WEBHOOK_SECRET` in
 * `x-bitgo-signature` (demo: constant-time comparison).
 */
export async function webhookHandler(req: Request, res: Response) {
  const sig = req.header('x-bitgo-signature') ?? '';
  const expected = env.webhookSecret;
  const ok =
    sig.length === expected.length &&
    Buffer.from(sig, 'utf8').equals(Buffer.from(expected, 'utf8'));
  if (!ok) {
    return res.status(401).json({ error: 'invalid signature' });
  }
  const { matched, confirmed } = await confirmExecution(req.body as TransferWebhook);
  res.json({ received: true, matched, confirmed });
}
