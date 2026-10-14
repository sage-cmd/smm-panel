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
    },
    user: {
      findUnique: vi.fn(),
    },
    order: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    transaction: {
      create: vi.fn(),
      update: vi.fn(),
    },
    fulfillmentJob: {
      create: vi.fn(),
    },
    dripFeedBatch: {
      create: vi.fn(),
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

describe("Legacy SMM API Integration (POST /api/v1)", () => {
  const rawKey = "smm_test_api_key_valid";
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");

  const mockUser = {
    id: "user-100",
    email: "test@example.com",
    balance: "100.000000",
    currency: "USD",
  };

  const mockApiKey = {
    id: "key-100",
    userId: mockUser.id,
    keyHash,
    isActive: true,
    user: mockUser,
  };

  const mockServices = [
    {
      id: 1,
      name: "Instagram Followers",
      category: "Instagram",
      ratePer1000: "1.500000",
      minQuantity: 50,
      maxQuantity: 10000,
      type: "Default",
      supportsDripfeed: true,
      isActive: true,
    },
    {
      id: 2,
      name: "TikTok Likes",
      category: "TikTok",
      ratePer1000: "0.850000",
      minQuantity: 100,
      maxQuantity: 5000,
      type: "Default",
      supportsDripfeed: false,
      isActive: true,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Default authentication mock setup
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(mockApiKey as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser as any);
  });

  // ============================================================================
  // Action: balance
  // ============================================================================
  it("Action 'balance' should return legacy formatted balance payload", async () => {
    const res = await request(app).post("/api/v1").send({
      key: rawKey,
      action: "balance",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "success",
      balance: "100.00",
      currency: "USD",
    });
  });

  it("Action 'balance' should authenticate via Authorization Bearer header as well", async () => {
    const res = await request(app).post("/api/v1").set("Authorization", `Bearer ${rawKey}`).send({
      action: "balance",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "success",
      balance: "100.00",
      currency: "USD",
    });
  });

  // ============================================================================
  // Action: services
  // ============================================================================
  it("Action 'services' should return active catalog services in legacy array format", async () => {
    vi.mocked(prisma.service.findMany).mockResolvedValue(mockServices as any);

    const res = await request(app).post("/api/v1").send({
      key: rawKey,
      action: "services",
    });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual({
      service: 1,
      name: "Instagram Followers",
      type: "Default",
      category: "Instagram",
      rate: "1.500000",
      min: "50",
      max: "10000",
      dripfeed: true,
      refill: false,
      cancel: false,
    });
  });

  // ============================================================================
  // Action: add
  // ============================================================================
  it("Action 'add' should atomically create order, transaction, and outbox job", async () => {
    vi.mocked(prisma.service.findUnique).mockResolvedValue(mockServices[0] as any);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1); // 1 row updated (sufficient balance)
    vi.mocked(prisma.transaction.create).mockResolvedValue({ id: "tx-1" } as any);
    vi.mocked(prisma.order.create).mockResolvedValue({
      id: 32,
      userId: mockUser.id,
      serviceId: 1,
      quantity: 1000,
      totalCharge: "1.500000",
    } as any);

    const res = await request(app).post("/api/v1").send({
      key: rawKey,
      action: "add",
      service: 1,
      link: "https://instagram.com/myaccount",
      quantity: 1000,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "success",
      order: 32,
    });

    // Verify outbox fulfillment job creation
    expect(prisma.fulfillmentJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 32,
          status: "PENDING",
        }),
      }),
    );
  });

  it("Action 'add' should reject when user has insufficient balance", async () => {
    vi.mocked(prisma.service.findUnique).mockResolvedValue(mockServices[0] as any);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(0); // 0 rows updated (insufficient balance!)

    const res = await request(app).post("/api/v1").send({
      key: rawKey,
      action: "add",
      service: 1,
      link: "https://instagram.com/myaccount",
      quantity: 1000,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      error: "Not enough balance on your account",
    });
  });

  it("Action 'add' should reject when service does not support drip-feed", async () => {
    vi.mocked(prisma.service.findUnique).mockResolvedValue(mockServices[1] as any); // Service 2 supportsDripfeed = false

    const res = await request(app).post("/api/v1").send({
      key: rawKey,
      action: "add",
      service: 2,
      link: "https://tiktok.com/@video",
      quantity: 500,
      runs: 5,
      interval: 10,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      error: "This service does not support drip-feed",
    });
  });

  it("Action 'add' with drip-feed should schedule batch plans", async () => {
    vi.mocked(prisma.service.findUnique).mockResolvedValue(mockServices[0] as any);
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1);
    vi.mocked(prisma.transaction.create).mockResolvedValue({ id: "tx-2" } as any);
    vi.mocked(prisma.order.create).mockResolvedValue({ id: 50 } as any);

    const res = await request(app).post("/api/v1").send({
      key: rawKey,
      action: "add",
      service: 1,
      link: "https://instagram.com/myaccount",
      quantity: 1000,
      runs: 4,
      interval: 15,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "success",
      order: 50,
    });

    // Verify 4 drip-feed batches were recorded
    expect(prisma.dripFeedBatch.create).toHaveBeenCalledTimes(4);
  });

  // ============================================================================
  // Action: status
  // ============================================================================
  it("Action 'status' for single order should return legacy status object", async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: 32,
      userId: mockUser.id,
      totalCharge: "1.500000",
      startCount: 150,
      status: "COMPLETED",
      remains: 0,
      user: { currency: "USD" },
    } as any);

    const res = await request(app).post("/api/v1").send({
      key: rawKey,
      action: "status",
      order: 32,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      charge: "1.500000",
      start_count: "150",
      status: "Completed",
      remains: "0",
      currency: "USD",
    });
  });

  it("Action 'status' should reject an order belonging to another user", async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: 99,
      userId: "other-user-456", // Different user!
      totalCharge: "1.000000",
      user: { currency: "USD" },
    } as any);

    const res = await request(app).post("/api/v1").send({
      key: rawKey,
      action: "status",
      order: 99,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      error: "Incorrect order ID",
    });
  });

  it("Action 'status' for comma-separated list of orders should return map of statuses", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([
      {
        id: 1,
        userId: mockUser.id,
        totalCharge: "1.500000",
        startCount: 0,
        status: "PROCESSING",
        remains: 500,
        user: { currency: "USD" },
      },
    ] as any);

    const res = await request(app).post("/api/v1").send({
      key: rawKey,
      action: "status",
      order: "1,2", // 1 exists, 2 does not exist
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      "1": {
        charge: "1.500000",
        start_count: "0",
        status: "In progress",
        remains: "500",
        currency: "USD",
      },
      "2": {
        error: "Incorrect order ID",
      },
    });
  });

  // ============================================================================
  // Error handling: Unknown action & Missing credentials
  // ============================================================================
  it("should return legacy error for unknown action", async () => {
    const res = await request(app).post("/api/v1").send({
      key: rawKey,
      action: "unsupported_action",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      error: "Incorrect request",
    });
  });

  it("should return legacy error when unauthenticated", async () => {
    const res = await request(app).post("/api/v1").send({
      action: "balance",
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("error");
  });
});
