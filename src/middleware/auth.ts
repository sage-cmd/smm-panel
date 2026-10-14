import { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import { UnauthorizedError } from "../errors/AppError";
import { logger } from "../lib/logger";

/**
 * Dual-Mode Authentication Middleware
 *
 * 1. Primary: Authorization: Bearer <api_key> header
 * 2. Legacy Fallback: `key` property in JSON request body (only if Authorization header is ABSENT)
 *
 * Explicit Security Rule:
 * If an Authorization header is provided but invalid/malformed, the request MUST be rejected
 * immediately without falling back to the body key.
 */
export async function authenticateApiKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    let rawApiKey: string | undefined;

    if (authHeader !== undefined) {
      // Header is present: validate Bearer scheme strictly
      const parts = authHeader.trim().split(/\s+/);
      if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
        throw new UnauthorizedError(
          "Invalid Authorization header format. Expected 'Bearer <api_key>'",
          "INVALID_AUTH_HEADER",
        );
      }

      const token = parts[1]?.trim();
      if (!token) {
        throw new UnauthorizedError(
          "API key token is missing in Authorization header",
          "MISSING_API_KEY",
        );
      }

      rawApiKey = token;
    } else {
      // Header is absent: fall back to legacy body key
      const bodyKey = req.body?.key;
      if (typeof bodyKey === "string" && bodyKey.trim().length > 0) {
        rawApiKey = bodyKey.trim();
      } else {
        throw new UnauthorizedError(
          "Authentication credentials missing. Provide 'Authorization: Bearer <api_key>' header or 'key' in body.",
          "UNAUTHENTICATED",
        );
      }
    }

    // Cryptographic SHA-256 hash lookup (never query or store plaintext keys)
    const keyHash = crypto.createHash("sha256").update(rawApiKey).digest("hex");

    const apiKey = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: { user: true },
    });

    if (!apiKey) {
      throw new UnauthorizedError("Invalid API key", "INVALID_API_KEY");
    }

    if (!apiKey.isActive) {
      throw new UnauthorizedError("API key has been deactivated", "API_KEY_INACTIVE");
    }

    if (!apiKey.user) {
      throw new UnauthorizedError("Associated user account not found", "USER_NOT_FOUND");
    }

    // Update lastUsedAt asynchronously without blocking request execution
    prisma.apiKey
      .update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err) => {
        logger.warn(`Failed to update lastUsedAt for API key ${apiKey.id}: ${err.message}`);
      });

    // Attach strongly-typed User and ApiKey to Express Request context
    req.user = apiKey.user;
    req.apiKey = apiKey;

    next();
  } catch (err) {
    next(err);
  }
}
