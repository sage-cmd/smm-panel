import { Worker, Job } from "bullmq";
import axios from "axios";
import { Prisma } from "@prisma/client";
import { redisOptions } from "../../lib/redis";
import { prisma } from "../../lib/prisma";
import { QUEUE_NAMES, WebhookDeliveryJobData } from "../queues";
import { signWebhookPayload } from "../webhookSignature";
import { validateWebhookUrl } from "../../utils/ssrf";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";

export async function processWebhookDeliveryJob(job: Job<WebhookDeliveryJobData>): Promise<void> {
  const { webhookId, userId, eventId, eventType, payload, secret } = job.data;
  const startTime = Date.now();

  const webhook = await prisma.webhook.findUnique({
    where: { id: webhookId },
  });

  if (!webhook || !webhook.isActive) {
    logger.info(`Skipping delivery: webhook ${webhookId} does not exist or is inactive`);
    return;
  }

  // SSRF defense: re-validate destination URL
  if (!validateWebhookUrl(webhook.url)) {
    logger.error(`SSRF defense blocked delivery to unsafe URL: ${webhook.url}`);
    await prisma.webhookDelivery.create({
      data: {
        webhookId,
        userId,
        eventId,
        eventType,
        payload: payload as unknown as Prisma.InputJsonValue,
        attempt: job.attemptsMade + 1,
        status: "FAILED",
        errorMessage: "Blocked by SSRF security check",
      },
    });
    return;
  }

  const payloadString = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);

  // Sign payload with subscriber's secret (or fallback empty secret)
  const signatureSecret = secret || "default_webhook_signing_secret";
  const { header: signatureHeader } = signWebhookPayload(payloadString, signatureSecret, timestamp);

  let responseStatus: number | undefined;
  let responseBody: string | undefined;
  let errorMessage: string | undefined;
  let isSuccess = false;

  try {
    const response = await axios.post(webhook.url, payloadString, {
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signatureHeader,
        "X-Webhook-Timestamp": timestamp.toString(),
        "X-Webhook-Event": eventType,
        "X-Webhook-Delivery-Id": eventId,
        "User-Agent": "SMM-Panel-Webhook-Dispatcher/1.0",
      },
      timeout: env.WEBHOOK_TIMEOUT_MS,
      maxContentLength: 1024 * 1024, // 1MB max response
      validateStatus: () => true, // capture all status codes without throwing
    });

    responseStatus = response.status;
    responseBody =
      typeof response.data === "string"
        ? response.data.slice(0, 1000)
        : JSON.stringify(response.data).slice(0, 1000);

    // Consider HTTP 2xx as delivery success
    if (responseStatus >= 200 && responseStatus < 300) {
      isSuccess = true;
    } else {
      errorMessage = `Destination returned non-2xx status: ${responseStatus}`;
    }
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : "Unknown HTTP dispatch error";
  }

  const durationMs = Date.now() - startTime;

  // Record delivery attempt into database audit log
  await prisma.webhookDelivery.create({
    data: {
      webhookId,
      userId,
      eventId,
      eventType,
      payload: payload as unknown as Prisma.InputJsonValue,
      attempt: job.attemptsMade + 1,
      responseStatus,
      responseBody,
      errorMessage,
      durationMs,
      status: isSuccess ? "SUCCESS" : "FAILED",
      deliveredAt: isSuccess ? new Date() : null,
    },
  });

  if (!isSuccess) {
    throw new Error(`Webhook delivery failed: ${errorMessage}`);
  }
}

export function createWebhookDeliveryWorker(): Worker<WebhookDeliveryJobData> {
  const worker = new Worker<WebhookDeliveryJobData>(
    QUEUE_NAMES.WEBHOOK_DELIVERY,
    processWebhookDeliveryJob,
    {
      connection: redisOptions,
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    logger.warn(
      `Webhook delivery job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`,
    );
  });

  return worker;
}
