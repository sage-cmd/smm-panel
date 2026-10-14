import { Worker } from "bullmq";
import { ISMMProvider } from "../modules/provider/provider.interface";
import { defaultProvider } from "../modules/provider/mockProvider";
import { createOrderFulfillmentWorker } from "./workers/fulfillment.worker";
import { createDripFeedWorker } from "./workers/dripfeed.worker";
import { createWebhookDeliveryWorker } from "./workers/webhook.worker";
import { startOutboxPoller, stopOutboxPoller } from "./outboxPoller";
import { closeQueues } from "./queues";
import { logger } from "../lib/logger";

export interface RunningWorkers {
  fulfillmentWorker: Worker;
  dripFeedWorker: Worker;
  webhookWorker: Worker;
}

let activeWorkers: RunningWorkers | null = null;

export function startWorkers(provider: ISMMProvider = defaultProvider): RunningWorkers {
  if (activeWorkers) {
    return activeWorkers;
  }

  logger.info("Starting background BullMQ workers and outbox poller...");
  const fulfillmentWorker = createOrderFulfillmentWorker(provider);
  const dripFeedWorker = createDripFeedWorker(provider);
  const webhookWorker = createWebhookDeliveryWorker();

  startOutboxPoller();

  activeWorkers = {
    fulfillmentWorker,
    dripFeedWorker,
    webhookWorker,
  };

  logger.info("✓ Background workers successfully started");
  return activeWorkers;
}

export async function stopWorkers(): Promise<void> {
  if (!activeWorkers) {
    return;
  }

  logger.info("Stopping background workers and closing queue connections...");
  stopOutboxPoller();

  await Promise.all([
    activeWorkers.fulfillmentWorker.close(),
    activeWorkers.dripFeedWorker.close(),
    activeWorkers.webhookWorker.close(),
  ]);

  await closeQueues();
  activeWorkers = null;
  logger.info("✓ All background workers and queues successfully closed");
}

export * from "./queues";
export * from "./events";
export * from "./webhookSignature";
export * from "./workers/fulfillment.worker";
export * from "./workers/dripfeed.worker";
export * from "./workers/webhook.worker";
export * from "./outboxPoller";
