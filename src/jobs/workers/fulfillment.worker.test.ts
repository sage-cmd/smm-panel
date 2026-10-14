import { describe, it, expect, vi, beforeEach } from "vitest";
import { processOrderFulfillmentJob } from "./fulfillment.worker";
import { prisma } from "../../lib/prisma";
import * as events from "../events";
import { ISMMProvider } from "../../modules/provider/provider.interface";
import { Job } from "bullmq";
import { OrderFulfillmentJobData } from "../queues";
import { Prisma } from "@prisma/client";

vi.mock("../events", () => ({
  emitOrderEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/prisma", () => {
  const mockTx = {
    order: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    fulfillmentJob: {
      update: vi.fn(),
    },
    transaction: {
      create: vi.fn(),
    },
    $executeRaw: vi.fn(),
  };

  return {
    prisma: {
      ...mockTx,
      $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
    },
  };
});

describe("Order Fulfillment Worker (fulfillment.worker.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockOrder = {
    id: 101,
    userId: "usr-123",
    serviceId: 1,
    link: "https://instagram.com/test",
    quantity: 1000,
    totalCharge: new Prisma.Decimal("1.500000"),
    status: "PENDING",
    remains: 1000,
    startCount: null,
    runs: null,
    interval: null,
    fulfillmentJob: {
      id: "job-uuid-1",
      orderId: 101,
      status: "PENDING",
      attempts: 0,
      maxAttempts: 5,
    },
    service: {
      id: 1,
      name: "Followers",
      ratePer1000: new Prisma.Decimal("1.500000"),
    },
  };

  const createMockBullJob = (attemptsMade = 0) =>
    ({
      id: "bull-job-101",
      data: { orderId: 101 },
      attemptsMade,
    }) as unknown as Job<OrderFulfillmentJobData>;

  it("should process order through provider and complete it when provider finishes", async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue(mockOrder as any);
    vi.mocked(prisma.order.update).mockResolvedValue({
      ...mockOrder,
      status: "COMPLETED",
      remains: 0,
      externalOrderId: "ext-order-999",
      startCount: 150,
    } as any);

    const mockProvider: ISMMProvider = {
      createOrder: vi.fn().mockResolvedValue({
        externalOrderId: "ext-order-999",
        startCount: 150,
        initialStatus: "PROCESSING",
      }),
      getOrderStatus: vi.fn().mockResolvedValue({
        externalOrderId: "ext-order-999",
        status: "COMPLETED",
        remains: 0,
      }),
    };

    const job = createMockBullJob(0);
    await processOrderFulfillmentJob(job, mockProvider);

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 101 },
      data: { status: "PROCESSING" },
    });
    expect(events.emitOrderEvent).toHaveBeenCalledWith(
      "order.processing",
      expect.objectContaining({ id: 101 }),
    );

    expect(mockProvider.createOrder).toHaveBeenCalledWith({
      orderId: 101,
      serviceId: 1,
      link: "https://instagram.com/test",
      quantity: 1000,
    });

    expect(mockProvider.getOrderStatus).toHaveBeenCalledWith("ext-order-999");

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 101 },
      data: expect.objectContaining({
        status: "COMPLETED",
        remains: 0,
        externalOrderId: "ext-order-999",
      }),
    });

    expect(prisma.fulfillmentJob.update).toHaveBeenCalledWith({
      where: { orderId: 101 },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });

    expect(events.emitOrderEvent).toHaveBeenCalledWith(
      "order.completed",
      expect.objectContaining({ id: 101, status: "COMPLETED" }),
    );
  });

  it("should handle partial completion with refund for remaining quantity", async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue(mockOrder as any);

    const mockProvider: ISMMProvider = {
      createOrder: vi.fn().mockResolvedValue({
        externalOrderId: "ext-order-888",
        startCount: 100,
        initialStatus: "PROCESSING",
      }),
      getOrderStatus: vi.fn().mockResolvedValue({
        externalOrderId: "ext-order-888",
        status: "PARTIAL",
        remains: 400, // 400 out of 1000 not delivered
      }),
    };

    const job = createMockBullJob(0);
    await processOrderFulfillmentJob(job, mockProvider);

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 101 },
      data: expect.objectContaining({
        status: "PARTIAL",
        remains: 400,
      }),
    });

    // Verify refund credit transaction
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "usr-123",
        orderId: 101,
        type: "REFUND",
        amount: new Prisma.Decimal("0.600000"), // (400/1000) * 1.50 = 0.60
      }),
    });

    expect(events.emitOrderEvent).toHaveBeenCalledWith(
      "order.partial",
      expect.objectContaining({ id: 101, status: "PARTIAL", remains: 400 }),
    );
  });

  it("should handle provider cancellation with full refund", async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue(mockOrder as any);

    const mockProvider: ISMMProvider = {
      createOrder: vi.fn().mockResolvedValue({
        externalOrderId: "ext-order-777",
        startCount: 0,
        initialStatus: "PROCESSING",
      }),
      getOrderStatus: vi.fn().mockResolvedValue({
        externalOrderId: "ext-order-777",
        status: "CANCELED",
        remains: 1000,
      }),
    };

    const job = createMockBullJob(0);
    await processOrderFulfillmentJob(job, mockProvider);

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 101 },
      data: expect.objectContaining({
        status: "CANCELED",
        remains: 1000,
      }),
    });

    // Verify full refund transaction
    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "usr-123",
        orderId: 101,
        type: "REFUND",
        amount: new Prisma.Decimal("1.500000"),
      }),
    });

    expect(events.emitOrderEvent).toHaveBeenCalledWith(
      "order.canceled",
      expect.objectContaining({ id: 101, status: "CANCELED" }),
    );
  });

  it("should cancel and refund when retry attempts are exhausted", async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue(mockOrder as any);

    const mockProvider: ISMMProvider = {
      createOrder: vi.fn().mockRejectedValue(new Error("Provider API timeout")),
      getOrderStatus: vi.fn(),
    };

    // 4 attempts already made, this is the 5th attempt (maxAttempts = 5)
    const job = createMockBullJob(4);

    await expect(processOrderFulfillmentJob(job, mockProvider)).rejects.toThrow(
      "Provider API timeout",
    );

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 101 },
      data: expect.objectContaining({ status: "CANCELED" }),
    });

    expect(prisma.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "REFUND",
        amount: new Prisma.Decimal("1.500000"),
      }),
    });

    expect(events.emitOrderEvent).toHaveBeenCalledWith(
      "order.canceled",
      expect.objectContaining({ id: 101, status: "CANCELED" }),
    );
  });

  it("should skip processing if order is already completed or canceled", async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      ...mockOrder,
      status: "COMPLETED",
    } as any);

    const mockProvider: ISMMProvider = {
      createOrder: vi.fn(),
      getOrderStatus: vi.fn(),
    };

    const job = createMockBullJob(0);
    await processOrderFulfillmentJob(job, mockProvider);

    expect(mockProvider.createOrder).not.toHaveBeenCalled();
  });
});
