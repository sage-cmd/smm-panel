import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    const { method, originalUrl, ip } = req;
    const { statusCode } = res;

    const logPayload = {
      method,
      url: originalUrl,
      statusCode,
      durationMs,
      ip: ip || req.socket.remoteAddress,
      userAgent: req.get("user-agent"),
    };

    if (statusCode >= 500) {
      logger.error(`HTTP ${method} ${originalUrl} -> ${statusCode} (${durationMs}ms)`, logPayload);
    } else if (statusCode >= 400) {
      logger.warn(`HTTP ${method} ${originalUrl} -> ${statusCode} (${durationMs}ms)`, logPayload);
    } else {
      logger.info(`HTTP ${method} ${originalUrl} -> ${statusCode} (${durationMs}ms)`, logPayload);
    }
  });

  next();
}
