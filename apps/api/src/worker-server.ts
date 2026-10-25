import { loadEnvironmentFile, parseEnvironment } from "./config/env.js";
import { prisma } from "./db/prisma.js";
import { createLogger } from "./lib/logger.js";
import { startWorkerOutboxRelay, createProcessingWorker } from "./processing/worker.js";
import { createR2Storage } from "./storage/r2-storage.js";

function startWorker(): void {
  loadEnvironmentFile();
  const config = parseEnvironment();
  const logger = createLogger(config.LOG_LEVEL);
  const storage = createR2Storage(config);
  const processing = createProcessingWorker({ prisma, storage, config, logger });
  const relay = startWorkerOutboxRelay(prisma, logger, config);
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Log processing worker shutting down");
    relay.close();
    try {
      await processing.worker.close();
      await processing.closeMetrics();
      await prisma.$disconnect();
    } catch (error) {
      logger.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Log processing worker shutdown failed"
      );
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

try {
  startWorker();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(JSON.stringify({ level: "fatal", message }));
  process.exitCode = 1;
}
