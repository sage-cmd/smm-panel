import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { UnauthorizedError, ForbiddenError } from "../errors/AppError";
import { Role } from "@prisma/client";

/**
 * Admin Authorization Middleware
 *
 * Runs after primary authentication (`authenticateApiKey`).
 * Loads the user's role and status directly from the database (not just token context).
 *
 * Requirements:
 * - Returns 401 Unauthorized if unauthenticated.
 * - Returns 403 Forbidden if user is inactive or role is not ADMIN.
 */
export async function adminAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      throw new UnauthorizedError("Authentication required", "UNAUTHENTICATED");
    }

    // Load fresh role & active state directly from database
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        balance: true,
        currency: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError("User account not found", "USER_NOT_FOUND");
    }

    if (!user.isActive) {
      throw new ForbiddenError("User account has been deactivated", "ACCOUNT_DEACTIVATED");
    }

    if (user.role !== Role.ADMIN) {
      throw new ForbiddenError("Admin access required", "FORBIDDEN");
    }

    // Attach fresh verified user record to request
    req.user = {
      ...req.user,
      ...user,
    };

    next();
  } catch (err) {
    next(err);
  }
}
