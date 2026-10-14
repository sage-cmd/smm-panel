import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { app } from "../../app";
import { prisma } from "../../lib/prisma";
import { Prisma, Role } from "@prisma/client";

vi.mock("../../lib/prisma", () => {
  const mockPrisma = {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: vi.fn(),
    },
    service: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
  };

  return {
    prisma: mockPrisma,
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

describe("Admin Service Catalog APIs (/api/v1/admin/services)", () => {
  const adminApiKey = "smm_admin_secret_key_12345";
  const userApiKey = "smm_regular_user_key_67890";
  const adminKeyHash = crypto.createHash("sha256").update(adminApiKey).digest("hex");
  const userKeyHash = crypto.createHash("sha256").update(userApiKey).digest("hex");

  const mockAdminUser = {
    id: "admin-uuid-1",
    email: "admin@example.com",
    role: Role.ADMIN,
    isActive: true,
    balance: new Prisma.Decimal("500.000000"),
    currency: "USD",
  };

  const mockRegularUser = {
    id: "user-uuid-2",
    email: "user@example.com",
    role: Role.USER,
    isActive: true,
    balance: new Prisma.Decimal("50.000000"),
    currency: "USD",
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default API key mock setup
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
      if (args.where.keyHash === userKeyHash) {
        return Promise.resolve({
          id: "key-2",
          userId: mockRegularUser.id,
          keyHash: userKeyHash,
          isActive: true,
          user: mockRegularUser,
        } as any);
      }
      return Promise.resolve(null);
    });

    // Default fresh DB user lookup in adminAuthMiddleware
    (vi.mocked(prisma.user.findUnique) as any).mockImplementation((args: any) => {
      if (args.where.id === mockAdminUser.id) {
        return Promise.resolve(mockAdminUser as any);
      }
      if (args.where.id === mockRegularUser.id) {
        return Promise.resolve(mockRegularUser as any);
      }
      return Promise.resolve(null);
    });
  });

  describe("Admin Authorization Middleware", () => {
    it("should return 401 when unauthenticated", async () => {
      const res = await request(app).get("/api/v1/admin/services");

      expect(res.status).toBe(401);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    });

    it("should return 403 when authenticated user is not an ADMIN", async () => {
      const res = await request(app)
        .get("/api/v1/admin/services")
        .set("Authorization", `Bearer ${userApiKey}`);

      expect(res.status).toBe(403);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("should return 403 when admin account is deactivated (isActive = false)", async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
        ...mockAdminUser,
        isActive: false,
      } as any);

      const res = await request(app)
        .get("/api/v1/admin/services")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(403);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("ACCOUNT_DEACTIVATED");
    });
  });

  describe("POST /api/v1/admin/services", () => {
    it("should successfully create a new service with valid data", async () => {
      const createdService = {
        id: 10,
        name: "Premium Telegram Members",
        category: "Telegram",
        ratePer1000: new Prisma.Decimal("2.500000"),
        minQuantity: 100,
        maxQuantity: 10000,
        type: "Default",
        description: "Real high retention members",
        supportsDripfeed: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.service.create).mockResolvedValue(createdService as any);

      const res = await request(app)
        .post("/api/v1/admin/services")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({
          name: "Premium Telegram Members",
          category: "Telegram",
          ratePer1000: "2.500000",
          minQuantity: 100,
          maxQuantity: 10000,
          type: "Default",
          description: "Real high retention members",
          supportsDripfeed: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("success");
      expect(res.body.data.id).toBe(10);
      expect(res.body.data.ratePer1000).toBe("2.500000");
      expect(prisma.service.create).toHaveBeenCalledTimes(1);
    });

    it("should reject payload with unknown fields (.strict() validation)", async () => {
      const res = await request(app)
        .post("/api/v1/admin/services")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({
          name: "Premium Telegram Members",
          category: "Telegram",
          ratePer1000: "2.500000",
          minQuantity: 100,
          maxQuantity: 10000,
          unknownField: "malicious_input",
        });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("should reject when minQuantity > maxQuantity", async () => {
      const res = await request(app)
        .post("/api/v1/admin/services")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({
          name: "Invalid Quantities",
          category: "Telegram",
          ratePer1000: "1.000000",
          minQuantity: 5000,
          maxQuantity: 100,
        });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("should reject non-positive ratePer1000", async () => {
      const res = await request(app)
        .post("/api/v1/admin/services")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({
          name: "Free Service",
          category: "Telegram",
          ratePer1000: "-1.000000",
          minQuantity: 10,
          maxQuantity: 100,
        });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe("error");
    });
  });

  describe("GET /api/v1/admin/services", () => {
    it("should return paginated list of services with metadata", async () => {
      const mockServices = [
        {
          id: 1,
          name: "Service 1",
          category: "Instagram",
          ratePer1000: new Prisma.Decimal("1.500000"),
          minQuantity: 50,
          maxQuantity: 5000,
          type: "Default",
          description: null,
          supportsDripfeed: false,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.mocked(prisma.service.count).mockResolvedValue(1);
      vi.mocked(prisma.service.findMany).mockResolvedValue(mockServices as any);

      const res = await request(app)
        .get("/api/v1/admin/services?page=1&limit=20&category=Instagram")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.meta).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            category: { equals: "Instagram", mode: "insensitive" },
          }),
          orderBy: { createdAt: "desc" },
        }),
      );
    });

    it("should support isActive query filter", async () => {
      vi.mocked(prisma.service.count).mockResolvedValue(0);
      vi.mocked(prisma.service.findMany).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/v1/admin/services?isActive=false")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(200);
      expect(prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: false,
          }),
        }),
      );
    });
  });

  describe("PATCH /api/v1/admin/services/:id", () => {
    const existingService = {
      id: 5,
      name: "Existing Service",
      category: "TikTok",
      ratePer1000: new Prisma.Decimal("1.000000"),
      minQuantity: 100,
      maxQuantity: 500,
      type: "Default",
      description: "Existing desc",
      supportsDripfeed: false,
      isActive: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("should return 404 when service does not exist", async () => {
      vi.mocked(prisma.service.findUnique).mockResolvedValue(null);

      const res = await request(app)
        .patch("/api/v1/admin/services/999")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({ name: "Updated Name" });

      expect(res.status).toBe(404);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("should reject empty update body", async () => {
      const res = await request(app)
        .patch("/api/v1/admin/services/5")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("should re-validate minQuantity <= maxQuantity against MERGED existing values", async () => {
      vi.mocked(prisma.service.findUnique).mockResolvedValue(existingService as any);

      // Existing has min: 100, max: 500. Updating min to 600 without changing max must fail!
      const res = await request(app)
        .patch("/api/v1/admin/services/5")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({ minQuantity: 600 });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe("error");
      expect(res.body.error.message).toContain("cannot be greater than maxQuantity");
    });

    it("should successfully update and re-enable service", async () => {
      vi.mocked(prisma.service.findUnique).mockResolvedValue(existingService as any);
      vi.mocked(prisma.service.update).mockResolvedValue({
        ...existingService,
        ratePer1000: new Prisma.Decimal("1.250000"),
        isActive: true,
      } as any);

      const res = await request(app)
        .patch("/api/v1/admin/services/5")
        .set("Authorization", `Bearer ${adminApiKey}`)
        .send({
          ratePer1000: "1.250000",
          isActive: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.data.ratePer1000).toBe("1.250000");
      expect(res.body.data.isActive).toBe(true);
    });
  });

  describe("DELETE /api/v1/admin/services/:id", () => {
    it("should return 404 when service does not exist", async () => {
      vi.mocked(prisma.service.findUnique).mockResolvedValue(null);

      const res = await request(app)
        .delete("/api/v1/admin/services/999")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(404);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("should soft delete service by setting isActive to false", async () => {
      vi.mocked(prisma.service.findUnique).mockResolvedValue({
        id: 7,
        name: "Service to delete",
        isActive: true,
      } as any);

      vi.mocked(prisma.service.update).mockResolvedValue({
        id: 7,
        name: "Service to delete",
        isActive: false,
      } as any);

      const res = await request(app)
        .delete("/api/v1/admin/services/7")
        .set("Authorization", `Bearer ${adminApiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.data.id).toBe(7);
      expect(res.body.data.isActive).toBe(false);
      expect(prisma.service.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { isActive: false },
      });
    });
  });
});
