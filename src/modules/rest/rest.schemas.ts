import { z } from "zod";
import { validateWebhookUrl } from "../../utils/ssrf";

export const ALLOWED_WEBHOOK_EVENTS = [
  "order.created",
  "order.processing",
  "order.completed",
  "order.canceled",
  "order.partial",
] as const;

export const RestCreateOrderSchema = z
  .object({
    serviceId: z.coerce.number().int().positive("serviceId must be a positive integer"),
    link: z.string().trim().min(1, "link is required"),
    quantity: z.coerce.number().int().positive("quantity must be a positive integer"),
    runs: z.coerce.number().int().min(2, "runs must be at least 2").optional(),
    interval: z.coerce.number().int().min(1, "interval must be at least 1 minute").optional(),
  })
  .refine(
    (data) => {
      const hasRuns = data.runs !== undefined;
      const hasInterval = data.interval !== undefined;
      return (hasRuns && hasInterval) || (!hasRuns && !hasInterval);
    },
    {
      message: "Both 'runs' and 'interval' must be provided together for drip-feed orders",
      path: ["runs"],
    },
  );

export type RestCreateOrderInput = z.infer<typeof RestCreateOrderSchema>;

export const RestCreateWebhookSchema = z.object({
  url: z.string().url("A valid URL is required").refine(validateWebhookUrl, {
    message:
      "Forbidden webhook URL: private IP ranges, loopback, and metadata destinations are blocked",
  }),
  events: z
    .array(z.enum(ALLOWED_WEBHOOK_EVENTS))
    .min(1, "At least one subscription event must be specified"),
  secret: z.string().min(8, "Secret must be at least 8 characters long").optional(),
});

export type RestCreateWebhookInput = z.infer<typeof RestCreateWebhookSchema>;

export const RestUpdateWebhookSchema = z
  .object({
    url: z
      .string()
      .url("A valid URL is required")
      .refine(validateWebhookUrl, {
        message:
          "Forbidden webhook URL: private IP ranges, loopback, and metadata destinations are blocked",
      })
      .optional(),
    events: z
      .array(z.enum(ALLOWED_WEBHOOK_EVENTS))
      .min(1, "At least one subscription event must be specified")
      .optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field ('url', 'events', or 'isActive') must be provided for update",
  });

export type RestUpdateWebhookInput = z.infer<typeof RestUpdateWebhookSchema>;
