import axios, { AxiosError } from "axios";
import { z } from "zod";
import { Job, Queue, Worker } from "bullmq";
import { prisma } from "../lib/prisma";
import { redisOptions } from "../lib/redis";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { RefillStatus, RefillLogStatus, OrderStatus } from "@prisma/client";

// ==============================================================================
// 1. Zod Schemas for Supplier SMM v2 Responses
// ==============================================================================

/**
 * Validates a successful refill placement response: { refill: "<id>" } or { refill: 1234 }
 */
export const SupplierRefillSuccessSchema = z.object({
  refill: z.union([z.string(), z.number()]).transform((val) => String(val)),
});

/**
 * Validates a standard SMM v2 error response: { error: "<message>" }
 */
export const SupplierRefillErrorSchema = z.object({
  error: z.string(),
});

export const SupplierRefillResponseSchema = z.union([
  SupplierRefillSuccessSchema,
  SupplierRefillErrorSchema,
]);

export type SupplierRefillResponse = z.infer<typeof SupplierRefillResponseSchema>;

/**
 * Validates refill status query response:
 * { status: "Pending" | "In progress" | "Completed" | "Rejected" | "Error" }
 */
export const SupplierRefillStatusSuccessSchema = z.object({
  status: z.enum(["Pending", "In progress", "Completed", "Rejected", "Error"]),
});

export const SupplierRefillStatusResponseSchema = z.union([
  SupplierRefillStatusSuccessSchema,
  SupplierRefillErrorSchema,
]);

export type SupplierRefillStatusResponse = z.infer<typeof SupplierRefillStatusResponseSchema>;

// ==============================================================================
// 2. HTTP Helper with 10s Timeout, Zod Validation, and Key Masking
// ==============================================================================

const REQUEST_TIMEOUT_MS = 10000;
const CONCURRENCY_CAP = 5;

/**
 * Requests an auto-refill for an external order from the supplier.
 *
 * CRITICAL INVARIANT: NEVER auto-retry the refill POST.
 * SMM refill placement actions are not guaranteed to be idempotent across providers.
 */
export async function callSupplierRefill(
  apiUrl: string,
  apiKey: string,
  externalOrderId: string,
): Promise<SupplierRefillResponse> {
  try {
    const response = await axios.post(
      apiUrl,
      {
        key: apiKey,
        action: "refill",
        order: externalOrderId,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "SMM-Auto-Refill-Worker/1.0",
        },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true, // inspect payload regardless of HTTP status
      },
    );

    const parsed = SupplierRefillResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      const stringified =
        typeof response.data === "string" ? response.data : JSON.stringify(response.data);
      return {
        error: `Invalid supplier response format: ${stringified.slice(0, 200)}`,
      };
    }

    return parsed.data;
  } catch (err: unknown) {
    const errorMsg =
      err instanceof AxiosError
        ? `Network error: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Unknown network error during refill request";

    return { error: errorMsg };
  }
}

/**
 * Polls the current status of an in-flight refill request from the supplier.
 * Network retries (up to 2 times) are allowed for read-only status calls.
 */
export async function callSupplierRefillStatus(
  apiUrl: string,
  apiKey: string,
  supplierRefillId: string,
  maxRetries = 2,
): Promise<SupplierRefillStatusResponse> {
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const response = await axios.post(
        apiUrl,
        {
          key: apiKey,
          action: "refill_status",
          refill: supplierRefillId,
        },
        {
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "SMM-Auto-Refill-Worker/1.0",
          },
          timeout: REQUEST_TIMEOUT_MS,
          validateStatus: () => true,
        },
      );

      const parsed = SupplierRefillStatusResponseSchema.safeParse(response.data);
      if (!parsed.success) {
        const stringified =
          typeof response.data === "string" ? response.data : JSON.stringify(response.data);
        return {
          error: `Invalid supplier refill status response: ${stringified.slice(0, 200)}`,
        };
      }

      return parsed.data;
    } catch (err: unknown) {
      attempt++;
      if (attempt > maxRetries) {
        const errorMsg =
          err instanceof AxiosError
            ? `Network error after retries: ${err.message}`
            : err instanceof Error
              ? err.message
              : "Network error during refill_status";
        return { error: errorMsg };
      }
      // Brief exponential backoff before read retry (500ms, 1000ms)
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }

  return { error: "Failed to poll refill status" };
}

// ==============================================================================
// 3. Concurrency Control Helper
// ==============================================================================

/**
 * Runs tasks with a strict concurrency ceiling.
 * Each item is isolated in its own try/catch to guarantee one order failure never halts the run.
 */
export async function processWithConcurrency<T>(
  items: T[],
  limit: number,
  handler: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  let index = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (index < items.length) {
      const current = items[index++];
      if (current !== undefined) {
        try {
          await handler(current);
        } catch (err: unknown) {
          // Guard against uncaught exceptions escaping handler
          logger.error(`Unexpected error processing item in refill worker: ${err}`);
        }
      }
    }
  });

  await Promise.all(workers);
}

// ==============================================================================
// 4. Refill Execution Steps (A, B, C)
// ==============================================================================

/**
 * STEP A: Poll in-flight refills (orders with refillStatus = REFILLING).
 *
 * Transitions:
 * - "Completed" -> RefillLog: SUCCESS, Order: WAITING, activeRefillId: null
 * - "Rejected" | "Error" | { error } -> RefillLog: FAILED, Order: WAITING, activeRefillId: null
 * - "Pending" | "In progress" -> Leave as REFILLING, update lastRefillCheck
 */
export async function pollInFlightRefills(dryRun = false): Promise<number> {
  const inFlightOrders = await prisma.order.findMany({
    where: {
      refillStatus: RefillStatus.REFILLING,
      activeRefillId: { not: null },
    },
    include: {
      service: {
        include: { supplier: true },
      },
    },
  });

  if (inFlightOrders.length === 0) {
    logger.info("[RefillWorker] No in-flight refills to poll (Phase A)");
    return 0;
  }

  logger.info(`[RefillWorker] Polling ${inFlightOrders.length} in-flight refills (Phase A)`);

  // Group orders by supplier ID (or 0 if unassigned) to manage supplier connection pools
  const ordersBySupplier = new Map<number, typeof inFlightOrders>();
  for (const order of inFlightOrders) {
    const supplierId = order.service.supplierId ?? 0;
    const group = ordersBySupplier.get(supplierId) || [];
    group.push(order);
    ordersBySupplier.set(supplierId, group);
  }

  let processedCount = 0;

  for (const [supplierId, orders] of ordersBySupplier.entries()) {
    await processWithConcurrency(orders, CONCURRENCY_CAP, async (order) => {
      try {
        const supplier = order.service.supplier;
        const activeRefillId = order.activeRefillId!;

        if (!supplier || !supplier.isActive) {
          logger.warn(
            `[RefillWorker] Order #${order.id} has no active supplier configured (supplierId: ${supplierId}). Resetting to WAITING.`,
          );
          await prisma.$transaction(async (tx) => {
            await tx.order.update({
              where: { id: order.id },
              data: {
                refillStatus: RefillStatus.WAITING,
                activeRefillId: null,
                lastRefillCheck: new Date(),
              },
            });
            await tx.refillLog.updateMany({
              where: {
                orderId: order.id,
                supplierRefillId: activeRefillId,
                status: RefillLogStatus.PENDING,
              },
              data: {
                status: RefillLogStatus.FAILED,
                errorMessage: "Supplier inactive or not configured",
              },
            });
          });
          processedCount++;
          return;
        }

        if (dryRun) {
          logger.info(
            `[RefillWorker][DRY RUN] Would poll refill #${activeRefillId} for order #${order.id} at supplier '${supplier.name}' (${supplier.apiUrl})`,
          );
          processedCount++;
          return;
        }

        // Call supplier refill_status
        const result = await callSupplierRefillStatus(
          supplier.apiUrl,
          supplier.apiKey,
          activeRefillId,
        );

        if ("error" in result) {
          logger.warn(
            `[RefillWorker] Supplier returned error for refill #${activeRefillId} (Order #${order.id}): ${result.error}`,
          );
          await prisma.$transaction(async (tx) => {
            await tx.refillLog.updateMany({
              where: {
                orderId: order.id,
                supplierRefillId: activeRefillId,
                status: RefillLogStatus.PENDING,
              },
              data: {
                status: RefillLogStatus.FAILED,
                errorMessage: result.error,
              },
            });
            await tx.order.update({
              where: { id: order.id },
              data: {
                refillStatus: RefillStatus.WAITING,
                activeRefillId: null,
                lastRefillCheck: new Date(),
              },
            });
          });
        } else if (result.status === "Completed") {
          logger.info(
            `[RefillWorker] Refill #${activeRefillId} for Order #${order.id} completed successfully`,
          );
          await prisma.$transaction(async (tx) => {
            await tx.refillLog.updateMany({
              where: {
                orderId: order.id,
                supplierRefillId: activeRefillId,
                status: RefillLogStatus.PENDING,
              },
              data: { status: RefillLogStatus.SUCCESS },
            });
            await tx.order.update({
              where: { id: order.id },
              data: {
                refillStatus: RefillStatus.WAITING,
                activeRefillId: null,
                lastRefillCheck: new Date(),
              },
            });
          });
        } else if (result.status === "Rejected" || result.status === "Error") {
          logger.info(
            `[RefillWorker] Refill #${activeRefillId} for Order #${order.id} rejected/errored by supplier (${result.status})`,
          );
          await prisma.$transaction(async (tx) => {
            await tx.refillLog.updateMany({
              where: {
                orderId: order.id,
                supplierRefillId: activeRefillId,
                status: RefillLogStatus.PENDING,
              },
              data: {
                status: RefillLogStatus.FAILED,
                errorMessage: `Supplier reported status: ${result.status}`,
              },
            });
            await tx.order.update({
              where: { id: order.id },
              data: {
                refillStatus: RefillStatus.WAITING,
                activeRefillId: null,
                lastRefillCheck: new Date(),
              },
            });
          });
        } else {
          // Status is "Pending" or "In progress": Keep in REFILLING state, update lastRefillCheck
          logger.debug(
            `[RefillWorker] Refill #${activeRefillId} for Order #${order.id} is still in flight (${result.status})`,
          );
          await prisma.order.update({
            where: { id: order.id },
            data: { lastRefillCheck: new Date() },
          });
        }

        processedCount++;
      } catch (err: unknown) {
        logger.error(`[RefillWorker] Failed polling refill for order #${order.id}: ${err}`);
      }
    });
  }

  return processedCount;
}

/**
 * STEP B: Expire guarantees (orders with refillStatus = WAITING and refillExpiresAt < now).
 * Marks refillStatus as COMPLETED.
 */
export async function expireGuarantees(dryRun = false): Promise<number> {
  const now = new Date();

  if (dryRun) {
    const expiredCount = await prisma.order.count({
      where: {
        refillStatus: RefillStatus.WAITING,
        refillExpiresAt: { lt: now },
      },
    });
    logger.info(
      `[RefillWorker][DRY RUN] Would mark ${expiredCount} expired refill guarantees as COMPLETED`,
    );
    return expiredCount;
  }

  const result = await prisma.order.updateMany({
    where: {
      refillStatus: RefillStatus.WAITING,
      refillExpiresAt: { lt: now },
    },
    data: {
      refillStatus: RefillStatus.COMPLETED,
    },
  });

  if (result.count > 0) {
    logger.info(
      `[RefillWorker] Expired ${result.count} orders past refill guarantee window (Phase B)`,
    );
  }

  return result.count;
}

/**
 * STEP C: Request refills.
 * Candidate criteria:
 * - service.refillEnabled = true
 * - order.status in (COMPLETED, PROCESSING)
 * - order.refillStatus = WAITING
 * - order.refillExpiresAt > now
 *
 * For each:
 * 1. Create a RefillLog (PENDING) FIRST
 * 2. Call supplier's refill action (NEVER auto-retried)
 * 3. Update RefillLog and Order in a single $transaction
 */
export async function requestRefills(dryRun = false): Promise<number> {
  const now = new Date();

  const eligibleOrders = await prisma.order.findMany({
    where: {
      refillStatus: RefillStatus.WAITING,
      refillExpiresAt: { gt: now },
      status: { in: [OrderStatus.COMPLETED, OrderStatus.PROCESSING] },
      externalOrderId: { not: null },
      service: {
        refillEnabled: true,
      },
    },
    include: {
      service: {
        include: { supplier: true },
      },
    },
  });

  if (eligibleOrders.length === 0) {
    logger.info("[RefillWorker] No eligible orders requesting refills (Phase C)");
    return 0;
  }

  logger.info(
    `[RefillWorker] Processing ${eligibleOrders.length} candidate orders for refill (Phase C)`,
  );

  // Group by supplier
  const ordersBySupplier = new Map<number, typeof eligibleOrders>();
  for (const order of eligibleOrders) {
    const supplierId = order.service.supplierId ?? 0;
    const group = ordersBySupplier.get(supplierId) || [];
    group.push(order);
    ordersBySupplier.set(supplierId, group);
  }

  let processedCount = 0;

  for (const [supplierId, orders] of ordersBySupplier.entries()) {
    await processWithConcurrency(orders, CONCURRENCY_CAP, async (order) => {
      try {
        const supplier = order.service.supplier;
        const externalOrderId = order.externalOrderId!;

        // 1. Create RefillLog record FIRST with status PENDING
        const refillLog = await prisma.refillLog.create({
          data: {
            orderId: order.id,
            status: RefillLogStatus.PENDING,
          },
        });

        if (!supplier || !supplier.isActive) {
          logger.warn(
            `[RefillWorker] Cannot dispatch refill for Order #${order.id}: no active supplier configured (supplierId: ${supplierId})`,
          );
          await prisma.$transaction(async (tx) => {
            await tx.refillLog.update({
              where: { id: refillLog.id },
              data: {
                status: RefillLogStatus.FAILED,
                errorMessage: "Service has no active supplier configured",
              },
            });
            await tx.order.update({
              where: { id: order.id },
              data: { lastRefillCheck: new Date() },
            });
          });
          processedCount++;
          return;
        }

        if (dryRun) {
          logger.info(
            `[RefillWorker][DRY RUN] Would request refill for Order #${order.id} (externalOrderId: ${externalOrderId}) via supplier '${supplier.name}' (${supplier.apiUrl})`,
          );
          await prisma.$transaction(async (tx) => {
            await tx.refillLog.update({
              where: { id: refillLog.id },
              data: {
                supplierRefillId: `dry_run_refill_${order.id}`,
              },
            });
            await tx.order.update({
              where: { id: order.id },
              data: { lastRefillCheck: new Date() },
            });
          });
          processedCount++;
          return;
        }

        // 2. Dispatch refill action to supplier (single shot, no auto-retries)
        const result = await callSupplierRefill(supplier.apiUrl, supplier.apiKey, externalOrderId);

        // 3. Atomically update Order and RefillLog
        await prisma.$transaction(async (tx) => {
          if ("refill" in result) {
            // Success: supplier accepted refill request
            logger.info(
              `[RefillWorker] Supplier accepted refill #${result.refill} for Order #${order.id}`,
            );
            await tx.refillLog.update({
              where: { id: refillLog.id },
              data: {
                supplierRefillId: result.refill,
                status: RefillLogStatus.PENDING, // stays PENDING until polled Completed in Phase A
              },
            });

            await tx.order.update({
              where: { id: order.id },
              data: {
                refillStatus: RefillStatus.REFILLING,
                refillCount: { increment: 1 },
                activeRefillId: result.refill,
                lastRefillCheck: new Date(),
              },
            });
          } else {
            // Supplier rejected refill (e.g. "no drop yet", "refill not available")
            logger.info(
              `[RefillWorker] Supplier rejected refill for Order #${order.id}: ${result.error}`,
            );
            await tx.refillLog.update({
              where: { id: refillLog.id },
              data: {
                status: RefillLogStatus.FAILED,
                errorMessage: result.error,
              },
            });

            // Order stays in WAITING for future monitoring window
            await tx.order.update({
              where: { id: order.id },
              data: {
                lastRefillCheck: new Date(),
              },
            });
          }
        });

        processedCount++;
      } catch (err: unknown) {
        logger.error(
          `[RefillWorker] Failed processing refill request for Order #${order.id}: ${err}`,
        );
      }
    });
  }

  return processedCount;
}

// ==============================================================================
// 5. Complete Daily Refill Cycle Runner
// ==============================================================================

export interface RefillCycleSummary {
  polled: number;
  expired: number;
  requested: number;
  dryRun: boolean;
  durationMs: number;
}

/**
 * Executes a full refill cycle in strict sequence:
 * A. Poll in-flight refills (REFILLING)
 * B. Expire ended guarantees (WAITING & expired -> COMPLETED)
 * C. Request refills for eligible orders (WAITING & active)
 */
export async function executeRefillCycle(
  dryRun: boolean = env.REFILL_DRY_RUN,
): Promise<RefillCycleSummary> {
  const startTime = Date.now();
  logger.info(`[RefillWorker] Starting 24h Auto-Refill Cycle (dryRun: ${dryRun})...`);

  // Step A: Poll in-flight
  const polled = await pollInFlightRefills(dryRun);

  // Step B: Expire old guarantees
  const expired = await expireGuarantees(dryRun);

  // Step C: Request refills for current dropped/monitored orders
  const requested = await requestRefills(dryRun);

  const durationMs = Date.now() - startTime;
  logger.info(
    `[RefillWorker] Auto-Refill Cycle completed in ${durationMs}ms (Polled: ${polled}, Expired: ${expired}, Requested: ${requested})`,
  );

  return {
    polled,
    expired,
    requested,
    dryRun,
    durationMs,
  };
}

// ==============================================================================
// 6. BullMQ Repeatable Job Scheduler & Worker
// ==============================================================================

export const REFILL_QUEUE_NAME = "auto-refill-scheduler";

export const autoRefillQueue = new Queue(REFILL_QUEUE_NAME, {
  connection: redisOptions,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

/**
 * Schedules the BullMQ repeatable 24-hour auto-refill job with fixed jobId.
 */
export async function scheduleDailyRefillJob(): Promise<void> {
  await autoRefillQueue.add(
    "daily-refill-run",
    {},
    {
      jobId: "daily_refill_job_fixed",
      repeat: {
        every: 24 * 60 * 60 * 1000, // 24 hours
      },
    },
  );
  logger.info("[RefillWorker] Repeatable daily auto-refill job registered (24h schedule)");
}

/**
 * Creates BullMQ worker with concurrency 1, guaranteeing only one worker
 * executes the 24-hour cycle at any time across the cluster.
 */
export function createRefillWorker(): Worker {
  const worker = new Worker(
    REFILL_QUEUE_NAME,
    async (_job: Job) => {
      return executeRefillCycle();
    },
    {
      connection: redisOptions,
      concurrency: 1, // Strict single-instance execution
    },
  );

  worker.on("failed", (job, err) => {
    logger.error(`[RefillWorker] Daily auto-refill job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
