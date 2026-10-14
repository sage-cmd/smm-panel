import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { AppError } from "../errors/AppError";
import { logger } from "../lib/logger";
import { env } from "../config/env";

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  // Is this the legacy API route (POST /api/v1, but not /api/v1/rest)?
  const isLegacyRoute =
    req.originalUrl === "/api/v1" ||
    (req.originalUrl.startsWith("/api/v1") && !req.originalUrl.startsWith("/api/v1/rest"));

  // 1. Handled AppError
  if (err instanceof AppError) {
    logger.warn(`AppError [${err.statusCode}] [${err.code}]: ${err.message}`, {
      path: req.originalUrl,
      method: req.method,
      details: err.details,
    });

    if (isLegacyRoute) {
      // Legacy SMM panels expect {"error": "message"}
      res.status(200).json({ error: err.message });
      return;
    }

    res.status(err.statusCode).json({
      status: "error",
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  // 2. Zod Schema Validation Error
  if (err instanceof ZodError) {
    const formattedErrors = err.issues.map((i) => ({
      field: i.path.join("."),
      message: i.message,
    }));

    logger.warn("Validation Error (Zod):", {
      path: req.originalUrl,
      issues: formattedErrors,
    });

    const firstMessage = formattedErrors[0]?.message || "Validation failed";

    if (isLegacyRoute) {
      res.status(200).json({ error: firstMessage });
      return;
    }

    res.status(400).json({
      status: "error",
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request payload",
        details: formattedErrors,
      },
    });
    return;
  }

  // 3. Prisma Known Request Error
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    logger.error(`Prisma error [${err.code}]: ${err.message}`, {
      code: err.code,
      meta: err.meta,
      path: req.originalUrl,
    });

    if (err.code === "P2002") {
      const target = Array.isArray(err.meta?.target)
        ? (err.meta?.target as string[]).join(", ")
        : "unique field";
      const message = `A record with this ${target} already exists.`;

      if (isLegacyRoute) {
        res.status(200).json({ error: message });
        return;
      }

      res.status(409).json({
        status: "error",
        error: {
          code: "CONFLICT",
          message,
        },
      });
      return;
    }

    if (err.code === "P2025") {
      const message = "Requested record not found.";
      if (isLegacyRoute) {
        res.status(200).json({ error: message });
        return;
      }

      res.status(404).json({
        status: "error",
        error: {
          code: "NOT_FOUND",
          message,
        },
      });
      return;
    }
  }

  // 4. JSON Body Parse Error (Malformed body syntax)
  if ("type" in err && err.type === "entity.parse.failed") {
    logger.warn(`Malformed JSON body: ${err.message}`);
    if (isLegacyRoute) {
      res.status(200).json({ error: "Invalid JSON payload" });
      return;
    }
    res.status(400).json({
      status: "error",
      error: {
        code: "MALFORMED_JSON",
        message: "Malformed JSON body syntax",
      },
    });
    return;
  }

  // 5. Unhandled / Unexpected Server Errors
  logger.error("Unhandled Exception:", {
    message: err.message,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
  });

  if (isLegacyRoute) {
    res.status(200).json({ error: "An unexpected internal server error occurred" });
    return;
  }

  res.status(500).json({
    status: "error",
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message:
        env.NODE_ENV === "production"
          ? "An unexpected internal server error occurred"
          : err.message,
    },
  });
}
