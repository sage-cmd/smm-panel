import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { app } from "../../app";
import { prisma } from "../../lib/prisma";
import * as events from "../../jobs/events";
import {
  OrderStatus,
  Prisma,
  Role,
  TransactionStatus,
  TransactionType,
  RefillLogStatus,
} from "@prisma/client";

vi.mock("../../lib/prisma", () => {
  const mockTx = {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
    },
    transaction: {
      create: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    refillLog: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    fulfillmentJob: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    dripFeedBatch: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  };

  return {
    prisma: {
      ...mockTx,
      $connect: vi.fn(),
      $disconnect: vi.fn(),
      $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
      $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    },
    isPrismaHealthy: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../../lib/redis", () => ({
  isRedisHealthy: vi.fn().mockResolvedValue(true),
  disconnectRedis: vi.fn(),
  getRedisClient: vi.fn(),
  redisOptions: {},
}));

vi.mock("../../jobs/queues", () => ({
  enqueueOrderFulfillment: vi.fn().mockResolvedValue(undefined),
  enqueueDripFeedBatch: vi.fn().mockResolvedValue(undefined),
  closeQueues: vi.fn().mockResolvedValue(undefined),
  QUEUE_NAMES: {
    ORDER_FULFILLMENT: "order-fulfillment",
    DRIP_FEED: "drip-feed-scheduler",
    WEBHOOK_DELIVERY: "webhook-delivery",
  },
}));

vi.mock("../../jobs/events", () => ({
  emitOrderEvent: vi.fn().mockResolvedValue(undefined),
}));

describe("Admin Users, Orders & Stats APIs (/api/v1/admin)", () => {
  const adminApiKey = "smm_admin_key_master";
  const adminKeyHash = crypto.createHash("sha256").update(adminApiKey).digest("hex");

  const mockAdminUser = {
    id: "a0000000-0000-4000-8000-000000000001",
    email: "admin@example.com",
    role: Role.ADMIN,
    isActive: true,
    balance: new Prisma.Decimal("1000.000000"),
    currency: "USD",
  };

  const targetUserId = "b0000000-0000-4000-8000-000000000002";
  const mockTargetUser = {
    id: targetUserId,
    email: "target@customer.com",
    role: Role.USER,
    isActive: true,
    balance: new Prisma.Decimal("100.000000"),
    currency: "USD",
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { orders: 5, transactions: 10 },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default API key lookup
    (vi.mocked(prisma.apiKey.findUnique) as any).mockImplementation((args: any) => {
      if (args.where.keyHash === adminKeyHash) {
        return Promise.resolve({
          id: "key-1",
          userId: mockAdminUser.id,
          keyHash: adminKeyHash,
          isActive: true,
          user: mockAdminUser,
        } as any);
      }
      return Promise.resolve(null);
    });

    // Default User lookup in adminAuthMiddleware
    (vi.mocked(prisma.user.findUnique) as any).mockImplementation((args: any) => {
      if (args.where.id === mockAdminUser.id) {
        return Promise.resolve(mockAdminUser as any);
      }
      if (args.where.id === targetUserId) {
        return Promise.resolve(mockTargetUser as any);
      }
      return Promise.resolve(null);
    });
  });

  // ============================================================================
  // Users APIs
  // ============================================================================

  describe("GET /api/v1/admin/users", () => {
    it("should return paginated list of users and omit passwordHash", async () => {
      vi.mocked(prisma.user.count).mockResolvedValue(1);
      vi.mocked(prisma.user.findMany).mockResolvedValue([mockTargetUser as any]);

      const res = await request(app)
        .get("/api/v1/admin/users?page=1&limit=20&search=customer")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].email).toBe("target@customer.com");
      expect(res.body.data[0].balance).toBe("100.000000");
      expect(res.body.data[0].passwordHash).toBeUndefined();
      expect(res.body.meta).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it("should support minBalance and maxBalance range query", async () => {
      vi.mocked(prisma.user.count).mockResolvedValue(0);
      vi.mocked(prisma.user.findMany).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/v1/admin/users?minBalance=50&maxBalance=200")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(200);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            balance: {
              gte: new Prisma.Decimal("50"),
              lte: new Prisma.Decimal("200"),
            },
          }),
        }),
      );
    });
  });

  describe("PATCH /api/v1/admin/users/:id/balance", () => {
    it("should credit user balance and record ADMIN_CREDIT transaction with balance snapshots", async () => {
      vi.mocked(prisma.user.update).mockResolvedValue({
        ...mockTargetUser,
        balance: new Prisma.Decimal("150.000000"),
      } as any);

      vi.mocked(prisma.transaction.create).mockResolvedValue({
        id: "tx-credit-1",
        type: TransactionType.ADMIN_CREDIT,
        amount: new Prisma.Decimal("50.000000"),
        balanceBefore: new Prisma.Decimal("100.000000"),
        balanceAfter: new Prisma.Decimal("150.000000"),
        createdAt: new Date(),
      } as any);

      const res = await request(app)
        .patch(`/api/v1/admin/users/${targetUserId}/balance`)
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({
          amount: "50.000000",
          reason: "Loyalty promotional credit bonus",
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.data.user.balance).toBe("150.000000");
      expect(res.body.data.transaction.type).toBe("ADMIN_CREDIT");
      expect(res.body.data.transaction.balanceBefore).toBe("100.000000");
      expect(res.body.data.transaction.balanceAfter).toBe("150.000000");

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: targetUserId },
        data: {
          balance: { increment: new Prisma.Decimal("50") },
        },
        select: expect.any(Object),
      });

      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: targetUserId,
          type: TransactionType.ADMIN_CREDIT,
          status: TransactionStatus.SUCCESS,
          balanceBefore: new Prisma.Decimal("100"),
          balanceAfter: new Prisma.Decimal("150"),
        }),
      });
    });

    it("should debit user balance and record ADMIN_DEBIT transaction", async () => {
      vi.mocked(prisma.user.update).mockResolvedValue({
        ...mockTargetUser,
        balance: new Prisma.Decimal("70.000000"),
      } as any);

      vi.mocked(prisma.transaction.create).mockResolvedValue({
        id: "tx-debit-1",
        type: TransactionType.ADMIN_DEBIT,
        amount: new Prisma.Decimal("30.000000"),
        balanceBefore: new Prisma.Decimal("100.000000"),
        balanceAfter: new Prisma.Decimal("70.000000"),
        createdAt: new Date(),
      } as any);

      const res = await request(app)
        .patch(`/api/v1/admin/users/${targetUserId}/balance`)
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({
          amount: "-30.000000",
          reason: "Chargeback recovery adjustment",
        });

      expect(res.status).toBe(200);
      expect(res.body.data.transaction.type).toBe("ADMIN_DEBIT");
      expect(res.body.data.transaction.amount).toBe("30.000000");

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: targetUserId },
        data: {
          balance: { decrement: new Prisma.Decimal("30") },
        },
        select: expect.any(Object),
      });
    });

    it("should reject debit when it would cause balance to drop below zero", async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${targetUserId}/balance`)
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({
          amount: "-150.000000", // current balance is 100
          reason: "Excessive penalty debit",
        });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("INSUFFICIENT_BALANCE");
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("should reject zero amount adjustment", async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${targetUserId}/balance`)
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({
          amount: "0",
          reason: "Zero adjustment test",
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("should return 404 for non-existent user", async () => {
      (vi.mocked(prisma.user.findUnique) as any).mockImplementation((args: any) => {
        if (args.where.id === mockAdminUser.id) return Promise.resolve(mockAdminUser as any);
        return Promise.resolve(null);
      });

      const res = await request(app)
        .patch("/api/v1/admin/users/00000000-0000-0000-0000-000000000000/balance")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({
          amount: "25.000000",
          reason: "Credit test",
        });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });

  describe("PATCH /api/v1/admin/users/:id/status", () => {
    it("should update user active status", async () => {
      vi.mocked(prisma.user.update).mockResolvedValue({
        ...mockTargetUser,
        isActive: false,
      } as any);

      const res = await request(app)
        .patch(`/api/v1/admin/users/${targetUserId}/status`)
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({ isActive: false });

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(false);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: targetUserId },
        data: { isActive: false },
        select: expect.any(Object),
      });
    });

    it("should prevent admin from banning themselves", async () => {
      const res = await request(app)
        .patch(`/api/v1/admin/users/${mockAdminUser.id}/status`)
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({ isActive: false });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("cannot modify their own active status");
    });

    it("should prevent admin from banning another admin", async () => {
      const anotherAdminId = "c0000000-0000-4000-8000-000000000003";
      (vi.mocked(prisma.user.findUnique) as any).mockImplementation((args: any) => {
        if (args.where.id === mockAdminUser.id) return Promise.resolve(mockAdminUser as any);
        if (args.where.id === anotherAdminId) {
          return Promise.resolve({
            id: anotherAdminId,
            email: "second_admin@example.com",
            role: Role.ADMIN,
            isActive: true,
          } as any);
        }
        return Promise.resolve(null);
      });

      const res = await request(app)
        .patch(`/api/v1/admin/users/${anotherAdminId}/status`)
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({ isActive: false });

      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain("another administrator");
    });
  });

  // ============================================================================
  // Orders APIs
  // ============================================================================

  describe("GET /api/v1/admin/orders", () => {
    it("should return paginated list of orders with service and user details", async () => {
      const mockOrder = {
        id: 50,
        userId: targetUserId,
        serviceId: 2,
        link: "https://tiktok.com/@user/video/1",
        quantity: 1000,
        totalCharge: new Prisma.Decimal("3.000000"),
        status: OrderStatus.PROCESSING,
        startCount: 100,
        remains: 400,
        runs: null,
        interval: null,
        externalOrderId: "ext-order-50",
        createdAt: new Date(),
        updatedAt: new Date(),
        service: { id: 2, name: "TikTok Likes", category: "TikTok" },
        user: { id: targetUserId, email: "target@customer.com" },
      };

      vi.mocked(prisma.order.count).mockResolvedValue(1);
      vi.mocked(prisma.order.findMany).mockResolvedValue([mockOrder as any]);

      const res = await request(app)
        .get("/api/v1/admin/orders?page=1&limit=20&status=PROCESSING")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(50);
      expect(res.body.data[0].totalCharge).toBe("3.000000");
      expect(res.body.data[0].serviceName).toBe("TikTok Likes");
      expect(res.body.data[0].userEmail).toBe("target@customer.com");
      expect(res.body.meta.total).toBe(1);
    });
  });

  describe("PATCH /api/v1/admin/orders/:id/status", () => {
    const mockPendingOrder = {
      id: 60,
      userId: targetUserId,
      serviceId: 1,
      link: "https://instagram.com/test",
      quantity: 1000,
      totalCharge: new Prisma.Decimal("2.000000"),
      status: OrderStatus.PENDING,
      remains: 1000,
      startCount: null,
      user: {
        id: targetUserId,
        email: "target@customer.com",
        balance: new Prisma.Decimal("50.000000"),
      },
      service: { id: 1, name: "Instagram Followers", category: "Instagram" },
      fulfillmentJob: { id: "job-1", status: "PENDING" },
    };

    it("should reject status changes out of terminal states (COMPLETED / CANCELED)", async () => {
      vi.mocked(prisma.order.findUnique).mockResolvedValue({
        ...mockPendingOrder,
        status: OrderStatus.COMPLETED,
      } as any);

      const res = await request(app)
        .patch("/api/v1/admin/orders/60/status")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({ status: OrderStatus.PROCESSING });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("TERMINAL_ORDER_STATE");
    });

    it("should cancel order, calculate proportional refund, increment balance, and emit event", async () => {
      // Order with 600 remains out of 1000 -> refund is (600 / 1000) * 2.00 = 1.20
      const partialOrder = {
        ...mockPendingOrder,
        remains: 600,
        status: OrderStatus.PROCESSING,
      };

      vi.mocked(prisma.order.findUnique).mockResolvedValue(partialOrder as any);
      vi.mocked(prisma.user.findUniqueOrThrow).mockResolvedValue({
        id: targetUserId,
        balance: new Prisma.Decimal("50.000000"),
      } as any);

      vi.mocked(prisma.order.findUniqueOrThrow).mockResolvedValue({
        ...partialOrder,
        status: OrderStatus.CANCELED,
      } as any);

      const res = await request(app)
        .patch("/api/v1/admin/orders/60/status")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({ status: OrderStatus.CANCELED });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.data.status).toBe("CANCELED");
      expect(res.body.data.refundAmount).toBe("1.200000");

      // Verify balance credited
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: targetUserId },
        data: {
          balance: { increment: new Prisma.Decimal("1.2") },
        },
      });

      // Verify transaction created
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: targetUserId,
          orderId: 60,
          amount: new Prisma.Decimal("1.2"),
          type: TransactionType.REFUND,
          status: TransactionStatus.SUCCESS,
        }),
      });

      // Verify event emitted
      expect(events.emitOrderEvent).toHaveBeenCalledWith(
        "order.canceled",
        expect.objectContaining({ id: 60, status: "CANCELED" }),
      );
    });

    it("should transition order to COMPLETED, zero remains, and emit order.completed", async () => {
      vi.mocked(prisma.order.findUnique).mockResolvedValue(mockPendingOrder as any);
      vi.mocked(prisma.order.update).mockResolvedValue({
        ...mockPendingOrder,
        status: OrderStatus.COMPLETED,
        remains: 0,
      } as any);

      const res = await request(app)
        .patch("/api/v1/admin/orders/60/status")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({ status: OrderStatus.COMPLETED });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("COMPLETED");
      expect(res.body.data.remains).toBe(0);

      expect(events.emitOrderEvent).toHaveBeenCalledWith(
        "order.completed",
        expect.objectContaining({ id: 60, status: "COMPLETED", remains: 0 }),
      );
    });
  });

  // ============================================================================
  // Stats API
  // ============================================================================

  describe("GET /api/v1/admin/stats", () => {
    it("should return comprehensive platform statistics in parallel", async () => {
      vi.mocked(prisma.user.count).mockResolvedValue(120);
      vi.mocked(prisma.order.count).mockResolvedValue(450);

      // Total revenue
      vi.mocked(prisma.transaction.aggregate)
        .mockResolvedValueOnce({
          _sum: { amount: new Prisma.Decimal("15200.500000") },
        } as any)
        // Today's revenue
        .mockResolvedValueOnce({
          _sum: { amount: new Prisma.Decimal("850.250000") },
        } as any);

      // Orders by status
      vi.mocked(prisma.order.groupBy).mockResolvedValue([
        { status: OrderStatus.COMPLETED, _count: { id: 300 } },
        { status: OrderStatus.PROCESSING, _count: { id: 100 } },
        { status: OrderStatus.CANCELED, _count: { id: 50 } },
      ] as any);

      const res = await request(app)
        .get("/api/v1/admin/stats")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.data.users.total).toBe(120);
      expect(res.body.data.orders.total).toBe(450);
      expect(res.body.data.revenue.total).toBe("15200.500000");
      expect(res.body.data.revenue.today).toBe("850.250000");

      // Check all statuses are populated with 0 for unreturned ones
      expect(res.body.data.orders.byStatus).toEqual({
        PENDING: 0,
        PROCESSING: 100,
        COMPLETED: 300,
        CANCELED: 50,
        PARTIAL: 0,
      });
    });
  });

  // ============================================================================
  // Refill Logs API
  // ============================================================================

  describe("GET /api/v1/admin/refill-logs", () => {
    const mockRefillLog = {
      id: "refill-log-uuid-101",
      orderId: 60,
      supplierRefillId: "sup_ref_999",
      status: RefillLogStatus.SUCCESS,
      errorMessage: null,
      previousCount: 100,
      newCount: 200,
      droppedAmount: 50,
      createdAt: new Date(),
      updatedAt: new Date(),
      order: {
        id: 60,
        userId: "b0000000-0000-4000-8000-000000000002",
        serviceId: 1,
        externalOrderId: "ext-order-60",
        status: OrderStatus.COMPLETED,
        refillStatus: "WAITING",
        service: {
          id: 1,
          name: "Instagram Followers",
          supplierId: 1,
        },
      },
    };

    it("should return paginated list of refill logs with metadata", async () => {
      vi.mocked(prisma.refillLog.count).mockResolvedValue(1);
      vi.mocked(prisma.refillLog.findMany).mockResolvedValue([mockRefillLog as any]);

      const res = await request(app)
        .get("/api/v1/admin/refill-logs?page=1&limit=20")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe("refill-log-uuid-101");
      expect(res.body.data[0].orderId).toBe(60);
      expect(res.body.data[0].supplierRefillId).toBe("sup_ref_999");
      expect(res.body.data[0].status).toBe("SUCCESS");
      expect(res.body.data[0].order.serviceName).toBe("Instagram Followers");
      expect(res.body.meta).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
    });

    it("should filter refill logs by orderId and status", async () => {
      vi.mocked(prisma.refillLog.count).mockResolvedValue(1);
      vi.mocked(prisma.refillLog.findMany).mockResolvedValue([mockRefillLog as any]);

      const res = await request(app)
        .get("/api/v1/admin/refill-logs?orderId=60&status=SUCCESS")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(200);
      expect(prisma.refillLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            orderId: 60,
            status: "SUCCESS",
          },
        }),
      );
    });

    it("should reject invalid orderId or status format", async () => {
      const res = await request(app)
        .get("/api/v1/admin/refill-logs?orderId=not-a-number")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(400);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });
});
