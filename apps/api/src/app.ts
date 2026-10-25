import express, { type Express } from "express";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { ApiError } from "./lib/api-error.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { createRequestLogger } from "./middleware/request-logger.js";
import type { DatabaseProbe } from "./modules/health/health.service.js";
import { createHealthService } from "./modules/health/health.service.js";
import { createHealthRouter } from "./modules/health/health.routes.js";
import { createAuthRouter } from "./modules/auth/auth.routes.js";
import { createJobsRouter } from "./modules/jobs/jobs.routes.js";
import { createLogsRouter } from "./modules/logs/logs.routes.js";
import { createProjectsRouter } from "./modules/projects/projects.routes.js";
import { createUploadsRouter } from "./modules/uploads/uploads.routes.js";
import { createRuntimeMetricsRouter } from "./modules/metrics/runtime-metrics.routes.js";
import type { WorkerMemory } from "@logforge/shared";
import type { ObjectStorage } from "./storage/object-storage.js";
import type { UploadConfig } from "./config/env.js";

export interface AppDependencies {
  logger: Logger;
  databaseProbe: DatabaseProbe;
  prisma: PrismaClient;
  uploadStorage?: ObjectStorage | null;
  uploadConfig?: UploadConfig;
  readWorkerMemory?: () => Promise<WorkerMemory | null>;
}

const defaultUploadConfig: UploadConfig = {
  MAX_UPLOAD_SIZE_BYTES: 100_000_000,
  R2_PRESIGNED_URL_TTL_SECONDS: 300
};
  
export function createApp({
  logger,
  databaseProbe,
  prisma,
  uploadStorage = null,
  uploadConfig = defaultUploadConfig,
  readWorkerMemory = async () => null
}: AppDependencies): Express {
  const app = express();
  const checkHealth = createHealthService(databaseProbe, logger);

  app.disable("x-powered-by");
  app.use(requestIdMiddleware);
  app.use(createRequestLogger(logger));
  app.use(express.json({ limit: "64kb" }));
  app.use("/health", createHealthRouter(checkHealth));
  app.use("/api/auth", createAuthRouter(prisma));
  app.use("/api/projects", createProjectsRouter(prisma, uploadStorage, uploadConfig));
  app.use("/api/projects", createLogsRouter(prisma));
  app.use("/api/jobs", createJobsRouter(prisma, uploadStorage, uploadConfig));
  app.use("/api/uploads", createUploadsRouter(prisma, uploadConfig));
  app.use("/api/metrics", createRuntimeMetricsRouter(prisma, logger, readWorkerMemory));
  app.use("/api", (_request, _response, next) => {
    next(new ApiError(404, "not_found", "API route was not found"));
  });
  app.use(createErrorHandler(logger));

  return app;
}
