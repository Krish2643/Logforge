import { createApp } from "./app.js";
import { loadEnvironmentFile, parseEnvironment } from "./config/env.js";
import { databaseProbe, prisma } from "./db/prisma.js";
import { createLogger } from "./lib/logger.js";
import { createR2Storage } from "./storage/r2-storage.js";
import { createProcessingQueue } from "./processing/queue.js";
import { startOutboxRelay } from "./processing/outbox-relay.js";
import { createMetricsRedis, readWorkerMemory } from "./processing/runtime-memory.js";

function startServer(): void {
  loadEnvironmentFile();
  const config = parseEnvironment();
  const logger = createLogger(config.LOG_LEVEL);
  const processingQueue = createProcessingQueue(config);
  const metricsRedis = createMetricsRedis(config);
  const outboxRelay = startOutboxRelay(prisma, processingQueue, logger);
  const app = createApp({
    logger,
    databaseProbe,
    prisma,
    uploadStorage: createR2Storage(config),
    uploadConfig: config,
    readWorkerMemory: () => readWorkerMemory(metricsRedis)
  });
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "LogForge API listening");
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down API");
    outboxRelay.close();

    server.close((error) => {
      if (error) {
        logger.error({ errorName: error.name }, "HTTP server shutdown failed");
        process.exitCode = 1;
      }

      void prisma
        .$disconnect()
        .catch((disconnectError: unknown) => {
          logger.error(
            {
              errorName:
                disconnectError instanceof Error ? disconnectError.name : "UnknownError"
            },
            "Prisma shutdown failed"
          );
          process.exitCode = 1;
        })
        .finally(() => {
          void processingQueue.close();
          void metricsRedis.quit().catch(() => metricsRedis.disconnect());
        });
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.on("error", (error: Error) => {
    logger.fatal({ errorName: error.name }, "API server failed to start");
    process.exitCode = 1;
  });
}

try {
  startServer();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(JSON.stringify({ level: "fatal", message }));
  process.exitCode = 1;
}
