import type { Recipient } from '../types';

export const MAX_RECIPIENTS = 100;

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
  return recipients.reduce((acc, r) => acc + BigInt(r.amount), 0n).toString();
}

/**
 * Recipients for an occurrence. Older documents only have
 * destinationAddress + amount; treat that as a one-element list.
 */
export function recipientsFromSchedule(schedule: {
  recipients?: Recipient[] | null;
  destinationAddress: string;
  amount: string;
}): Recipient[] {
  if (schedule.recipients && schedule.recipients.length > 0) {
    return schedule.recipients.map((r) => ({ address: r.address, amount: r.amount }));
  }
  return [{ address: schedule.destinationAddress, amount: schedule.amount }];
}

/**
 * Normalize create/update input into a validated recipient list.
 * Accepts either `recipients` or the single-address shortcut.
 */
export function normalizeRecipients(input: {
  recipients?: Recipient[];
  destinationAddress?: string;
  amount?: string;
}): Recipient[] {
  const raw =
    input.recipients && input.recipients.length > 0
      ? input.recipients
      : input.destinationAddress
        ? [{ address: input.destinationAddress, amount: input.amount ?? '' }]
        : [];

  if (raw.length === 0) {
    throw new RecipientError('destinationAddress or recipients is required');
  }
  if (raw.length > MAX_RECIPIENTS) {
    throw new RecipientError(`at most ${MAX_RECIPIENTS} recipients are allowed`);
  }

  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const item of raw) {
    const address = typeof item.address === 'string' ? item.address.trim() : '';
    const amount = typeof item.amount === 'string' ? item.amount.trim() : String(item.amount ?? '');
    if (!address) {
      throw new RecipientError('each recipient needs an address');
    }
    let value: bigint;
    try {
      value = BigInt(amount);
    } catch {
      throw new RecipientError('amount must be a positive integer in base units');
    }
    if (value <= 0n) {
      throw new RecipientError('amount must be a positive integer in base units');
    }
    const key = address.toLowerCase();
    if (seen.has(key)) {
      throw new RecipientError('duplicate recipient address');
    }
    seen.add(key);
    out.push({ address, amount });
  }
  return out;
}
