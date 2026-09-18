import type { Recipient } from '../types';

export const MAX_RECIPIENTS = 1;

export class RecipientError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
  }
}

/** Sum recipient amounts in base units (string, no Number). */
export function sumAmounts(recipients: Recipient[]): string {
  return recipients.reduce((acc, r) => acc + BigInt(r.amount ?? '0'), 0n).toString();
}

/** Stored smart transactions have exactly one recipient. */
export function recipientsFromSchedule(schedule: {
  recipients?: Recipient[] | null;
  destinationAddress: string;
  amount: string;
}): Recipient[] {
  if (schedule.recipients && schedule.recipients.length > 0) {
    return schedule.recipients.map((r) => ({
      address: r.address,
      amount: r.amount,
      walletId: r.walletId,
    }));
  }
  return [{ address: schedule.destinationAddress, amount: schedule.amount }];
}

/** Normalize the unified API's single-recipient shape. */
export function normalizeRecipient(input: {
  recipient?: Recipient;
  recipients?: Recipient[];
  destinationAddress?: string;
  amount?: string;
}): Recipient {
  const raw = input.recipient
    ?? (input.recipients && input.recipients.length > 0 ? input.recipients[0] : undefined)
    ?? (input.destinationAddress ? { address: input.destinationAddress, amount: input.amount } : undefined);

  if (!raw) {
    throw new RecipientError('recipient is required');
  }
  if (input.recipients && input.recipients.length > MAX_RECIPIENTS) {
    throw new RecipientError('smart transactions support exactly one recipient');
  }

  const address = typeof raw.address === 'string' ? raw.address.trim() : '';
  if (!address) {
    throw new RecipientError('recipient.address is required');
  }
  const amount = raw.amount === undefined || raw.amount === null ? undefined : String(raw.amount).trim();
  if (amount !== undefined) {
    let value: bigint;
    try {
      value = BigInt(amount);
    } catch {
      throw new RecipientError('recipient.amount must be a positive integer in base units');
    }
    if (value <= 0n) {
      throw new RecipientError('recipient.amount must be a positive integer in base units');
    }
  }

  return {
    address,
    ...(amount !== undefined ? { amount } : {}),
    ...(raw.walletId ? { walletId: String(raw.walletId) } : {}),
  };
}
