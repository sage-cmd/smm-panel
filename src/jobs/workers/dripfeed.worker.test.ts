import { describe, it, expect, vi, beforeEach } from "vitest";
import { processDripFeedBatchJob } from "./dripfeed.worker";
import { prisma } from "../../lib/prisma";
import * as events from "../events";
import * as queues from "../queues";
import { ISMMProvider } from "../../modules/provider/provider.interface";
import { Job } from "bullmq";
import { DripFeedJobData } from "../queues";
import { Prisma } from "@prisma/client";

vi.mock("../events", () => ({
  emitOrderEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../queues", () => ({
  enqueueDripFeedBatch: vi.fn().mockResolvedValue(undefined),
  QUEUE_NAMES: {
    DRIP_FEED: "drip-feed-scheduler",
  },
}));

vi.mock("../../lib/prisma", () => ({
  prisma: {
    dripFeedBatch: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    order: {
      update: vi.fn(),
    },
    fulfillmentJob: {
      update: vi.fn(),
    },
  },
}));

describe("Drip-Feed Batch Worker (dripfeed.worker.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockBatch = {
    id: "batch-1",
    orderId: 200,
    batchNumber: 1,
    quantity: 500,
    status: "PENDING",
    scheduledAt: new Date(Date.now() + 60000),
    order: {
      id: 200,
      userId: "usr-456",
      serviceId: 2,
      link: "https://youtube.com/watch?v=123",
      quantity: 1500,
      totalCharge: new Prisma.Decimal("4.500000"),
      status: "PENDING",
      remains: 1500,
      startCount: null,
      service: {
        id: 2,
        name: "Views",
      },
    },
  };

  const createMockJob = () =>
    ({
      id: "bull-drip-1",
      data: { orderId: 200, batchNumber: 1 },
      attemptsMade: 0,
    }) as unknown as Job<DripFeedJobData>;

  it("should execute intermediate batch, update remains, and schedule next batch", async () => {
    vi.mocked(prisma.dripFeedBatch.findUnique).mockResolvedValue(mockBatch as any);
    vi.mocked(prisma.dripFeedBatch.findFirst).mockResolvedValue({
      id: "batch-2",
      orderId: 200,
      batchNumber: 2,
      quantity: 500,
      status: "PENDING",
      scheduledAt: new Date(Date.now() + 120000),
    } as any);

    const mockProvider: ISMMProvider = {
      createOrder: vi.fn().mockResolvedValue({
        externalOrderId: "drip-ext-1",
        startCount: 200,
        initialStatus: "PROCESSING",
      }),
      getOrderStatus: vi.fn(),
    };

    vi.mocked(prisma.order.update).mockResolvedValue({
      ...mockBatch.order,
      status: "PROCESSING",
      remains: 1000,
    } as any);

    const job = createMockJob();
    await processDripFeedBatchJob(job, mockProvider);

    expect(mockProvider.createOrder).toHaveBeenCalledWith({
      orderId: 200,
      serviceId: 2,
      link: "https://youtube.com/watch?v=123",
      quantity: 500,
    });

    // Verify batch marked COMPLETED
    expect(prisma.dripFeedBatch.update).toHaveBeenCalledWith({
      where: { id: "batch-1" },
      data: expect.objectContaining({
        status: "COMPLETED",
        externalOrderId: "drip-ext-1",
      }),
    });

    // Verify order remains updated (1500 - 500 = 1000)
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 200 },
      data: expect.objectContaining({
        status: "PROCESSING",
        remains: 1000,
      }),
    });

    // Verify next batch enqueued with delay
    expect(queues.enqueueDripFeedBatch).toHaveBeenCalledWith(200, 2, expect.any(Number));

    expect(events.emitOrderEvent).toHaveBeenCalledWith(
      "order.processing",
      expect.objectContaining({ id: 200, remains: 1000 }),
    );
  });

  it("should complete order when last batch finishes", async () => {
    const finalBatch = {
      ...mockBatch,
      batchNumber: 3,
      quantity: 500,
      order: {
        ...mockBatch.order,
        remains: 500,
      },
    };

    vi.mocked(prisma.dripFeedBatch.findUnique).mockResolvedValue(finalBatch as any);
    // No next batch remains
    vi.mocked(prisma.dripFeedBatch.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.order.update).mockResolvedValue({
      ...mockBatch.order,
      status: "COMPLETED",
      remains: 0,
    } as any);

    const mockProvider: ISMMProvider = {
      createOrder: vi.fn().mockResolvedValue({
        externalOrderId: "drip-ext-final",
        startCount: 1200,
        initialStatus: "PROCESSING",
      }),
      getOrderStatus: vi.fn(),
    };

    const job = createMockJob();
    await processDripFeedBatchJob(job, mockProvider);

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 200 },
      data: expect.objectContaining({
        status: "COMPLETED",
        remains: 0,
      }),
    });

    expect(prisma.fulfillmentJob.update).toHaveBeenCalledWith({
      where: { orderId: 200 },
      data: expect.objectContaining({
        status: "COMPLETED",
      }),
    });

    expect(events.emitOrderEvent).toHaveBeenCalledWith(
      "order.completed",
      expect.objectContaining({ id: 200, status: "COMPLETED", remains: 0 }),
    );
  });

  it("should cancel batch without calling provider if parent order was canceled", async () => {
    const canceledOrderBatch = {
      ...mockBatch,
      order: {
        ...mockBatch.order,
        status: "CANCELED",
      },
    };

    vi.mocked(prisma.dripFeedBatch.findUnique).mockResolvedValue(canceledOrderBatch as any);

    const mockProvider: ISMMProvider = {
      createOrder: vi.fn(),
      getOrderStatus: vi.fn(),
    };

    const job = createMockJob();
    await processDripFeedBatchJob(job, mockProvider);

    expect(mockProvider.createOrder).not.toHaveBeenCalled();
    expect(prisma.dripFeedBatch.update).toHaveBeenCalledWith({
      where: { id: "batch-1" },
      data: { status: "CANCELED" },
    });
  });
});
