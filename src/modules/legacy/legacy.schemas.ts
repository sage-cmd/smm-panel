import { z } from "zod";

/**
 * Base legacy request structure.
 * Note: `key` is validated/extracted by the dual-mode auth middleware,
 * but can also be present in the JSON body.
 */
export const LegacyActionSchema = z.object({
  action: z.string({ required_error: "Action parameter is required" }),
});

/**
 * Legacy "add" order action input schema
 */
export const LegacyAddOrderSchema = z
  .object({
    action: z.literal("add"),
    service: z.coerce
      .number({ invalid_type_error: "Incorrect service" })
      .int("Incorrect service")
      .positive("Incorrect service"),
    link: z.string({ required_error: "Incorrect link" }).trim().min(1, "Incorrect link"),
    quantity: z.coerce
      .number({ invalid_type_error: "Incorrect quantity" })
      .int("Incorrect quantity")
      .positive("Incorrect quantity"),
    runs: z.coerce
      .number()
      .int("Runs must be an integer")
      .min(2, "Minimum runs for drip-feed is 2")
      .optional(),
    interval: z.coerce
      .number()
      .int("Interval must be an integer")
      .min(1, "Minimum interval is 1 minute")
      .optional(),
  })
  .refine(
    (data) => {
      // Both runs and interval must be provided together if drip-feed is requested
      const hasRuns = data.runs !== undefined;
      const hasInterval = data.interval !== undefined;
      return (hasRuns && hasInterval) || (!hasRuns && !hasInterval);
    },
    {
      message: "Both runs and interval are required for drip-feed orders",
      path: ["runs"],
    },
  );

export type LegacyAddOrderInput = z.infer<typeof LegacyAddOrderSchema>;

/**
 * Legacy "status" action input schema
 * Accepts single order ID or multiple comma-separated IDs via `order` or `orders` parameter
 */
export const LegacyOrderStatusSchema = z
  .object({
    action: z.literal("status"),
    order: z.union([z.string(), z.number()]).optional(),
    orders: z.union([z.string(), z.number()]).optional(),
  })
  .refine((data) => data.order !== undefined || data.orders !== undefined, {
    message: "Incorrect order ID",
    path: ["order"],
  });

export type LegacyOrderStatusInput = z.infer<typeof LegacyOrderStatusSchema>;
