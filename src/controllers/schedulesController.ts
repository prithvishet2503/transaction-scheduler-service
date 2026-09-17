import type { Request, Response } from 'express';
import { ScheduleExecution } from '../models/ScheduleExecution';
import {
  createSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  cancelSchedule,
  pauseSchedule,
  resumeSchedule,
} from '../services/scheduleService';
import type { Frequency } from '../types';

function parseFrequency(v: unknown): Frequency | undefined {
  return ['one_time', 'daily', 'weekly', 'monthly'].includes(v as string)
    ? (v as Frequency)
    : undefined;
}

export async function createScheduleHandler(req: Request, res: Response) {
  const body = req.body ?? {};
  const schedule = await createSchedule({
    userId: req.userId!,
    enterpriseId: body.enterpriseId,
    walletId: body.walletId,
    coin: body.coin,
    destinationAddress: body.destinationAddress,
    amount: String(body.amount),
    frequency: parseFrequency(body.frequency) ?? 'one_time',
    startAt: body.startAt,
    endAt: body.endAt,
    timezone: body.timezone ?? 'UTC',
    note: body.note,
    reminderOffsetMs: body.reminderOffsetMs,
  });
  res.status(201).json({ data: schedule });
}

export async function listSchedulesHandler(req: Request, res: Response) {
  const { items, nextCursor } = await listSchedules(req.userId!, {
    status: req.query.status as string | undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    cursor: req.query.cursor as string | undefined,
  });
  res.json({ data: items, nextCursor });
}

export async function getScheduleHandler(req: Request, res: Response) {
  const schedule = await getSchedule(req.userId!, req.params.id);
  res.json({ data: schedule });
}

export async function updateScheduleHandler(req: Request, res: Response) {
  const body = req.body ?? {};
  const schedule = await updateSchedule(req.userId!, req.params.id, {
    destinationAddress: body.destinationAddress,
    amount: body.amount !== undefined ? String(body.amount) : undefined,
    frequency: parseFrequency(body.frequency),
    endAt: body.endAt,
    note: body.note,
    reminderOffsetMs: body.reminderOffsetMs,
  });
  res.json({ data: schedule });
}

export async function pauseScheduleHandler(req: Request, res: Response) {
  res.json({ data: await pauseSchedule(req.userId!, req.params.id) });
}

export async function resumeScheduleHandler(req: Request, res: Response) {
  res.json({ data: await resumeSchedule(req.userId!, req.params.id) });
}

export async function cancelScheduleHandler(req: Request, res: Response) {
  res.json({ data: await cancelSchedule(req.userId!, req.params.id) });
}

export async function listExecutionsHandler(req: Request, res: Response) {
  await getSchedule(req.userId!, req.params.id); // ownership check
  const executions = await ScheduleExecution.find({ scheduleId: req.params.id })
    .sort({ scheduledFor: -1 })
    .limit(100)
    .lean();
  res.json({ data: executions });
}
