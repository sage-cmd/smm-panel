import { Worker, Job } from "bullmq";
import { redisOptions } from "../../lib/redis";
import { prisma } from "../../lib/prisma";
import { QUEUE_NAMES, DripFeedJobData, enqueueDripFeedBatch } from "../queues";
import { ISMMProvider } from "../../modules/provider/provider.interface";
import { defaultProvider } from "../../modules/provider/mockProvider";
import { emitOrderEvent } from "../events";
import { logger } from "../../lib/logger";

export async function processDripFeedBatchJob(
  job: Job<DripFeedJobData>,
  provider: ISMMProvider = defaultProvider,
): Promise<void> {
  const { orderId, batchNumber } = job.data;

  const batch = await prisma.dripFeedBatch.findUnique({
    where: {
      orderId_batchNumber: { orderId, batchNumber },
    },
    include: {
      order: {
        include: { service: true, user: true },
      },
    },
  });

  if (!batch) {
    logger.warn(`Drip-feed batch #${batchNumber} for order #${orderId} not found`);
    return;
  }

  if (batch.status === "COMPLETED" || batch.status === "CANCELED") {
    logger.info(`Drip-feed batch #${batchNumber} for order #${orderId} is already ${batch.status}`);
    return;
  }

  // If parent order is canceled, mark batch as canceled
  if (batch.order.status === "CANCELED") {
    await prisma.dripFeedBatch.update({
      where: { id: batch.id },
      data: { status: "CANCELED" },
    });
    return;
  }

  // Mark batch as PROCESSING
  await prisma.dripFeedBatch.update({
    where: { id: batch.id },
    data: { status: "PROCESSING" },
  });

  // Ensure order status is PROCESSING
  if (batch.order.status === "PENDING") {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "PROCESSING" },
    });
  }

  try {
    // 1. Dispatch batch to provider
    const placement = await provider.createOrder({
      orderId: batch.orderId,
      serviceId: batch.order.serviceId,
      link: batch.order.link,
      quantity: batch.quantity,
    });

    // 2. Mark batch as COMPLETED
    await prisma.dripFeedBatch.update({
      where: { id: batch.id },
      data: {
        status: "COMPLETED",
        externalOrderId: placement.externalOrderId,
        executedAt: new Date(),
      },
    });

    // 3. Compute remaining order quantity
    const newRemains = Math.max(0, batch.order.remains - batch.quantity);

    // 4. Look for next pending batch
    const nextBatch = await prisma.dripFeedBatch.findFirst({
      where: {
        orderId,
        status: "PENDING",
        batchNumber: { gt: batchNumber },
      },
      orderBy: { batchNumber: "asc" },
    });

    if (!nextBatch) {
      // All batches executed -> complete order
      const completedOrder = await prisma.order.update({
        where: { id: orderId },
        data: {
          status: "COMPLETED",
          remains: 0,
          startCount: placement.startCount ?? batch.order.startCount,
        },
      });

      await prisma.fulfillmentJob.update({
        where: { orderId },
        data: {
          status: "COMPLETED",
          processedAt: new Date(),
        },
      });

      const eventOrder = completedOrder ?? {
        ...batch.order,
        status: "COMPLETED",
        remains: 0,
        startCount: placement.startCount ?? batch.order.startCount,
      };

      await emitOrderEvent("order.completed", {
        id: eventOrder.id,
        userId: eventOrder.userId,
        serviceId: eventOrder.serviceId,
        status: "COMPLETED",
        remains: 0,
        startCount: eventOrder.startCount,
        totalCharge: eventOrder.totalCharge,
      });
    } else {
      // More batches remain -> update order remains & schedule next batch
      const updatedOrder = await prisma.order.update({
        where: { id: orderId },
        data: {
          status: "PROCESSING",
          remains: newRemains,
          startCount: placement.startCount ?? batch.order.startCount,
        },
      });

      const delayMs = Math.max(0, nextBatch.scheduledAt.getTime() - Date.now());
      await enqueueDripFeedBatch(orderId, nextBatch.batchNumber, delayMs);

      const eventOrder = updatedOrder ?? {
        ...batch.order,
        status: "PROCESSING",
        remains: newRemains,
        startCount: placement.startCount ?? batch.order.startCount,
      };

      await emitOrderEvent("order.processing", {
        id: eventOrder.id,
        userId: eventOrder.userId,
        serviceId: eventOrder.serviceId,
        status: "PROCESSING",
        remains: newRemains,
        startCount: eventOrder.startCount,
        totalCharge: eventOrder.totalCharge,
      });
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Drip feed provider error";
    logger.error(`Drip-feed batch #${batchNumber} for order #${orderId} failed: ${errorMessage}`);

    await prisma.dripFeedBatch.update({
      where: { id: batch.id },
      data: {
        status: "FAILED",
        errorMessage,
      },
    });

    throw err;
  }
}

export function createDripFeedWorker(
  provider: ISMMProvider = defaultProvider,
): Worker<DripFeedJobData> {
  const worker = new Worker<DripFeedJobData>(
    QUEUE_NAMES.DRIP_FEED,
    (job) => processDripFeedBatchJob(job, provider),
    {
      connection: redisOptions,
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    logger.warn(`Drip feed job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  });

  return worker;
}
