import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";
import { logger } from "./logger";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      env.NODE_ENV === "development"
        ? [
            { emit: "event", level: "query" },
            { emit: "stdout", level: "error" },
            { emit: "stdout", level: "warn" },
          ]
        : [{ emit: "stdout", level: "error" }],
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Connects to PostgreSQL and verifies the connection.
 */
export async function connectPrisma(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info("Database connection successfully established via Prisma.");
  } catch (error) {
    logger.error("Failed to connect to PostgreSQL via Prisma:", error);
    throw error;
  }
}

/**
 * Disconnects Prisma client cleanly.
 */
export async function disconnectPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
    logger.info("Prisma database connection cleanly disconnected.");
  } catch (error) {
    logger.error("Error disconnecting Prisma:", error);
  }
}

/**
 * Checks PostgreSQL connection health.
 */
export async function isPrismaHealthy(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
