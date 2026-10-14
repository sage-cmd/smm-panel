import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { BadRequestError, ConflictError, NotFoundError } from "../../errors/AppError";
import {
  calculateOrderCharge,
  formatMonetaryAmount,
  distributeDripFeedBatches,
} from "../financial/calculator";
import { parsePaginationParams, formatPaginationMeta } from "../../utils/pagination";
import {
  RestCreateOrderInput,
  RestCreateWebhookInput,
  RestUpdateWebhookInput,
} from "./rest.schemas";
import { enqueueOrderFulfillment, enqueueDripFeedBatch } from "../../jobs/queues";
import { emitOrderEvent } from "../../jobs/events";
import { logger } from "../../lib/logger";

export class RestService {
  /**
   * GET /api/v1/rest/services
   * Returns paginated active services with optional category filter and keyword search.
   */
  public async getServices(query: Record<string, unknown>) {
    const { page, limit, skip } = parsePaginationParams(query, 20, 100);

    const where: Prisma.ServiceWhereInput = {
      isActive: true,
    };

    if (typeof query.category === "string" && query.category.trim().length > 0) {
      where.category = query.category.trim();
    }

    if (typeof query.search === "string" && query.search.trim().length > 0) {
      where.name = {
        contains: query.search.trim(),
        mode: "insensitive",
      };
    }

    const [total, services] = await Promise.all([
      prisma.service.count({ where }),
      prisma.service.findMany({
        where,
        skip,
        take: limit,
        orderBy: { id: "asc" },
      }),
    ]);

    const formattedServices = services.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      ratePer1000: formatMonetaryAmount(s.ratePer1000, 6),
      minQuantity: s.minQuantity,
      maxQuantity: s.maxQuantity,
      type: s.type,
      description: s.description,
      supportsDripfeed: s.supportsDripfeed,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    return {
      services: formattedServices,
      pagination: formatPaginationMeta(total, page, limit),
    };
  }

  /**
   * POST /api/v1/rest/orders
   * Atomically validates, deducts balance, persists transaction, order, and outbox fulfillment job.
   * Supports optional idempotency key protection.
   */
  public async createOrder(userId: string, data: RestCreateOrderInput, idempotencyKey?: string) {
    // 1. Check idempotency if key was provided
    if (idempotencyKey) {
      const existingRecord = await prisma.idempotencyRecord.findUnique({
        where: {
          userId_key: {
            userId,
            key: idempotencyKey,
          },
        },
      });

      if (existingRecord) {
        if (existingRecord.status === "RESOLVED") {
          return {
            fromCache: true,
            statusCode: existingRecord.statusCode ?? 201,
            data: existingRecord.responseBody,
          };
        }
        if (existingRecord.status === "PENDING") {
          throw new ConflictError(
            "A request with this idempotency key is currently processing. Please wait.",
          );
        }
      }

      // Record pending idempotency state (expires in 24 hours)
      const requestHash = crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");

      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await prisma.idempotencyRecord.create({
        data: {
          userId,
          key: idempotencyKey,
          requestHash,
          status: "PENDING",
          expiresAt,
        },
      });
    }

    // 2. Execute transactional balance deduction & order creation
    try {
      const order = await prisma.$transaction(async (tx) => {
        // Validate service
        const service = await tx.service.findUnique({
          where: { id: data.serviceId },
        });

        if (!service || !service.isActive) {
          throw new BadRequestError("Requested service is not available");
        }

        if (data.quantity < service.minQuantity || data.quantity > service.maxQuantity) {
          throw new BadRequestError(
            `Quantity must be between ${service.minQuantity} and ${service.maxQuantity}`,
          );
        }

        const isDripFeed = data.runs !== undefined && data.interval !== undefined;
        if (isDripFeed && !service.supportsDripfeed) {
          throw new BadRequestError("This service does not support drip-feed orders");
        }

        // Calculate exact charge using decimal.js
        const totalCharge = calculateOrderCharge(data.quantity, service.ratePer1000);

        // Atomic balance deduction
        const rowsUpdated = await tx.$executeRaw`
          UPDATE "users"
          SET "balance" = "balance" - ${totalCharge.toString()}::decimal(18,6), "updatedAt" = NOW()
          WHERE "id" = ${userId} AND "balance" >= ${totalCharge.toString()}::decimal(18,6)
        `;

        if (rowsUpdated === 0) {
          throw new BadRequestError("Insufficient account balance for this order");
        }

        // Ledger transaction
        const transaction = await tx.transaction.create({
          data: {
            userId,
            amount: new Prisma.Decimal(totalCharge.toString()),
            type: "DEDUCTION",
            status: "SUCCESS",
            description: `Order placement for service #${service.id} (${service.name})`,
          },
        });

        // Persist Order
        const createdOrder = await tx.order.create({
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
          },
        });

        // Link transaction to order ID
        await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            orderId: createdOrder.id,
            description: `Order #${createdOrder.id} - ${service.name}`,
          },
        });

        // Persist outbox fulfillment job
        await tx.fulfillmentJob.create({
          data: {
            orderId: createdOrder.id,
            status: "PENDING",
            payload: {
              orderId: createdOrder.id,
              serviceId: service.id,
              link: data.link,
              quantity: data.quantity,
              isDripfeed: isDripFeed,
              runs: isDripFeed ? data.runs : null,
              interval: isDripFeed ? data.interval : null,
            },
          },
        });

        // Drip feed batch schedules
        if (isDripFeed && data.runs && data.interval) {
          const batches = distributeDripFeedBatches(data.quantity, data.runs, data.interval);
          for (const b of batches) {
            await tx.dripFeedBatch.create({
              data: {
                orderId: createdOrder.id,
                batchNumber: b.batchNumber,
                quantity: b.quantity,
                scheduledAt: b.scheduledAt,
                status: "PENDING",
              },
            });
          }
        }

        return createdOrder;
      });

      // Enqueue background processing and trigger webhook events
      const isDripFeed = order.runs !== null && order.runs > 1;
      try {
        if (isDripFeed) {
          await enqueueDripFeedBatch(order.id, 1, 0);
        } else {
          await enqueueOrderFulfillment(order.id);
        }
      } catch (queueErr) {
        logger.error(`Failed to enqueue background job for order #${order.id}:`, queueErr);
      }

      try {
        await emitOrderEvent("order.created", {
          id: order.id,
          userId: order.userId,
          serviceId: order.serviceId,
          status: order.status,
          remains: order.remains,
          startCount: order.startCount,
          totalCharge: order.totalCharge,
        });
      } catch (eventErr) {
        logger.error(`Failed to emit order.created for order #${order.id}:`, eventErr);
      }

      const responsePayload = {
        id: order.id,
        serviceId: order.serviceId,
        link: order.link,
        quantity: order.quantity,
        totalCharge: formatMonetaryAmount(order.totalCharge, 6),
        status: order.status,
        remains: order.remains,
        runs: order.runs,
        interval: order.interval,
        createdAt: order.createdAt,
      };

      // Resolve idempotency record if present
      if (idempotencyKey) {
        await prisma.idempotencyRecord.update({
          where: {
            userId_key: {
              userId,
              key: idempotencyKey,
            },
          },
          data: {
            status: "RESOLVED",
            statusCode: 201,
            responseBody: responsePayload as unknown as Prisma.InputJsonValue,
          },
        });
      }

      return {
        fromCache: false,
        statusCode: 201,
        data: responsePayload,
      };
    } catch (error) {
      // Mark idempotency as failed on transaction abort
      if (idempotencyKey) {
        await prisma.idempotencyRecord
          .update({
            where: {
              userId_key: {
                userId,
                key: idempotencyKey,
              },
            },
            data: {
              status: "FAILED",
            },
          })
          .catch(() => {});
      }
      throw error;
    }
  }

  /**
   * GET /api/v1/rest/orders/:id
   * Retrieves single order by ID with ownership isolation.
   */
  public async getOrder(userId: string, orderId: number) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        service: {
          select: {
            id: true,
            name: true,
            category: true,
            type: true,
          },
        },
      },
    });

    if (!order || order.userId !== userId) {
      throw new NotFoundError(`Order #${orderId} not found`);
    }

    return {
      id: order.id,
      serviceId: order.serviceId,
      service: order.service,
      link: order.link,
      quantity: order.quantity,
      totalCharge: formatMonetaryAmount(order.totalCharge, 6),
      status: order.status,
      startCount: order.startCount,
      remains: order.remains,
      runs: order.runs,
      interval: order.interval,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  /**
   * GET /api/v1/rest/balance
   * Returns user balance and paginated transaction ledger history.
   */
  public async getBalanceAndTransactions(userId: string, query: Record<string, unknown>) {
    const { page, limit, skip } = parsePaginationParams(query, 10, 50);

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundError("User not found");
    }

    const [totalTransactions, transactions] = await Promise.all([
      prisma.transaction.count({ where: { userId } }),
      prisma.transaction.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const formattedTransactions = transactions.map((t) => ({
      id: t.id,
      orderId: t.orderId,
      amount: formatMonetaryAmount(t.amount, 6),
      type: t.type,
      status: t.status,
      description: t.description,
      createdAt: t.createdAt,
    }));

    return {
      balance: formatMonetaryAmount(user.balance, 6),
      currency: user.currency,
      transactions: formattedTransactions,
      pagination: formatPaginationMeta(totalTransactions, page, limit),
    };
  }

  /**
   * GET /api/v1/rest/webhooks
   * Lists user webhooks, omitting secrets.
   */
  public async listWebhooks(userId: string) {
    const webhooks = await prisma.webhook.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    return webhooks.map((w) => ({
      id: w.id,
      url: w.url,
      events: w.events,
      isActive: w.isActive,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    }));
  }

  /**
   * POST /api/v1/rest/webhooks
   * Creates a webhook subscription. Returns secret once upon creation.
   */
  public async createWebhook(userId: string, data: RestCreateWebhookInput) {
    const generatedSecret = data.secret || `whsec_${crypto.randomBytes(24).toString("hex")}`;

    const webhook = await prisma.webhook.create({
      data: {
        userId,
        url: data.url,
        events: data.events,
        secret: generatedSecret,
        isActive: true,
      },
    });

    return {
      id: webhook.id,
      url: webhook.url,
      secret: generatedSecret, // Displayed once upon creation
      events: webhook.events,
      isActive: webhook.isActive,
      createdAt: webhook.createdAt,
    };
  }

  /**
   * GET /api/v1/rest/webhooks/:id
   * Retrieves single webhook by ID with ownership isolation. Omits secret.
   */
  public async getWebhook(userId: string, webhookId: string) {
    const webhook = await prisma.webhook.findUnique({
      where: { id: webhookId },
    });

    if (!webhook || webhook.userId !== userId) {
      throw new NotFoundError(`Webhook #${webhookId} not found`);
    }

    return {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      isActive: webhook.isActive,
      createdAt: webhook.createdAt,
      updatedAt: webhook.updatedAt,
    };
  }

  /**
   * PATCH /api/v1/rest/webhooks/:id
   * Updates an existing webhook subscription. Omits secret.
   */
  public async updateWebhook(userId: string, webhookId: string, data: RestUpdateWebhookInput) {
    const webhook = await prisma.webhook.findUnique({
      where: { id: webhookId },
    });

    if (!webhook || webhook.userId !== userId) {
      throw new NotFoundError(`Webhook #${webhookId} not found`);
    }

    const updated = await prisma.webhook.update({
      where: { id: webhookId },
      data: {
        url: data.url,
        events: data.events,
        isActive: data.isActive,
      },
    });

    return {
      id: updated.id,
      url: updated.url,
      events: updated.events,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  /**
   * DELETE /api/v1/rest/webhooks/:id
   * Deletes a webhook subscription with ownership isolation.
   */
  public async deleteWebhook(userId: string, webhookId: string): Promise<void> {
    const webhook = await prisma.webhook.findUnique({
      where: { id: webhookId },
    });

    if (!webhook || webhook.userId !== userId) {
      throw new NotFoundError(`Webhook #${webhookId} not found`);
    }

    await prisma.webhook.delete({
      where: { id: webhookId },
    });
  }
}

export const restService = new RestService();
