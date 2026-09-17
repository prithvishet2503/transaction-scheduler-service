import type { Request, Response } from 'express';
import {
  cancelFunding,
  createFunding,
  getFeeAddressBalance,
  getFunding,
  listFundingExecutions,
  listFundings,
  monitorFeeAddresses,
  pauseFunding,
  resumeFunding,
} from '../services/feeAddressService';
import { env } from '../config/env';

export async function feeAddressBalanceHandler(req: Request, res: Response) {
  const enterpriseId = req.query.enterpriseId as string;
  const coin = req.query.coin as string;
  if (!enterpriseId || !coin) {
    return res.status(400).json({ error: 'enterpriseId and coin are required' });
  }
  const data = await getFeeAddressBalance(enterpriseId, coin);
  res.json({ data });
}

export async function createFundingHandler(req: Request, res: Response) {
  const body = req.body ?? {};
  const funding = await createFunding({
    userId: req.userId!,
    enterpriseId: body.enterpriseId,
    coin: body.coin,
    fromWalletId: body.fromWalletId,
    thresholdAmount: String(body.thresholdAmount),
    topUpAmount: String(body.topUpAmount),
    frequency: body.frequency,
    emailOnDefault: body.emailOnDefault,
  });
  res.status(201).json({ data: funding });
}

export async function listFundingsHandler(req: Request, res: Response) {
  const fundings = await listFundings(req.userId!, {
    status: req.query.status as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json({ data: fundings });
}

export async function getFundingHandler(req: Request, res: Response) {
  res.json({ data: await getFunding(req.userId!, req.params.id) });
}

export async function pauseFundingHandler(req: Request, res: Response) {
  res.json({ data: await pauseFunding(req.userId!, req.params.id) });
}

export async function resumeFundingHandler(req: Request, res: Response) {
  res.json({ data: await resumeFunding(req.userId!, req.params.id) });
}

export async function cancelFundingHandler(req: Request, res: Response) {
  res.json({ data: await cancelFunding(req.userId!, req.params.id) });
}

export async function listFundingExecutionsHandler(req: Request, res: Response) {
  res.json({ data: await listFundingExecutions(req.userId!, req.params.id) });
}

export async function monitorHandler(req: Request, res: Response) {
  if (env.nodeEnv === 'production') {
    return res.status(403).json({ error: 'disabled in production' });
  }
  const result = await monitorFeeAddresses();
  res.json({ ok: true, ...result });
}
