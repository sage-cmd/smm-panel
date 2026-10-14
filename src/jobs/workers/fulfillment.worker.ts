import { Worker, Job } from "bullmq";
import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";
import { redisOptions } from "../../lib/redis";
import { prisma } from "../../lib/prisma";
import { QUEUE_NAMES, OrderFulfillmentJobData } from "../queues";
import { ISMMProvider } from "../../modules/provider/provider.interface";
import { defaultProvider } from "../../modules/provider/mockProvider";
import { emitOrderEvent } from "../events";
import { logger } from "../../lib/logger";

export async function processOrderFulfillmentJob(
  job: Job<OrderFulfillmentJobData>,
  provider: ISMMProvider = defaultProvider,
): Promise<void> {
  const { orderId } = job.data;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      fulfillmentJob: true,
      service: true,
    },
  });

  if (!order) {
    logger.warn(`Order #${orderId} not found for fulfillment`);
    return;
  }

  // Drip-feed orders are handled by the dripfeed worker
  if (order.runs && order.runs > 1) {
    logger.info(`Order #${orderId} is drip-feed; skipping single fulfillment worker`);
    return;
  }

  // If already reached terminal status, skip
  if (["COMPLETED", "CANCELED", "PARTIAL"].includes(order.status)) {
    logger.info(`Order #${orderId} already in terminal status ${order.status}`);
    return;
  }

  // Mark Order and FulfillmentJob as PROCESSING
  await prisma.order.update({
    where: { id: orderId },
    data: { status: "PROCESSING" },
  });

  await prisma.fulfillmentJob.update({
    where: { orderId },
    data: {
      status: "PROCESSING",
      attempts: { increment: 1 },
    },
  });

  await emitOrderEvent("order.processing", {
    id: order.id,
    userId: order.userId,
    serviceId: order.serviceId,
    status: "PROCESSING",
    remains: order.remains,
    startCount: order.startCount,
    totalCharge: order.totalCharge,
  });

  try {
    // 1. Submit to external provider
    const placement = await provider.createOrder({
      orderId: order.id,
      serviceId: order.serviceId,
      link: order.link,
      quantity: order.quantity,
    });

    // 2. Fetch order status from provider
    const statusResult = await provider.getOrderStatus(placement.externalOrderId);

    if (statusResult.status === "COMPLETED") {
      const updatedOrder = await prisma.order.update({
        where: { id: order.id },
        data: {
          status: "COMPLETED",
          remains: 0,
          externalOrderId: placement.externalOrderId,
          startCount: placement.startCount ?? statusResult.startCount ?? order.startCount,
        },
      });

      await prisma.fulfillmentJob.update({
        where: { orderId: order.id },
        data: {
          status: "COMPLETED",
          processedAt: new Date(),
        },
      });

      await emitOrderEvent("order.completed", {
        id: updatedOrder.id,
        userId: updatedOrder.userId,
        serviceId: updatedOrder.serviceId,
        status: "COMPLETED",
        remains: 0,
        startCount: updatedOrder.startCount,
        totalCharge: updatedOrder.totalCharge,
      });
    } else if (statusResult.status === "PARTIAL") {
      const remains = statusResult.remains > 0 ? statusResult.remains : 0;
      const refundFraction = new Decimal(remains).dividedBy(order.quantity);
      const refundAmount = new Decimal(order.totalCharge.toString())
        .times(refundFraction)
        .toDecimalPlaces(6, Decimal.ROUND_DOWN);

      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: "PARTIAL",
            remains,
            externalOrderId: placement.externalOrderId,
            startCount: placement.startCount ?? statusResult.startCount ?? order.startCount,
          },
        });

        await tx.fulfillmentJob.update({
          where: { orderId: order.id },
          data: {
            status: "COMPLETED",
            processedAt: new Date(),
          },
        });

        if (refundAmount.isPositive() && !refundAmount.isZero()) {
          await tx.$executeRaw`
            UPDATE "users"
            SET "balance" = "balance" + ${refundAmount.toString()}::decimal(18,6), "updatedAt" = NOW()
            WHERE "id" = ${order.userId}
          `;

          await tx.transaction.create({
            data: {
              userId: order.userId,
              orderId: order.id,
              amount: new Prisma.Decimal(refundAmount.toString()),
              type: "REFUND",
              status: "SUCCESS",
              description: `Partial refund for order #${order.id} (${remains} units remaining)`,
            },
          });
        }
      });

      await emitOrderEvent("order.partial", {
        id: order.id,
        userId: order.userId,
        serviceId: order.serviceId,
        status: "PARTIAL",
        remains,
        startCount: placement.startCount,
        totalCharge: order.totalCharge,
      });
    } else if (statusResult.status === "CANCELED") {
      const refundAmount = new Decimal(order.totalCharge.toString());

      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: "CANCELED",
            remains: order.quantity,
            externalOrderId: placement.externalOrderId,
          },
        });

        await tx.fulfillmentJob.update({
          where: { orderId: order.id },
          data: {
            status: "FAILED",
            lastError: "Order canceled by provider",
            processedAt: new Date(),
          },
        });

        await tx.$executeRaw`
          UPDATE "users"
          SET "balance" = "balance" + ${refundAmount.toString()}::decimal(18,6), "updatedAt" = NOW()
          WHERE "id" = ${order.userId}
        `;

        await tx.transaction.create({
          data: {
            userId: order.userId,
            orderId: order.id,
            amount: new Prisma.Decimal(refundAmount.toString()),
            type: "REFUND",
            status: "SUCCESS",
            description: `Full refund for canceled order #${order.id}`,
          },
        });
      });

      await emitOrderEvent("order.canceled", {
        id: order.id,
        userId: order.userId,
        serviceId: order.serviceId,
        status: "CANCELED",
        remains: order.quantity,
        startCount: placement.startCount,
        totalCharge: order.totalCharge,
      });
    } else {
      // Status is still PROCESSING
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: "PROCESSING",
          externalOrderId: placement.externalOrderId,
          startCount: placement.startCount ?? order.startCount,
        },
      });

      await prisma.fulfillmentJob.update({
        where: { orderId: order.id },
        data: {
          status: "DISPATCHED",
        },
      });
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : "Provider fulfillment error";
    const attemptsMade = job.attemptsMade + 1;
    const maxAttempts = order.fulfillmentJob?.maxAttempts ?? 5;

    logger.error(`Order #${order.id} fulfillment attempt ${attemptsMade} failed: ${errorMessage}`);

    if (attemptsMade >= maxAttempts) {
      // Retries exhausted: refund user and mark CANCELED
      const refundAmount = new Decimal(order.totalCharge.toString());

      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: "CANCELED",
          },
        });

        await tx.fulfillmentJob.update({
          where: { orderId: order.id },
          data: {
            status: "FAILED",
            lastError: errorMessage,
            processedAt: new Date(),
          },
        });

        await tx.$executeRaw`
          UPDATE "users"
          SET "balance" = "balance" + ${refundAmount.toString()}::decimal(18,6), "updatedAt" = NOW()
          WHERE "id" = ${order.userId}
        `;

        await tx.transaction.create({
          data: {
            userId: order.userId,
            orderId: order.id,
            amount: new Prisma.Decimal(refundAmount.toString()),
            type: "REFUND",
            status: "SUCCESS",
            description: `Automatic refund: fulfillment failed after ${maxAttempts} attempts for order #${order.id}`,
          },
        });
      });

      await emitOrderEvent("order.canceled", {
        id: order.id,
        userId: order.userId,
        serviceId: order.serviceId,
        status: "CANCELED",
        remains: order.quantity,
        startCount: order.startCount,
        totalCharge: order.totalCharge,
      });
    } else {
      await prisma.fulfillmentJob.update({
        where: { orderId: order.id },
        data: {
          status: "PENDING",
          lastError: errorMessage,
        },
      });
    }

    throw err;
  }
}

export function createOrderFulfillmentWorker(
  provider: ISMMProvider = defaultProvider,
): Worker<OrderFulfillmentJobData> {
  const worker = new Worker<OrderFulfillmentJobData>(
    QUEUE_NAMES.ORDER_FULFILLMENT,
    (job) => processOrderFulfillmentJob(job, provider),
    {
      connection: redisOptions,
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    logger.warn(
      `Order fulfillment job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`,
    );
  });

  return worker;
}
