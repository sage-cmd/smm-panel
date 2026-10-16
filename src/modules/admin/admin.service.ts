import { Prisma, OrderStatus, Role, TransactionStatus, TransactionType } from "@prisma/client";
import Decimal from "decimal.js";
import { prisma } from "../../lib/prisma";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../errors/AppError";
import { formatMonetaryAmount } from "../financial/calculator";
import { emitOrderEvent } from "../../jobs/events";
import {
  AdminCreateServiceInput,
  AdminGetServicesQuery,
  AdminUpdateServiceInput,
  AdminGetUsersQuery,
  AdminAdjustBalanceInput,
  AdminUpdateUserStatusInput,
  AdminGetOrdersQuery,
  AdminUpdateOrderStatusInput,
  AdminGetRefillLogsQuery,
} from "./admin.schemas";

export class AdminService {
  // ==============================================================================
  // Services
  // ==============================================================================

  /**
   * POST /api/v1/admin/services
   * Creates a new service in the catalog.
   */
  public async createService(input: AdminCreateServiceInput) {
    const service = await prisma.service.create({
      data: {
        name: input.name,
        category: input.category,
        ratePer1000: new Prisma.Decimal(input.ratePer1000.toString()),
        minQuantity: input.minQuantity,
        maxQuantity: input.maxQuantity,
        type: input.type,
        description: input.description,
        supportsDripfeed: input.supportsDripfeed,
        refillEnabled: input.refillEnabled,
        refillPeriodDays: input.refillPeriodDays,
        supplierId: input.supplierId,
        supplierServiceId: input.supplierServiceId,
        isActive: true,
      },
    });

    return {
      id: service.id,
      name: service.name,
      category: service.category,
      ratePer1000: formatMonetaryAmount(service.ratePer1000, 6),
      minQuantity: service.minQuantity,
      maxQuantity: service.maxQuantity,
      type: service.type,
      description: service.description,
      supportsDripfeed: service.supportsDripfeed,
      refillEnabled: service.refillEnabled,
      refillPeriodDays: service.refillPeriodDays,
      supplierId: service.supplierId,
      supplierServiceId: service.supplierServiceId,
      isActive: service.isActive,
      createdAt: service.createdAt,
      updatedAt: service.updatedAt,
    };
  }

  /**
   * GET /api/v1/admin/services
   * Returns paginated services list with optional category and isActive filtering.
   * Uses stable ordering (createdAt desc).
   */
  public async getServices(query: AdminGetServicesQuery) {
    const where: Prisma.ServiceWhereInput = {
      ...(query.category ? { category: { equals: query.category, mode: "insensitive" } } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, services] = await Promise.all([
      prisma.service.count({ where }),
      prisma.service.findMany({
        where,
        skip,
        take: query.limit,
        orderBy: { createdAt: "desc" },
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
      refillEnabled: s.refillEnabled,
      refillPeriodDays: s.refillPeriodDays,
      supplierId: s.supplierId,
      supplierServiceId: s.supplierServiceId,
      isActive: s.isActive,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    return {
      data: formattedServices,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit) || 1,
      },
    };
  }

  /**
   * PATCH /api/v1/admin/services/:id
   * Partial update for a service.
   * Re-validates minQuantity <= maxQuantity against merged existing values.
   */
  public async updateService(serviceId: number, input: AdminUpdateServiceInput) {
    const existing = await prisma.service.findUnique({
      where: { id: serviceId },
    });

    if (!existing) {
      throw new NotFoundError(`Service #${serviceId} not found`);
    }

    // Re-validate min <= max against merged values
    const mergedMin = input.minQuantity ?? existing.minQuantity;
    const mergedMax = input.maxQuantity ?? existing.maxQuantity;

    if (mergedMin > mergedMax) {
      throw new BadRequestError(
        `minQuantity (${mergedMin}) cannot be greater than maxQuantity (${mergedMax})`,
      );
    }

    // Re-validate refillEnabled and refillPeriodDays against merged values
    const mergedRefillEnabled = input.refillEnabled ?? existing.refillEnabled;
    const mergedRefillPeriodDays =
      input.refillPeriodDays !== undefined ? input.refillPeriodDays : existing.refillPeriodDays;

    if (mergedRefillEnabled && (!mergedRefillPeriodDays || mergedRefillPeriodDays <= 0)) {
      throw new BadRequestError(
        "refillPeriodDays is required and must be greater than 0 when refillEnabled is true",
      );
    }

    const updateData: Prisma.ServiceUpdateInput = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.ratePer1000 !== undefined && {
        ratePer1000: new Prisma.Decimal(input.ratePer1000.toString()),
      }),
      ...(input.minQuantity !== undefined && { minQuantity: input.minQuantity }),
      ...(input.maxQuantity !== undefined && { maxQuantity: input.maxQuantity }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.supportsDripfeed !== undefined && {
        supportsDripfeed: input.supportsDripfeed,
      }),
      ...(input.refillEnabled !== undefined && { refillEnabled: input.refillEnabled }),
      ...(input.refillPeriodDays !== undefined && { refillPeriodDays: input.refillPeriodDays }),
      ...(input.supplierId !== undefined && {
        supplier: input.supplierId ? { connect: { id: input.supplierId } } : { disconnect: true },
      }),
      ...(input.supplierServiceId !== undefined && {
        supplierServiceId: input.supplierServiceId,
      }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    };

    const updated = await prisma.service.update({
      where: { id: serviceId },
      data: updateData,
    });

    return {
      id: updated.id,
      name: updated.name,
      category: updated.category,
      ratePer1000: formatMonetaryAmount(updated.ratePer1000, 6),
      minQuantity: updated.minQuantity,
      maxQuantity: updated.maxQuantity,
      type: updated.type,
      description: updated.description,
      supportsDripfeed: updated.supportsDripfeed,
      refillEnabled: updated.refillEnabled,
      refillPeriodDays: updated.refillPeriodDays,
      supplierId: updated.supplierId,
      supplierServiceId: updated.supplierServiceId,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  /**
   * DELETE /api/v1/admin/services/:id
   * Performs soft deletion by setting isActive to false.
   */
  public async deleteService(serviceId: number) {
    const existing = await prisma.service.findUnique({
      where: { id: serviceId },
    });

    if (!existing) {
      throw new NotFoundError(`Service #${serviceId} not found`);
    }

    const updated = await prisma.service.update({
      where: { id: serviceId },
      data: { isActive: false },
    });

    return {
      id: updated.id,
      name: updated.name,
      isActive: updated.isActive,
    };
  }

  // ==============================================================================
  // Users
  // ==============================================================================

  /**
   * GET /api/v1/admin/users
   * Paginated user list with case-insensitive search and balance range filters.
   * Explicit select excludes password hashes and sensitive API key secrets.
   */
  public async getUsers(query: AdminGetUsersQuery) {
    const searchFilter = query.email || query.search;
    const where: Prisma.UserWhereInput = {
      ...(searchFilter ? { email: { contains: searchFilter, mode: "insensitive" } } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.minBalance || query.maxBalance
        ? {
            balance: {
              ...(query.minBalance ? { gte: new Prisma.Decimal(query.minBalance.toString()) } : {}),
              ...(query.maxBalance ? { lte: new Prisma.Decimal(query.maxBalance.toString()) } : {}),
            },
          }
        : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: query.limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          role: true,
          isActive: true,
          balance: true,
          currency: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              orders: true,
              transactions: true,
            },
          },
        },
      }),
    ]);

    const formattedUsers = users.map((u) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      balance: formatMonetaryAmount(u.balance, 6),
      currency: u.currency,
      ordersCount: u._count.orders,
      transactionsCount: u._count.transactions,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    }));

    return {
      data: formattedUsers,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit) || 1,
      },
    };
  }

  /**
   * PATCH /api/v1/admin/users/:id/balance
   * Applies manual balance adjustment (credit or debit) within an atomic database transaction.
   * Rejects adjustments that would cause the balance to become negative.
   * Records a distinct audit Transaction with before/after balance snapshots.
   */
  public async adjustUserBalance(
    adminUserId: string,
    targetUserId: string,
    input: AdminAdjustBalanceInput,
  ) {
    return await prisma.$transaction(async (tx) => {
      // 1. Fetch target user
      const targetUser = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, email: true, balance: true, currency: true, isActive: true },
      });

      if (!targetUser) {
        throw new NotFoundError(`User #${targetUserId} not found`);
      }

      const balanceBefore = new Decimal(targetUser.balance.toString());
      const adjustmentAmount = input.amount; // Decimal.js (+ credit, - debit)
      const balanceAfter = balanceBefore.plus(adjustmentAmount);

      // Invariant: Balance must never become negative
      if (balanceAfter.isNegative()) {
        throw new BadRequestError(
          `Adjustment of ${adjustmentAmount.toString()} would cause balance to drop below zero (current: ${balanceBefore.toString()})`,
          "INSUFFICIENT_BALANCE",
        );
      }

      const isCredit = adjustmentAmount.isPositive();
      const absAmount = adjustmentAmount.abs();

      // 2. Perform atomic increment/decrement on user balance
      const updatedUser = await tx.user.update({
        where: { id: targetUserId },
        data: {
          balance: isCredit
            ? { increment: new Prisma.Decimal(absAmount.toString()) }
            : { decrement: new Prisma.Decimal(absAmount.toString()) },
        },
        select: {
          id: true,
          email: true,
          balance: true,
          currency: true,
          role: true,
          isActive: true,
          updatedAt: true,
        },
      });

      // 3. Persist financial ledger transaction with audit balance snapshots
      const transactionType = isCredit ? TransactionType.ADMIN_CREDIT : TransactionType.ADMIN_DEBIT;

      const transaction = await tx.transaction.create({
        data: {
          userId: targetUserId,
          amount: new Prisma.Decimal(absAmount.toString()),
          balanceBefore: new Prisma.Decimal(balanceBefore.toString()),
          balanceAfter: new Prisma.Decimal(balanceAfter.toString()),
          type: transactionType,
          status: TransactionStatus.SUCCESS,
          description: `Admin adjustment by ${adminUserId}: ${input.reason}`,
        },
      });

      return {
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          balance: formatMonetaryAmount(updatedUser.balance, 6),
          currency: updatedUser.currency,
          isActive: updatedUser.isActive,
        },
        transaction: {
          id: transaction.id,
          type: transaction.type,
          amount: formatMonetaryAmount(transaction.amount, 6),
          balanceBefore: formatMonetaryAmount(transaction.balanceBefore!, 6),
          balanceAfter: formatMonetaryAmount(transaction.balanceAfter!, 6),
          reason: input.reason,
          createdAt: transaction.createdAt,
        },
      };
    });
  }

  /**
   * PATCH /api/v1/admin/users/:id/status
   * Bans or unbans a user account.
   * Enforces self-preservation: Admins cannot ban themselves or other admins.
   */
  public async updateUserStatus(
    adminUserId: string,
    targetUserId: string,
    input: AdminUpdateUserStatusInput,
  ) {
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, role: true, isActive: true },
    });

    if (!targetUser) {
      throw new NotFoundError(`User #${targetUserId} not found`);
    }

    // Admins cannot deactivate their own account
    if (adminUserId === targetUserId) {
      throw new BadRequestError("Administrators cannot modify their own active status");
    }

    // Admins cannot deactivate another admin
    if (targetUser.role === Role.ADMIN) {
      throw new ForbiddenError(
        "Administrators cannot modify the active status of another administrator",
      );
    }

    const updated = await prisma.user.update({
      where: { id: targetUserId },
      data: { isActive: input.isActive },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        updatedAt: true,
      },
    });

    return updated;
  }

  // ==============================================================================
  // Orders
  // ==============================================================================

  /**
   * GET /api/v1/admin/orders
   * Returns paginated orders list with user and service relations.
   */
  public async getOrders(query: AdminGetOrdersQuery) {
    const where: Prisma.OrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.serviceId ? { serviceId: query.serviceId } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        skip,
        take: query.limit,
        orderBy: { createdAt: "desc" },
        include: {
          service: {
            select: { id: true, name: true, category: true },
          },
          user: {
            select: { id: true, email: true },
          },
        },
      }),
    ]);

    const formattedOrders = orders.map((o) => ({
      id: o.id,
      userId: o.userId,
      userEmail: o.user.email,
      serviceId: o.serviceId,
      serviceName: o.service.name,
      serviceCategory: o.service.category,
      link: o.link,
      quantity: o.quantity,
      totalCharge: formatMonetaryAmount(o.totalCharge, 6),
      status: o.status,
      startCount: o.startCount,
      remains: o.remains,
      runs: o.runs,
      interval: o.interval,
      externalOrderId: o.externalOrderId,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }));

    return {
      data: formattedOrders,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit) || 1,
      },
    };
  }

  /**
   * PATCH /api/v1/admin/orders/:id/status
   * Updates an order's status.
   * Enforces that orders in terminal states (COMPLETED, CANCELED) cannot be transitioned.
   * On transition to CANCELED:
   *   - Atomically updates status in a conditional transaction
   *   - Calculates proportional refund: (remains / quantity) * totalCharge
   *   - Atomically credits user balance and writes a REFUND Transaction record
   *   - Dispatches order.canceled webhook event
   */
  public async updateOrderStatus(orderId: number, input: AdminUpdateOrderStatusInput) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        service: true,
        user: true,
        fulfillmentJob: true,
      },
    });

    if (!order) {
      throw new NotFoundError(`Order #${orderId} not found`);
    }

    // Enforce terminal state lock
    if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.CANCELED) {
      throw new BadRequestError(
        `Cannot change status of an order that has already reached terminal status (${order.status})`,
        "TERMINAL_ORDER_STATE",
      );
    }

    // Idempotent same-status check
    if (order.status === input.status) {
      return {
        id: order.id,
        status: order.status,
        remains: order.remains,
        refundAmount: "0.000000",
      };
    }

    // Handle CANCELED status with refund saga
    if (input.status === OrderStatus.CANCELED) {
      const remainsDecimal = new Decimal(order.remains);
      const quantityDecimal = new Decimal(order.quantity);
      const totalChargeDecimal = new Decimal(order.totalCharge.toString());

      // Proportional refund = (remains / quantity) * totalCharge
      const refundFraction = remainsDecimal.dividedBy(quantityDecimal);
      const refundAmount = totalChargeDecimal
        .times(refundFraction)
        .toDecimalPlaces(6, Decimal.ROUND_DOWN);

      const txResult = await prisma.$transaction(async (tx) => {
        // Atomic status transition with condition to prevent double refund
        const updatedRows = await tx.$executeRaw`
          UPDATE "orders"
          SET "status" = 'CANCELED', "updatedAt" = NOW()
          WHERE "id" = ${order.id} AND "status" NOT IN ('COMPLETED', 'CANCELED')
        `;

        if (updatedRows === 0) {
          throw new ConflictError(
            "Order was modified concurrently or already reached terminal state",
          );
        }

        // Cancel pending background fulfillment and drip batches
        await tx.fulfillmentJob.updateMany({
          where: { orderId: order.id, status: { notIn: ["COMPLETED", "FAILED"] } },
          data: { status: "FAILED", lastError: "Canceled by administrator" },
        });

        await tx.dripFeedBatch.updateMany({
          where: { orderId: order.id, status: "PENDING" },
          data: { status: "CANCELED" },
        });

        let balanceBefore = new Decimal(order.user.balance.toString());
        let balanceAfter = balanceBefore;

        // Apply refund if refundAmount is positive
        if (refundAmount.isPositive() && !refundAmount.isZero()) {
          balanceAfter = balanceBefore.plus(refundAmount);

          await tx.user.update({
            where: { id: order.userId },
            data: {
              balance: { increment: new Prisma.Decimal(refundAmount.toString()) },
            },
          });

          await tx.transaction.create({
            data: {
              userId: order.userId,
              orderId: order.id,
              amount: new Prisma.Decimal(refundAmount.toString()),
              type: TransactionType.REFUND,
              status: TransactionStatus.SUCCESS,
              description: `Admin cancellation refund for order #${order.id} (${order.remains}/${order.quantity} units remaining)`,
              balanceBefore: new Prisma.Decimal(balanceBefore.toString()),
              balanceAfter: new Prisma.Decimal(balanceAfter.toString()),
            },
          });
        }

        return {
          id: order.id,
          status: OrderStatus.CANCELED,
          remains: order.remains,
          refundAmount: formatMonetaryAmount(refundAmount, 6),
        };
      });

      // Emit webhook event
      await emitOrderEvent("order.canceled", {
        id: order.id,
        userId: order.userId,
        serviceId: order.serviceId,
        status: "CANCELED",
        remains: order.remains,
        startCount: order.startCount,
        totalCharge: order.totalCharge,
      });

      return txResult;
    }

    // Handle non-cancel transitions (COMPLETED, PROCESSING, PARTIAL)
    const newRemains = input.status === OrderStatus.COMPLETED ? 0 : order.remains;

    const updated = await prisma.$transaction(async (tx) => {
      const ord = await tx.order.update({
        where: { id: order.id },
        data: {
          status: input.status,
          remains: newRemains,
        },
      });

      if (input.status === OrderStatus.COMPLETED) {
        await tx.fulfillmentJob.updateMany({
          where: { orderId: order.id, status: { notIn: ["COMPLETED", "FAILED"] } },
          data: { status: "COMPLETED", processedAt: new Date() },
        });
      }

      return ord;
    });

    // Trigger webhook event
    const eventName =
      input.status === OrderStatus.COMPLETED
        ? "order.completed"
        : input.status === OrderStatus.PARTIAL
          ? "order.partial"
          : "order.processing";

    await emitOrderEvent(eventName, {
      id: updated.id,
      userId: updated.userId,
      serviceId: updated.serviceId,
      status: updated.status,
      remains: updated.remains,
      startCount: updated.startCount,
      totalCharge: updated.totalCharge,
    });

    return {
      id: updated.id,
      status: updated.status,
      remains: updated.remains,
      refundAmount: "0.000000",
    };
  }

  // ==============================================================================
  // Stats
  // ==============================================================================

  /**
   * GET /api/v1/admin/stats
   * Aggregates platform statistics in parallel:
   *   - total users
   *   - total orders
   *   - total revenue (sum of real successful DEPOSITs, excluding admin adjustments)
   *   - today's revenue (UTC day)
   *   - orders by status (guarantees every OrderStatus is present with 0 default)
   */
  public async getStats() {
    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);

    const [totalUsers, totalOrders, totalRevenueResult, todayRevenueResult, ordersByStatusGroups] =
      await Promise.all([
        // Total registered users
        prisma.user.count(),

        // Total orders placed
        prisma.order.count(),

        // Total revenue: only actual user DEPOSITs (excluding admin adjustments)
        prisma.transaction.aggregate({
          where: {
            type: TransactionType.DEPOSIT,
            status: TransactionStatus.SUCCESS,
          },
          _sum: { amount: true },
        }),

        // Today's revenue: DEPOSITs created since UTC 00:00:00 today
        prisma.transaction.aggregate({
          where: {
            type: TransactionType.DEPOSIT,
            status: TransactionStatus.SUCCESS,
            createdAt: { gte: startOfUtcDay },
          },
          _sum: { amount: true },
        }),

        // Orders grouped by status
        prisma.order.groupBy({
          by: ["status"],
          _count: { id: true },
        }),
      ]);

    // Build complete status map with 0 defaults for all enum states
    const ordersByStatus: Record<OrderStatus, number> = {
      [OrderStatus.PENDING]: 0,
      [OrderStatus.PROCESSING]: 0,
      [OrderStatus.COMPLETED]: 0,
      [OrderStatus.CANCELED]: 0,
      [OrderStatus.PARTIAL]: 0,
    };

    for (const group of ordersByStatusGroups) {
      ordersByStatus[group.status] = group._count.id;
    }

    const totalRevenueDecimal = totalRevenueResult._sum.amount ?? new Prisma.Decimal("0.000000");
    const todayRevenueDecimal = todayRevenueResult._sum.amount ?? new Prisma.Decimal("0.000000");

    return {
      users: {
        total: totalUsers,
      },
      orders: {
        total: totalOrders,
        byStatus: ordersByStatus,
      },
      revenue: {
        total: formatMonetaryAmount(totalRevenueDecimal, 6),
        today: formatMonetaryAmount(todayRevenueDecimal, 6),
        currency: "USD",
      },
    };
  }

  // ==============================================================================
  // Refill Logs
  // ==============================================================================

  /**
   * GET /api/v1/admin/refill-logs
   * Returns paginated refill logs with optional orderId & status filtering.
   * Uses stable ordering (createdAt desc).
   */
  public async getRefillLogs(query: AdminGetRefillLogsQuery) {
    const where: Prisma.RefillLogWhereInput = {
      ...(query.orderId !== undefined ? { orderId: query.orderId } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const skip = (query.page - 1) * query.limit;

    const [total, logs] = await Promise.all([
      prisma.refillLog.count({ where }),
      prisma.refillLog.findMany({
        where,
        skip,
        take: query.limit,
        orderBy: { createdAt: "desc" },
        include: {
          order: {
            select: {
              id: true,
              userId: true,
              serviceId: true,
              externalOrderId: true,
              status: true,
              refillStatus: true,
              service: {
                select: {
                  id: true,
                  name: true,
                  supplierId: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const formattedLogs = logs.map((log) => ({
      id: log.id,
      orderId: log.orderId,
      supplierRefillId: log.supplierRefillId,
      status: log.status,
      errorMessage: log.errorMessage,
      previousCount: log.previousCount,
      newCount: log.newCount,
      droppedAmount: log.droppedAmount,
      createdAt: log.createdAt,
      updatedAt: log.updatedAt,
      order: log.order
        ? {
            id: log.order.id,
            userId: log.order.userId,
            serviceId: log.order.serviceId,
            serviceName: log.order.service.name,
            externalOrderId: log.order.externalOrderId,
            orderStatus: log.order.status,
            refillStatus: log.order.refillStatus,
          }
        : null,
    }));

    return {
      data: formattedLogs,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit) || 1,
      },
    };
  }
}

export const adminService = new AdminService();
