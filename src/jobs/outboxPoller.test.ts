import { describe, it, expect, vi, beforeEach } from "vitest";
import { pollOutboxJobs, startOutboxPoller, stopOutboxPoller } from "./outboxPoller";
import { prisma } from "../lib/prisma";
import * as queues from "./queues";

vi.mock("../lib/prisma", () => ({
  prisma: {
    fulfillmentJob: {
      findMany: vi.fn(),
    },
    dripFeedBatch: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("./queues", () => ({
  enqueueOrderFulfillment: vi.fn().mockResolvedValue(undefined),
  enqueueDripFeedBatch: vi.fn().mockResolvedValue(undefined),
}));

describe("Outbox Poller (outboxPoller.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopOutboxPoller();
  });

  it("should recover and enqueue orphan pending fulfillment jobs", async () => {
    vi.mocked(prisma.fulfillmentJob.findMany).mockResolvedValue([
      {
        id: "job-1",
        orderId: 555,
        status: "PENDING",
        attempts: 1,
        maxAttempts: 5,
        order: { runs: null },
      } as any,
    ]);

    vi.mocked(prisma.dripFeedBatch.findMany).mockResolvedValue([]);

    await pollOutboxJobs();

    expect(queues.enqueueOrderFulfillment).toHaveBeenCalledWith(555);
  });

  it("should recover and enqueue overdue pending drip feed batches", async () => {
    vi.mocked(prisma.fulfillmentJob.findMany).mockResolvedValue([]);
    vi.mocked(prisma.dripFeedBatch.findMany).mockResolvedValue([
      {
        id: "drip-1",
        orderId: 777,
        batchNumber: 2,
        status: "PENDING",
        scheduledAt: new Date(Date.now() - 5000),
      } as any,
    ]);

    await pollOutboxJobs();

    expect(queues.enqueueDripFeedBatch).toHaveBeenCalledWith(777, 2, 0);
  });

  it("should start and stop timer interval cleanly", () => {
    startOutboxPoller(10000);
    // Calling start again is idempotent
    startOutboxPoller(10000);
    stopOutboxPoller();
    // Calling stop again is safe
    stopOutboxPoller();
  });
});
