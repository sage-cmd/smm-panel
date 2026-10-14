import { Queue, QueueOptions } from "bullmq";
import { redisOptions } from "../lib/redis";

export const QUEUE_NAMES = {
  ORDER_FULFILLMENT: "order-fulfillment",
  DRIP_FEED: "drip-feed-scheduler",
  WEBHOOK_DELIVERY: "webhook-delivery",
} as const;

const defaultQueueOptions: QueueOptions = {
  connection: redisOptions,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
};

export interface OrderFulfillmentJobData {
  orderId: number;
}

export interface DripFeedJobData {
  orderId: number;
  batchNumber: number;
}

export interface WebhookDeliveryJobData {
  webhookId: string;
  userId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  secret?: string | null;
}

export const orderFulfillmentQueue = new Queue<OrderFulfillmentJobData>(
  QUEUE_NAMES.ORDER_FULFILLMENT,
  defaultQueueOptions,
);

export const dripFeedQueue = new Queue<DripFeedJobData>(QUEUE_NAMES.DRIP_FEED, defaultQueueOptions);

export const webhookDeliveryQueue = new Queue<WebhookDeliveryJobData>(
  QUEUE_NAMES.WEBHOOK_DELIVERY,
  defaultQueueOptions,
);

/**
 * Enqueue order fulfillment job
 */
export async function enqueueOrderFulfillment(orderId: number): Promise<void> {
  await orderFulfillmentQueue.add(
    "fulfill",
    { orderId },
    {
      jobId: `fulfill_${orderId}`, // Deduplication by orderId
    },
  );
}

/**
 * Enqueue scheduled drip feed batch with delay in milliseconds
 */
export async function enqueueDripFeedBatch(
  orderId: number,
  batchNumber: number,
  delayMs: number,
): Promise<void> {
  await dripFeedQueue.add(
    "execute-batch",
    { orderId, batchNumber },
    {
      jobId: `drip_${orderId}_batch_${batchNumber}`, // Deduplication per batch
      delay: Math.max(0, delayMs),
    },
  );
}

/**
 * Cleanly close all BullMQ queue connections
 */
export async function closeQueues(): Promise<void> {
  await Promise.all([
    orderFulfillmentQueue.close(),
    dripFeedQueue.close(),
    webhookDeliveryQueue.close(),
  ]);
}
