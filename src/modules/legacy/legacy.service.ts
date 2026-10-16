import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { BadRequestError } from "../../errors/AppError";
import {
  calculateOrderCharge,
  formatMonetaryAmount,
  distributeDripFeedBatches,
} from "../financial/calculator";
import { LegacyAddOrderInput, LegacyOrderStatusInput } from "./legacy.schemas";
import { enqueueOrderFulfillment, enqueueDripFeedBatch } from "../../jobs/queues";
import { emitOrderEvent } from "../../jobs/events";
import { logger } from "../../lib/logger";

/**
 * Maps OrderStatus enum to legacy SMM panel title-case representation
 */
export function mapLegacyStatus(status: string): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "PROCESSING":
      return "In progress";
    case "COMPLETED":
      return "Completed";
    case "CANCELED":
      return "Canceled";
    case "PARTIAL":
      return "Partial";
    default:
      return status;
  }
}

export class LegacyService {
  /**
   * Action: balance
   * Returns: {"status":"success","balance":"15.50","currency":"USD"}
   */
  public async getBalance(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestError("User not found");
    }

    return {
      status: "success",
      balance: formatMonetaryAmount(user.balance, 2),
      currency: user.currency,
    };
  }

  /**
   * Action: services
   * Returns active catalog services in documented legacy format
   */
  public async getServices() {
    const services = await prisma.service.findMany({
      where: { isActive: true },
      orderBy: { id: "asc" },
    });

    return services.map((s) => ({
      service: s.id,
      name: s.name,
      type: s.type,
      category: s.category,
      rate: formatMonetaryAmount(s.ratePer1000, 6),
      min: s.minQuantity.toString(),
      max: s.maxQuantity.toString(),
      dripfeed: s.supportsDripfeed,
      refill: false,
      cancel: false,
    }));
  }

  /**
   * Action: add
   * Atomically validates, deducts balance, persists transaction, order, and fulfillment outbox.
   * Returns: {"status":"success","order":32}
   */
  public async addOrder(userId: string, data: LegacyAddOrderInput) {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Validate active service existence
      const service = await tx.service.findUnique({
        where: { id: data.service },
      });

      if (!service || !service.isActive) {
        throw new BadRequestError("Incorrect service");
      }

      // 2. Validate quantity limits
      if (data.quantity < service.minQuantity || data.quantity > service.maxQuantity) {
        throw new BadRequestError(
          `Quantity must be between ${service.minQuantity} and ${service.maxQuantity}`,
        );
      }

      // 3. Validate drip-feed capabilities
      const isDripFeed = data.runs !== undefined && data.interval !== undefined;
      if (isDripFeed && !service.supportsDripfeed) {
        throw new BadRequestError("This service does not support drip-feed");
      }

      // 4. Calculate exact charge using decimal.js
      const totalCharge = calculateOrderCharge(data.quantity, service.ratePer1000);

      // 5. Atomic balance deduction in PostgreSQL to prevent race conditions & negative balances
      const rowsUpdated = await tx.$executeRaw`
        UPDATE "users"
        SET "balance" = "balance" - ${totalCharge.toString()}::decimal(18,6), "updatedAt" = NOW()
        WHERE "id" = ${userId} AND "balance" >= ${totalCharge.toString()}::decimal(18,6)
      `;

      if (rowsUpdated === 0) {
        throw new BadRequestError("Not enough balance on your account");
      }

      // 6. Record financial ledger transaction
      const transaction = await tx.transaction.create({
        data: {
          userId,
          amount: new Prisma.Decimal(totalCharge.toString()),
          type: "DEDUCTION",
          status: "SUCCESS",
          description: `Order placement - ${service.name}`,
        },
      });

      // Calculate refill guarantee snapshot if service supports it
      const refillStatus = service.refillEnabled ? "WAITING" : "NONE";
      const refillExpiresAt =
        service.refillEnabled && service.refillPeriodDays
          ? new Date(Date.now() + service.refillPeriodDays * 24 * 60 * 60 * 1000)
          : null;

      // 7. Persist Order
      const order = await tx.order.create({
        data: {
          userId,
          serviceId: service.id,
          link: data.link,
          quantity: data.quantity,
          totalCharge: new Prisma.Decimal(totalCharge.toString()),
          status: "PENDING",
          remains: data.quantity,
          runs: isDripFeed ? data.runs : null,
          interval: isDripFeed ? data.interval : null,
          refillStatus,
          refillExpiresAt,
        },
      });

      // Link transaction to order ID
      await tx.transaction.update({
        where: { id: transaction.id },
        data: {
          orderId: order.id,
          description: `Order #${order.id} - ${service.name}`,
        },
      });

      // 8. Persist durable outbox fulfillment job
      await tx.fulfillmentJob.create({
        data: {
          orderId: order.id,
          status: "PENDING",
          payload: {
            orderId: order.id,
            serviceId: service.id,
            link: data.link,
            quantity: data.quantity,
            isDripfeed: isDripFeed,
            runs: isDripFeed ? data.runs : null,
            interval: isDripFeed ? data.interval : null,
          },
        },
      });

      // 9. If drip-feed, persist distributed batch schedules
      if (isDripFeed && data.runs && data.interval) {
        const batchPlans = distributeDripFeedBatches(data.quantity, data.runs, data.interval);
        for (const batch of batchPlans) {
          await tx.dripFeedBatch.create({
            data: {
              orderId: order.id,
              batchNumber: batch.batchNumber,
              quantity: batch.quantity,
              scheduledAt: batch.scheduledAt,
              status: "PENDING",
            },
          });
        }
      }

      return order;
    });

    // Enqueue background processing and trigger webhook events
    const isDripFeed = result.runs !== null && result.runs > 1;
    try {
      if (isDripFeed) {
        await enqueueDripFeedBatch(result.id, 1, 0);
      } else {
        await enqueueOrderFulfillment(result.id);
      }
    } catch (queueErr) {
      logger.error(`Failed to enqueue background job for order #${result.id}:`, queueErr);
    }

    try {
      await emitOrderEvent("order.created", {
        id: result.id,
        userId: result.userId,
        serviceId: result.serviceId,
        status: result.status,
        remains: result.remains,
        startCount: result.startCount,
        totalCharge: result.totalCharge,
      });
    } catch (eventErr) {
      logger.error(`Failed to emit order.created for order #${result.id}:`, eventErr);
    }

    return {
      status: "success",
      order: result.id,
    };
  }

  /**
   * Action: status
   * Supports both single order ID and comma-separated IDs list.
   * Enforces strict user ownership: never leaks or returns orders of other users.
   */
  public async getOrderStatus(userId: string, input: LegacyOrderStatusInput) {
    const rawInput = String(input.order ?? input.orders).trim();
    const rawTokens = rawInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    if (rawTokens.length === 0) {
      throw new BadRequestError("Incorrect order ID");
    }

    const isMultiQuery = rawTokens.length > 1 || rawInput.includes(",");

    // Single order query
    if (!isMultiQuery) {
      const orderId = Number(rawTokens[0]);
      if (isNaN(orderId)) {
        throw new BadRequestError("Incorrect order ID");
      }

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { user: true },
      });

      if (!order || order.userId !== userId) {
        throw new BadRequestError("Incorrect order ID");
      }

      return {
        charge: formatMonetaryAmount(order.totalCharge, 6),
        start_count: (order.startCount ?? 0).toString(),
        status: mapLegacyStatus(order.status),
        remains: order.remains.toString(),
        currency: order.user.currency,
      };
    }

    // Multiple orders query (e.g. order="1,2,3")
    const orderIds = rawTokens
      .map((t) => Number(t))
      .filter((n) => !isNaN(n) && Number.isInteger(n));

    const orders = await prisma.order.findMany({
      where: {
        id: { in: orderIds },
        userId, // Ownership filter
      },
      include: { user: true },
    });

    const orderMap = new Map<number, (typeof orders)[0]>();
    for (const ord of orders) {
      orderMap.set(ord.id, ord);
    }

    const response: Record<string, unknown> = {};

    for (const token of rawTokens) {
      const parsedId = Number(token);
      const matched = !isNaN(parsedId) ? orderMap.get(parsedId) : undefined;

      if (!matched) {
        response[token] = { error: "Incorrect order ID" };
      } else {
        response[token] = {
          charge: formatMonetaryAmount(matched.totalCharge, 6),
          start_count: (matched.startCount ?? 0).toString(),
          status: mapLegacyStatus(matched.status),
          remains: matched.remains.toString(),
          currency: matched.user.currency,
        };
      }
    }

    return response;
  }
}

export const legacyService = new LegacyService();
