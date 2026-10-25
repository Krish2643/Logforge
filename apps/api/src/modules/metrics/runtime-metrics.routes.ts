import { Router } from "express";
import type { Logger } from "pino";
import { createAuthenticate } from "../../middleware/authenticate.js";
import type { ProcessMemory, WorkerMemory } from "@logforge/shared";
import type { PrismaClient } from "@prisma/client";
import { captureProcessMemory } from "../../processing/runtime-memory.js";

export function createRuntimeMetricsRouter(
  prisma: PrismaClient,
  logger: Logger,
  readWorkerSnapshot: () => Promise<WorkerMemory | null>
): Router {
  const router = Router();
  router.use(createAuthenticate(prisma));
  router.get("/runtime", async (_request, response) => {
    let worker: WorkerMemory | null = null;
    let workerStatus: "available" | "not_reported" | "unavailable" = "not_reported";
    try {
      worker = await readWorkerSnapshot();
      if (worker) workerStatus = "available";
    } catch (error) {
      workerStatus = "unavailable";
      logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Unable to read worker memory metrics"
      );
    }
    const api: ProcessMemory = captureProcessMemory();
    response.status(200).json({ api, workerStatus, worker });
  });
  return router;
}
