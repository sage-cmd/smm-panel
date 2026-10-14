import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { app } from "../../app";
import { prisma } from "../../lib/prisma";

vi.mock("../../lib/prisma", () => {
  const mockTx = {
    service: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    order: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    transaction: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    webhook: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    fulfillmentJob: {
      create: vi.fn(),
    },
    dripFeedBatch: {
      create: vi.fn(),
    },
    idempotencyRecord: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $executeRaw: vi.fn(),
  };

  return {
    prisma: {
      ...mockTx,
      apiKey: {
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      $connect: vi.fn(),
      $disconnect: vi.fn(),
      $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
      $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => {
        return cb(mockTx);
      }),
    },
    isPrismaHealthy: vi.fn().mockResolvedValue(true),
  };
});

vi.mock("../../lib/redis", () => ({
  isRedisHealthy: vi.fn().mockResolvedValue(true),
  disconnectRedis: vi.fn(),
  getRedisClient: vi.fn(),
}));

describe("Modern REST API Integration (/api/v1/rest)", () => {
  const rawKey = "smm_rest_api_key_valid";
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  const mockUser = {
    id: "user-rest-1",
    email: "restuser@example.com",
    balance: "250.000000",
    currency: "USD",
  };

  const mockApiKey = {
    id: "key-rest-1",
    userId: mockUser.id,
    keyHash,
    isActive: true,
    user: mockUser,
  };

  const authHeader = `Bearer ${rawKey}`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockApiKey as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
  });

  // ============================================================================
  // GET /api/v1/rest/services
  // ============================================================================
  describe("GET /api/v1/rest/services", () => {
    it("should return paginated active services", async () => {
      const mockServices = [
        {
          id: 1,
          name: "Instagram Followers",
          category: "Instagram",
          ratePer1000: "1.500000",
          minQuantity: 50,
          maxQuantity: 50000,
          type: "Default",
          description: "High quality followers",
          supportsDripfeed: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.mocked(prisma.service.count).mockResolvedValue(1);
      vi.mocked(prisma.service.findMany).mockResolvedValue(mockServices as any);

      const res = await request(app).get("/api/v1/rest/services").set("Authorization", authHeader);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe("Instagram Followers");
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      });
    });

    it("should return 401 when unauthorized", async () => {
      const res = await request(app).get("/api/v1/rest/services");
      expect(res.status).toBe(401);
      expect(res.body.status).toBe("error");
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    });
  });

  // ============================================================================
  // POST /api/v1/rest/orders
  // ============================================================================
  describe("POST /api/v1/rest/orders", () => {
    const validService = {
      id: 1,
      name: "Instagram Followers",
      ratePer1000: "1.500000",
      minQuantity: 50,
      maxQuantity: 50000,
      supportsDripfeed: true,
      isActive: true,
    };

    it("should create an order and return HTTP 201", async () => {
      vi.mocked(prisma.service.findUnique).mockResolvedValue(validService as any);
      vi.mocked(prisma.$executeRaw).mockResolvedValue(1);
      vi.mocked(prisma.transaction.create).mockResolvedValue({ id: "tx-10" } as any);
      vi.mocked(prisma.order.create).mockResolvedValue({
        id: 101,
        serviceId: 1,
        link: "https://instagram.com/dev",
        quantity: 1000,
        totalCharge: "1.500000",
        status: "PENDING",
        remains: 1000,
        runs: null,
        interval: null,
        createdAt: new Date(),
      } as any);

      const res = await request(app)
        .post("/api/v1/rest/orders")
        .set("Authorization", authHeader)
        .send({
          serviceId: 1,
          link: "https://instagram.com/dev",
          quantity: 1000,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("success");
      expect(res.body.data.id).toBe(101);
      expect(res.body.data.totalCharge).toBe("1.500000");
    });

    it("should support idempotency keys and return cached response on replay", async () => {
      const idempotencyKey = "idemp-key-xyz-123";
      const cachedOrder = {
        id: 101,
        serviceId: 1,
        link: "https://instagram.com/dev",
        quantity: 1000,
        totalCharge: "1.500000",
        status: "PENDING",
      };

      vi.mocked(prisma.idempotencyRecord.findUnique).mockResolvedValue({
        id: "rec-1",
        userId: mockUser.id,
        key: idempotencyKey,
        status: "RESOLVED",
        statusCode: 201,
        responseBody: cachedOrder,
      } as any);

      const res = await request(app)
        .post("/api/v1/rest/orders")
        .set("Authorization", authHeader)
        .set("Idempotency-Key", idempotencyKey)
        .send({
          serviceId: 1,
          link: "https://instagram.com/dev",
          quantity: 1000,
        });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(cachedOrder);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it("should reject when account balance is insufficient (400)", async () => {
      vi.mocked(prisma.service.findUnique).mockResolvedValue(validService as any);
      vi.mocked(prisma.$executeRaw).mockResolvedValue(0); // 0 rows updated

      const res = await request(app)
        .post("/api/v1/rest/orders")
        .set("Authorization", authHeader)
        .send({
          serviceId: 1,
          link: "https://instagram.com/dev",
          quantity: 1000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Insufficient account balance/);
    });

    it("should reject when quantity is outside service limits (400)", async () => {
      vi.mocked(prisma.service.findUnique).mockResolvedValue(validService as any);

      const res = await request(app)
        .post("/api/v1/rest/orders")
        .set("Authorization", authHeader)
        .send({
          serviceId: 1,
          link: "https://instagram.com/dev",
          quantity: 10, // Below 50 min
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Quantity must be between/);
    });
  });

  // ============================================================================
  // GET /api/v1/rest/orders/:id
  // ============================================================================
  describe("GET /api/v1/rest/orders/:id", () => {
    it("should return the requested order for the authorized owner", async () => {
      vi.mocked(prisma.order.findUnique).mockResolvedValue({
        id: 101,
        userId: mockUser.id,
        serviceId: 1,
        service: { id: 1, name: "Instagram Followers", category: "Instagram" },
        link: "https://instagram.com/dev",
        quantity: 1000,
        totalCharge: "1.500000",
        status: "PENDING",
        startCount: 0,
        remains: 1000,
        runs: null,
        interval: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const res = await request(app)
        .get("/api/v1/rest/orders/101")
        .set("Authorization", authHeader);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.data.id).toBe(101);
    });

    it("should return 404 when requesting an order belonging to another user", async () => {
      vi.mocked(prisma.order.findUnique).mockResolvedValue({
        id: 999,
        userId: "different-user-999", // Unowned order
      } as any);

      const res = await request(app)
        .get("/api/v1/rest/orders/999")
        .set("Authorization", authHeader);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("should return 400 when order ID is not an integer", async () => {
      const res = await request(app)
        .get("/api/v1/rest/orders/not-an-id")
        .set("Authorization", authHeader);

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/valid positive integer/);
    });
  });

  // ============================================================================
  // GET /api/v1/rest/balance
  // ============================================================================
  describe("GET /api/v1/rest/balance", () => {
    it("should return balance and paginated transactions", async () => {
      vi.mocked(prisma.transaction.count).mockResolvedValue(1);
      vi.mocked(prisma.transaction.findMany).mockResolvedValue([
        {
          id: "tx-1",
          orderId: 101,
          amount: "1.500000",
          type: "DEDUCTION",
          status: "SUCCESS",
          description: "Order placement",
          createdAt: new Date(),
        },
      ] as any);

      const res = await request(app).get("/api/v1/rest/balance").set("Authorization", authHeader);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.data.balance).toBe("250.000000");
      expect(res.body.data.currency).toBe("USD");
      expect(res.body.data.transactions).toHaveLength(1);
      expect(res.body.data.pagination).toBeDefined();
    });
  });

  // ============================================================================
  // Webhook Endpoints
  // ============================================================================
  describe("Webhook Management (/api/v1/rest/webhooks)", () => {
    const mockWebhook = {
      id: "wh-uuid-1",
      userId: mockUser.id,
      url: "https://webhook.site/test-receiver",
      secret: "whsec_super_secret_never_leak",
      events: ["order.created", "order.completed"],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it("GET /webhooks should list webhooks and omit secrets", async () => {
      vi.mocked(prisma.webhook.findMany).mockResolvedValue([mockWebhook] as any);

      const res = await request(app).get("/api/v1/rest/webhooks").set("Authorization", authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe("wh-uuid-1");
      expect(res.body.data[0].secret).toBeUndefined(); // Secret must never be leaked
    });

    it("POST /webhooks should create a webhook and return generated secret once (HTTP 201)", async () => {
      vi.mocked(prisma.webhook.create).mockResolvedValue(mockWebhook as any);

      const res = await request(app)
        .post("/api/v1/rest/webhooks")
        .set("Authorization", authHeader)
        .send({
          url: "https://webhook.site/test-receiver",
          events: ["order.created", "order.completed"],
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("success");
      expect(res.body.data.secret).toBeDefined(); // Secret returned ONCE upon creation
      expect(res.body.data.url).toBe("https://webhook.site/test-receiver");
    });

    it("POST /webhooks should block SSRF private IP destinations", async () => {
      const res = await request(app)
        .post("/api/v1/rest/webhooks")
        .set("Authorization", authHeader)
        .send({
          url: "http://192.168.1.1/attack",
          events: ["order.created"],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Invalid request payload/);
    });

    it("GET /webhooks/:id should retrieve authorized webhook and omit secret", async () => {
      vi.mocked(prisma.webhook.findUnique).mockResolvedValue(mockWebhook as any);

      const res = await request(app)
        .get("/api/v1/rest/webhooks/wh-uuid-1")
        .set("Authorization", authHeader);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe("wh-uuid-1");
      expect(res.body.data.secret).toBeUndefined(); // Secret omitted
    });

    it("GET /webhooks/:id should return 404 for unowned webhook", async () => {
      vi.mocked(prisma.webhook.findUnique).mockResolvedValue({
        ...mockWebhook,
        userId: "different-user-id",
      } as any);

      const res = await request(app)
        .get("/api/v1/rest/webhooks/wh-uuid-1")
        .set("Authorization", authHeader);

      expect(res.status).toBe(404);
    });

    it("PATCH /webhooks/:id should update authorized webhook and omit secret", async () => {
      vi.mocked(prisma.webhook.findUnique).mockResolvedValue(mockWebhook as any);
      vi.mocked(prisma.webhook.update).mockResolvedValue({
        ...mockWebhook,
        isActive: false,
      } as any);

      const res = await request(app)
        .patch("/api/v1/rest/webhooks/wh-uuid-1")
        .set("Authorization", authHeader)
        .send({
          isActive: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(false);
      expect(res.body.data.secret).toBeUndefined();
    });

    it("DELETE /webhooks/:id should delete authorized webhook and return HTTP 204", async () => {
      vi.mocked(prisma.webhook.findUnique).mockResolvedValue(mockWebhook as any);
      vi.mocked(prisma.webhook.delete).mockResolvedValue(mockWebhook as any);

      const res = await request(app)
        .delete("/api/v1/rest/webhooks/wh-uuid-1")
        .set("Authorization", authHeader);

      expect(res.status).toBe(204);
      expect(prisma.webhook.delete).toHaveBeenCalledWith({
        where: { id: "wh-uuid-1" },
      });
    });
  });
});
