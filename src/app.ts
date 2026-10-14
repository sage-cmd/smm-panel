import express, { Express, Request, Response } from "express";
import helmet from "helmet";
import cors from "cors";
import { requestLogger } from "./middleware/requestLogger";
import { errorHandler } from "./middleware/errorHandler";
import { isPrismaHealthy } from "./lib/prisma";
import { isRedisHealthy } from "./lib/redis";
import { NotFoundError } from "./errors/AppError";
import { legacyRouter } from "./modules/legacy/legacy.router";
import { restRouter } from "./modules/rest/rest.router";

export function createApp(): Express {
  const app = express();

  // 1. Security & Header Middlewares
  app.use(helmet());
  app.use(cors());

  // 2. Request Parsing & Payload Limits (1MB limit to protect against payload exhaustion)
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  // 3. HTTP Request Logging (with redaction)
  app.use(requestLogger);

  // 4. Infrastructure Health Check Endpoint
  app.get("/health", async (_req: Request, res: Response) => {
    const [dbHealthy, redisHealthy] = await Promise.all([isPrismaHealthy(), isRedisHealthy()]);

    const isHealthy = dbHealthy; // Redis can be marked degraded if not yet populated

    const statusCode = isHealthy ? 200 : 503;
    res.status(statusCode).json({
      status: isHealthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      services: {
        database: dbHealthy ? "connected" : "disconnected",
        redis: redisHealthy ? "connected" : "disconnected",
      },
    });
  });

  // Base ping endpoint
  app.get("/", (_req: Request, res: Response) => {
    res.json({
      name: "smm-panel-backend",
      version: "1.0.0",
      status: "running",
    });
  });

  // 5. Modern REST API (GET/POST/PATCH/DELETE /api/v1/rest/...)
  app.use("/api/v1/rest", restRouter);

  // 6. Legacy SMM API (POST /api/v1)
  app.use("/api/v1", legacyRouter);

  // 7. Catch-all 404 Route for Unmatched Paths
  app.use((req: Request) => {
    throw new NotFoundError(`Endpoint '${req.method} ${req.originalUrl}' not found`);
  });

  // 6. Centralized Error-Handling Middleware
  app.use(errorHandler);

  return app;
}

export const app = createApp();
