import { app } from "./app";
import { env } from "./config/env";
import { connectPrisma, disconnectPrisma } from "./lib/prisma";
import { disconnectRedis } from "./lib/redis";
import { logger } from "./lib/logger";
import { Server } from "node:http";

let server: Server | null = null;

async function startServer(): Promise<void> {
  try {
    logger.info("Initializing SMM Panel Backend Engine...");

    // Connect and verify database connection
    await connectPrisma();

    // Start HTTP listener
    server = app.listen(env.PORT, () => {
      logger.info(
        `✓ Server listening on http://localhost:${env.PORT} [Environment: ${env.NODE_ENV}]`,
      );
      logger.info(`✓ Health check available at: http://localhost:${env.PORT}/health`);
    });

    // Graceful Shutdown Registration
    const handleShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Starting graceful shutdown...`);

      if (server) {
        server.close(async (err) => {
          if (err) {
            logger.error("Error closing HTTP server:", err);
            process.exit(1);
          }

          logger.info("HTTP server closed.");

          try {
            await disconnectPrisma();
            await disconnectRedis();
            logger.info("All database and Redis connections successfully closed. Exiting process.");
            process.exit(0);
          } catch (cleanupErr) {
            logger.error("Error during resource cleanup:", cleanupErr);
            process.exit(1);
          }
        });

        // Force shutdown if cleanup hangs after 10 seconds
        setTimeout(() => {
          logger.error("Graceful shutdown timeout exceeded. Forcing termination.");
          process.exit(1);
        }, 10000).unref();
      } else {
        process.exit(0);
      }
    };

    process.on("SIGINT", () => void handleShutdown("SIGINT"));
    process.on("SIGTERM", () => void handleShutdown("SIGTERM"));

    process.on("unhandledRejection", (reason) => {
      logger.error("Unhandled Rejection detected:", reason);
    });

    process.on("uncaughtException", (error) => {
      logger.error("Uncaught Exception detected:", error);
      void handleShutdown("uncaughtException");
    });
  } catch (err) {
    logger.error("Fatal error during server startup:", err);
    process.exit(1);
  }
}

// Start server if executed directly
if (require.main === module) {
  void startServer();
}

export { startServer };
