import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import { webhookDeliveryQueue } from "./queues";
import { logger } from "../lib/logger";

export type OrderWebhookEvent =
  "order.created" | "order.processing" | "order.completed" | "order.canceled" | "order.partial";

export interface OrderEventData {
  id: number;
  userId: string;
  serviceId: number;
  status: string;
  remains: number;
  startCount?: number | null;
  totalCharge: unknown;
}

/**
 * Emits an order event and enqueues deliveries to all active subscriber webhooks.
 * Does not block caller execution.
 */
export async function emitOrderEvent(
  eventType: OrderWebhookEvent,
  order: OrderEventData,
): Promise<void> {
  try {
    const webhooks = await prisma.webhook.findMany({
      where: {
        userId: order.userId,
        isActive: true,
        events: {
          has: eventType,
        },
      },
    });

    if (webhooks.length === 0) {
      return;
    }

    const payload = {
      event: eventType,
      order_id: order.id,
      service_id: order.serviceId,
      status: order.status.toLowerCase(),
      remains: order.remains,
      start_count: order.startCount ?? 0,
      timestamp: new Date().toISOString(),
    };

    for (const webhook of webhooks) {
      const eventId = `evt_${order.id}_${eventType.replace(".", "_")}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

      await webhookDeliveryQueue.add(
        "deliver",
        {
          webhookId: webhook.id,
          userId: order.userId,
          eventId,
          eventType,
          payload,
          secret: webhook.secret,
        },
        {
          jobId: `deliver_${webhook.id}_${eventId}`,
        },
      );
    }
  } catch (err) {
    logger.error(`Failed to dispatch order event ${eventType} for order #${order.id}:`, err);
  }
}
