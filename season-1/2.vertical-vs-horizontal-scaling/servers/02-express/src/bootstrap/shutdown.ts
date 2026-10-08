import type { Server } from "node:http";
import { logger } from "./logger.js";
import { disconnectDatabase } from "./database.js";
import { disconnectRedis } from "./redis.js";
import { markMongoShuttingDown } from "./mongo-topology.js";
import {shutdownTracing} from '../observability/tracing.js';

export const registerProcessHandlers = (): void => {
  process.on("uncaughtException", (err: Error) => {
    logger.error(`Uncaught exception: ${err.stack ?? err.message}`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    logger.error(`Unhandled rejection: ${String(reason)}`);
    process.exit(1);
  });
};

export const registerGracefulShutdown = (server: Server): void => {
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    markMongoShuttingDown();
    const deadline = setTimeout(() => {
      logger.error({ event: "shutdown-deadline-exceeded" });
      server.closeAllConnections();
      process.exit(1);
    }, 20000);
    deadline.unref();
    logger.info(`${signal} received, shutting down gracefully`);
    server.closeIdleConnections();
    server.close(() => {
      void (async () => {
        await Promise.all([disconnectDatabase(), disconnectRedis()]);
        await shutdownTracing();
      })().then(() => { clearTimeout(deadline); process.exit(0); }, () => process.exit(1));
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};
