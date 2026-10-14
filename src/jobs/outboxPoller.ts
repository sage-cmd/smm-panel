import { prisma } from "../lib/prisma";
import { enqueueOrderFulfillment, enqueueDripFeedBatch } from "./queues";
import { logger } from "../lib/logger";

let pollerInterval: NodeJS.Timeout | null = null;

/**
 * Polls the database for stuck or pending outbox records and overdue drip-feed batches,
 * ensuring high availability and crash resilience.
 */
export async function pollOutboxJobs(): Promise<void> {
  try {
    // 1. Recover orphan regular fulfillment jobs (pending for > 10 seconds)
    const tenSecondsAgo = new Date(Date.now() - 10000);
    const orphanFulfillmentJobs = await prisma.fulfillmentJob.findMany({
      where: {
        status: "PENDING",
        createdAt: { lte: tenSecondsAgo },
        attempts: { lt: 5 },
      },
      include: { order: true },
      take: 50,
    });

    for (const job of orphanFulfillmentJobs) {
      if (!job.order.runs || job.order.runs <= 1) {
        await enqueueOrderFulfillment(job.orderId);
      }
    }

    // 2. Recover overdue pending drip-feed batches
    const overdueDripBatches = await prisma.dripFeedBatch.findMany({
      where: {
        status: "PENDING",
        scheduledAt: { lte: new Date() },
      },
      take: 50,
    });

    for (const batch of overdueDripBatches) {
      await enqueueDripFeedBatch(batch.orderId, batch.batchNumber, 0);
    }
  } catch (err) {
    logger.error("Outbox poller check encountered an error:", err);
  }
}

/**
 * Starts periodic polling of the outbox table.
 */
export function startOutboxPoller(intervalMs: number = 30000): void {
  if (pollerInterval) return;

  logger.info(`Starting Outbox Poller with interval of ${intervalMs}ms`);
  pollerInterval = setInterval(() => {
    void pollOutboxJobs();
  }, intervalMs);
  pollerInterval.unref();
}

/**
 * Stops periodic polling of the outbox table.
 */
export function stopOutboxPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    logger.info("Outbox Poller stopped.");
  }
}
