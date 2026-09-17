import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { NotificationType } from '../types';

export interface NotificationPayload {
  type: NotificationType;
  userId: string;
  scheduleId: string;
  executionId?: string;
  walletId: string;
  coin: string;
  destinationAddress?: string;
  amount?: string;
  scheduledFor?: string;
  nextRunAt?: string;
  reason?: string;
  consecutiveDefaultedCount?: number;
  idempotencyKey: string;
}

/**
 * Notification sink for reminder / defaulted / failed events.
 *
 * Per the PRD, the production path is the platform's NCC (Notification
 * Command Center): publishers serialize protobuf events onto Kafka topics
 * that NCC consumes — NCC owns email templates + SendGrid delivery and
 * deduplicates on `userId + idempotencyKey`.
 *
 * For the hackathon demo this service is self-contained:
 *   - default: emit a structured log line (visible in the worker console);
 *   - optional: POST a JSON webhook (`NOTIFY_WEBHOOK_URL`) so you can wire
 *     your own email/Slack/HTTP sink;
 *   - optional: if `KAFKA_BROKERS` is set, publish a JSON event to a Kafka
 *     topic so a real NCC-like consumer can pick it up.
 */

const TOPIC = `${env.kafkaTopicPrefix}-notifications`;

async function publishKafka(payload: NotificationPayload): Promise<void> {
  if (env.kafkaBrokers.length === 0) {
    return;
  }
  // kafkajs is optional; only required when brokers are configured.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Kafka } = require('kafkajs');
  const kafka = new Kafka({
    clientId: env.serviceName,
    brokers: env.kafkaBrokers,
  });
  const producer = kafka.producer();
  await producer.connect();
  await producer.send({
    topic: TOPIC,
    messages: [{ key: payload.idempotencyKey, value: JSON.stringify(payload) }],
  });
  await producer.disconnect();
}

async function publishWebhook(payload: NotificationPayload): Promise<void> {
  if (!env.notifyWebhookUrl) {
    return;
  }
  await fetch(env.notifyWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Send a notification. Always logs; additionally posts to the configured
 * webhook and/or Kafka topic when present. Callers MUST supply an
 * `idempotencyKey` (derived from execution id + type) so downstream
 * consumers can deduplicate (exactly-once reminders per FR-14).
 */
export async function notify(payload: NotificationPayload): Promise<void> {
  logger.info({ payload }, `notification:${payload.type}`);
  const sinks: Promise<void>[] = [];
  if (env.notifyWebhookUrl) {
    sinks.push(publishWebhook(payload).catch((err) => logger.error({ err }, 'webhook notification failed')));
  }
  if (env.kafkaBrokers.length > 0) {
    sinks.push(publishKafka(payload).catch((err) => logger.error({ err }, 'kafka notification failed')));
  }
  await Promise.all(sinks);
}
