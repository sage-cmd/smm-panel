import { z } from "zod";
import Decimal from "decimal.js";
import { OrderStatus, Role } from "@prisma/client";

// ==============================================================================
// Parameter Schemas
// ==============================================================================

/**
 * Validates integer service ID route parameters.
 */
export const AdminServiceIdParamSchema = z
  .object({
    id: z
      .string()
      .regex(/^\d+$/, "Service ID must be a valid positive integer")
      .transform((val) => parseInt(val, 10)),
  })
  .strict();

export type AdminServiceIdParam = z.infer<typeof AdminServiceIdParamSchema>;

/**
 * Validates UUID user ID route parameters.
 */
export const AdminUserIdParamSchema = z
  .object({
    id: z.string().uuid("User ID must be a valid UUID"),
  })
  .strict();

export type AdminUserIdParam = z.infer<typeof AdminUserIdParamSchema>;

/**
 * Validates integer order ID route parameters.
 */
export const AdminOrderIdParamSchema = z
  .object({
    id: z
      .string()
      .regex(/^\d+$/, "Order ID must be a valid positive integer")
      .transform((val) => parseInt(val, 10)),
  })
  .strict();

export type AdminOrderIdParam = z.infer<typeof AdminOrderIdParamSchema>;

// ==============================================================================
// Services Schemas
// ==============================================================================

/**
 * Validates query parameters for listing services in admin panel.
 */
export const AdminGetServicesQuerySchema = z
  .object({
    page: z
      .string()
      .optional()
      .transform((val) => (val !== undefined ? parseInt(val, 10) : 1))
      .refine((val) => !isNaN(val) && val >= 1, "Page must be an integer >= 1"),
    limit: z
      .string()
      .optional()
      .transform((val) => (val !== undefined ? parseInt(val, 10) : 20))
      .refine(
        (val) => !isNaN(val) && val >= 1 && val <= 100,
        "Limit must be an integer between 1 and 100",
      ),
    category: z.string().trim().min(1).optional(),
    isActive: z
      .string()
      .optional()
      .transform((val) => {
        if (val === undefined) return undefined;
        if (val.toLowerCase() === "true" || val === "1") return true;
        if (val.toLowerCase() === "false" || val === "0") return false;
        return undefined;
      }),
  })
  .strict();

export type AdminGetServicesQuery = z.infer<typeof AdminGetServicesQuerySchema>;

/**
 * Validates payload for creating a new service.
 */
export const AdminCreateServiceSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(255),
    category: z.string().trim().min(1, "Category is required").max(100),
    ratePer1000: z
      .union([z.string(), z.number()])
      .refine(
        (val) => {
          try {
            const d = new Decimal(val.toString());
            return d.isPositive() && !d.isZero() && d.isFinite();
          } catch {
            return false;
          }
        },
        { message: "ratePer1000 must be a positive monetary decimal" },
      )
      .transform((val) => new Decimal(val.toString())),
    minQuantity: z.number().int().min(1, "minQuantity must be at least 1"),
    maxQuantity: z.number().int().min(1, "maxQuantity must be at least 1"),
    type: z.string().trim().min(1).default("Default"),
    description: z.string().trim().optional().nullable(),
    supportsDripfeed: z.boolean().default(false),
  })
  .strict()
  .refine((data) => data.minQuantity <= data.maxQuantity, {
    message: "minQuantity must be less than or equal to maxQuantity",
    path: ["maxQuantity"],
  });

export type AdminCreateServiceInput = z.infer<typeof AdminCreateServiceSchema>;

/**
 * Validates payload for updating an existing service.
 */
export const AdminUpdateServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    ratePer1000: z
      .union([z.string(), z.number()])
      .refine(
        (val) => {
          try {
            const d = new Decimal(val.toString());
            return d.isPositive() && !d.isZero() && d.isFinite();
          } catch {
            return false;
          }
        },
        { message: "ratePer1000 must be a positive monetary decimal" },
      )
      .transform((val) => new Decimal(val.toString()))
      .optional(),
    minQuantity: z.number().int().min(1).optional(),
    maxQuantity: z.number().int().min(1).optional(),
    type: z.string().trim().min(1).optional(),
    description: z.string().trim().optional().nullable(),
    supportsDripfeed: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update",
  })
  .refine(
    (data) => {
      if (data.minQuantity !== undefined && data.maxQuantity !== undefined) {
        return data.minQuantity <= data.maxQuantity;
      }
      return true;
    },
    {
      message: "minQuantity must be less than or equal to maxQuantity",
      path: ["maxQuantity"],
    },
  );

export type AdminUpdateServiceInput = z.infer<typeof AdminUpdateServiceSchema>;

// ==============================================================================
// Users Schemas
// ==============================================================================

/**
 * Validates query parameters for listing users in admin panel.
 */
export const AdminGetUsersQuerySchema = z
  .object({
    page: z
      .string()
      .optional()
      .transform((val) => (val !== undefined ? parseInt(val, 10) : 1))
      .refine((val) => !isNaN(val) && val >= 1, "Page must be an integer >= 1"),
    limit: z
      .string()
      .optional()
      .transform((val) => (val !== undefined ? parseInt(val, 10) : 20))
      .refine(
        (val) => !isNaN(val) && val >= 1 && val <= 100,
        "Limit must be an integer between 1 and 100",
      ),
    search: z.string().trim().optional(),
    email: z.string().trim().optional(),
    minBalance: z
      .string()
      .optional()
      .refine((val) => val === undefined || (!isNaN(Number(val)) && !isNaN(parseFloat(val))), {
        message: "minBalance must be a valid number",
      })
      .transform((val) => (val !== undefined ? new Decimal(val) : undefined)),
    maxBalance: z
      .string()
      .optional()
      .refine((val) => val === undefined || (!isNaN(Number(val)) && !isNaN(parseFloat(val))), {
        message: "maxBalance must be a valid number",
      })
      .transform((val) => (val !== undefined ? new Decimal(val) : undefined)),
    role: z.nativeEnum(Role).optional(),
    isActive: z
      .string()
      .optional()
      .transform((val) => {
        if (val === undefined) return undefined;
        if (val.toLowerCase() === "true" || val === "1") return true;
        if (val.toLowerCase() === "false" || val === "0") return false;
        return undefined;
      }),
  })
  .strict();

export type AdminGetUsersQuery = z.infer<typeof AdminGetUsersQuerySchema>;

/**
 * Validates payload for manual administrative balance adjustments.
 */
export const AdminAdjustBalanceSchema = z
  .object({
    amount: z
      .union([z.string(), z.number()])
      .refine(
        (val) => {
          try {
            const d = new Decimal(val.toString());
            return !d.isZero() && d.isFinite();
          } catch {
            return false;
          }
        },
        { message: "Amount must be a non-zero valid decimal number (+ for credit, - for debit)" },
      )
      .transform((val) => new Decimal(val.toString())),
    reason: z
      .string()
      .trim()
      .min(3, "Reason must be at least 3 characters")
      .max(255, "Reason cannot exceed 255 characters"),
  })
  .strict();

export type AdminAdjustBalanceInput = z.infer<typeof AdminAdjustBalanceSchema>;

/**
 * Validates payload for updating a user's active/banned status.
 */
export const AdminUpdateUserStatusSchema = z
  .object({
    isActive: z.boolean({ required_error: "isActive boolean is required" }),
  })
  .strict();

export type AdminUpdateUserStatusInput = z.infer<typeof AdminUpdateUserStatusSchema>;

// ==============================================================================
// Orders Schemas
// ==============================================================================

/**
 * Validates query parameters for listing orders in admin panel.
 */
export const AdminGetOrdersQuerySchema = z
  .object({
    page: z
      .string()
      .optional()
      .transform((val) => (val !== undefined ? parseInt(val, 10) : 1))
      .refine((val) => !isNaN(val) && val >= 1, "Page must be an integer >= 1"),
    limit: z
      .string()
      .optional()
      .transform((val) => (val !== undefined ? parseInt(val, 10) : 20))
      .refine(
        (val) => !isNaN(val) && val >= 1 && val <= 100,
        "Limit must be an integer between 1 and 100",
      ),
    status: z.nativeEnum(OrderStatus).optional(),
    userId: z.string().uuid("Invalid userId UUID").optional(),
    serviceId: z
      .string()
      .regex(/^\d+$/, "serviceId must be an integer")
      .transform((val) => parseInt(val, 10))
      .optional(),
  })
  .strict();

export type AdminGetOrdersQuery = z.infer<typeof AdminGetOrdersQuerySchema>;

/**
 * Validates payload for administrative order status transitions.
 */
export const AdminUpdateOrderStatusSchema = z
  .object({
    status: z.nativeEnum(OrderStatus, {
      errorMap: () => ({
        message: "Status must be one of: PENDING, PROCESSING, COMPLETED, CANCELED, PARTIAL",
      }),
    }),
  })
  .strict();

export type AdminUpdateOrderStatusInput = z.infer<typeof AdminUpdateOrderStatusSchema>;
