import type { Request, Response } from 'express';
import { ScheduleExecution } from '../models/ScheduleExecution';
import {
  cancelSmartTransaction,
  createSmartTransaction,
  getSmartTransaction,
  listSmartTransactions,
  pauseSmartTransaction,
  resumeSmartTransaction,
  updateSmartTransaction,
} from '../services/smartTransactionService';
import type { SmartTransactionRuleInput } from '../types';

function parseRecipientBody(raw: unknown) {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const row = raw as { address?: unknown; amount?: unknown; walletId?: unknown };
  return {
    address: row.address !== undefined ? String(row.address) : '',
    ...(row.amount !== undefined ? { amount: String(row.amount) } : {}),
    ...(row.walletId !== undefined ? { walletId: String(row.walletId) } : {}),
  };
}

export async function createSmartTransactionHandler(req: Request, res: Response) {
  const body = req.body ?? {};
  const smartTransaction = await createSmartTransaction({
    userId: req.userId!,
    enterpriseId: body.enterpriseId,
    fromWalletId: body.fromWalletId,
    coin: body.coin,
    recipient: parseRecipientBody(body.recipient),
    tokenName: body.tokenName || undefined,
    rule: body.rule as SmartTransactionRuleInput,
    repeat: body.repeat,
    frequency: body.frequency,
    startAt: body.startAt,
    endAt: body.endAt,
    timezone: body.timezone,
    note: body.note,
    reminderOffsetMs: body.reminderOffsetMs,
  });
  res.status(201).json({ data: smartTransaction });
}

export async function listSmartTransactionsHandler(req: Request, res: Response) {
  const { items, nextCursor } = await listSmartTransactions(req.userId!, {
    status: req.query.status as string | undefined,
    walletId: req.query.fromWalletId as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    cursor: req.query.cursor as string | undefined,
  });
  res.json({ data: items, nextCursor });
}

export async function getSmartTransactionHandler(req: Request, res: Response) {
  const smartTransaction = await getSmartTransaction(req.userId!, req.params.id);
  res.json({ data: smartTransaction });
}

export async function updateSmartTransactionHandler(req: Request, res: Response) {
  const body = req.body ?? {};
  const smartTransaction = await updateSmartTransaction(req.userId!, req.params.id, {
    recipient: parseRecipientBody(body.recipient),
    destinationAddress: body.destinationAddress,
    amount: body.amount !== undefined ? String(body.amount) : undefined,
    endAt: body.endAt,
    note: body.note,
    reminderOffsetMs: body.reminderOffsetMs,
    rule: body.rule,
  });
  res.json({ data: smartTransaction });
}

export async function pauseSmartTransactionHandler(req: Request, res: Response) {
  res.json({ data: await pauseSmartTransaction(req.userId!, req.params.id) });
}

export async function resumeSmartTransactionHandler(req: Request, res: Response) {
  res.json({ data: await resumeSmartTransaction(req.userId!, req.params.id) });
}

export async function cancelSmartTransactionHandler(req: Request, res: Response) {
  res.json({ data: await cancelSmartTransaction(req.userId!, req.params.id) });
}

export async function listSmartTransactionExecutionsHandler(req: Request, res: Response) {
  await getSmartTransaction(req.userId!, req.params.id);
  const executions = await ScheduleExecution.find({ scheduleId: req.params.id })
    .sort({ scheduledFor: -1 })
    .limit(100)
    .lean();
  res.json({ data: executions });
}
