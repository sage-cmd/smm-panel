import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { processWebhookDeliveryJob } from "./webhook.worker";
import { prisma } from "../../lib/prisma";
import * as ssrfUtils from "../../utils/ssrf";
import { Job } from "bullmq";
import { WebhookDeliveryJobData } from "../queues";

vi.mock("axios");
vi.mock("../../lib/prisma", () => ({
  prisma: {
    webhook: {
      findUnique: vi.fn(),
    },
    webhookDelivery: {
      create: vi.fn().mockResolvedValue({ id: "delivery-1" }),
    },
  },
}));

vi.mock("../../utils/ssrf", () => ({
  validateWebhookUrl: vi.fn(),
}));

describe("Webhook Delivery Worker (webhook.worker.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockJobData: WebhookDeliveryJobData = {
    webhookId: "wh-123",
    userId: "usr-456",
    eventId: "evt-789",
    eventType: "order.completed",
    payload: { order_id: 1, status: "completed" },
    secret: "whsec_test_secret",
  };

  const createMockJob = (attemptsMade = 0) =>
    ({
      id: "job-1",
      data: mockJobData,
      attemptsMade,
    }) as unknown as Job<WebhookDeliveryJobData>;

  it("should successfully deliver payload, sign request, and record audit log", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({
      id: "wh-123",
      userId: "usr-456",
      url: "https://my-consumer.com/webhook",
      secret: "whsec_test_secret",
      events: ["order.completed"],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(ssrfUtils.validateWebhookUrl).mockReturnValue(true);
    vi.mocked(axios.post).mockResolvedValue({
      status: 200,
      data: { success: true },
    });

    const job = createMockJob(0);
    await processWebhookDeliveryJob(job);

    expect(ssrfUtils.validateWebhookUrl).toHaveBeenCalledWith("https://my-consumer.com/webhook");
    expect(axios.post).toHaveBeenCalledTimes(1);

    const call = vi.mocked(axios.post).mock.calls[0];
    expect(call).toBeDefined();
    const [postUrl, postBody, postConfig] = call!;
    expect(postUrl).toBe("https://my-consumer.com/webhook");
    expect(typeof postBody).toBe("string");
    expect(postConfig?.headers?.["X-Webhook-Event"]).toBe("order.completed");
    expect(postConfig?.headers?.["X-Webhook-Delivery-Id"]).toBe("evt-789");
    expect(postConfig?.headers?.["X-Webhook-Signature"]).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        webhookId: "wh-123",
        status: "SUCCESS",
        responseStatus: 200,
        attempt: 1,
      }),
    });
  });

  it("should block delivery and log FAILED if SSRF validation fails", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({
      id: "wh-123",
      userId: "usr-456",
      url: "http://169.254.169.254/latest/meta-data",
      secret: "whsec_test_secret",
      events: ["order.completed"],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(ssrfUtils.validateWebhookUrl).mockReturnValue(false);

    const job = createMockJob(0);
    await processWebhookDeliveryJob(job);

    expect(axios.post).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        webhookId: "wh-123",
        status: "FAILED",
        errorMessage: "Blocked by SSRF security check",
      }),
    });
  });

  it("should record failure and throw error when HTTP destination returns 500 error", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({
      id: "wh-123",
      userId: "usr-456",
      url: "https://my-consumer.com/webhook",
      secret: "whsec_test_secret",
      events: ["order.completed"],
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    vi.mocked(ssrfUtils.validateWebhookUrl).mockReturnValue(true);
    vi.mocked(axios.post).mockResolvedValue({
      status: 500,
      data: { error: "Internal Server Error" },
    });

    const job = createMockJob(0);
    await expect(processWebhookDeliveryJob(job)).rejects.toThrow("Webhook delivery failed");

    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        webhookId: "wh-123",
        status: "FAILED",
        responseStatus: 500,
      }),
    });
  });

  it("should skip delivery cleanly if webhook is inactive or removed", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue(null);

    const job = createMockJob(0);
    await processWebhookDeliveryJob(job);

    expect(axios.post).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });
});
