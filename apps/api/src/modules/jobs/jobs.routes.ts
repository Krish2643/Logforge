import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { createAuthenticate } from "../../middleware/authenticate.js";
import {
  createCancelJobController,
  createGetJobController,
  createJobController,
  createRetryJobController
} from "./jobs.controller.js";
import { createJobsService } from "./jobs.service.js";
import type { ObjectStorage } from "../../storage/object-storage.js";
import type { UploadConfig } from "../../config/env.js";
import {
  createCompleteUploadController,
  createCreateUploadUrlController,
  createDeleteRejectedUploadController
} from "../uploads/uploads.controller.js";
import { createUploadService } from "../uploads/uploads.service.js";

export function createJobsRouter(
  prisma: PrismaClient,
  storage: ObjectStorage | null,
  config: UploadConfig
): Router {
  const router = Router();
  const jobs = createJobsService(prisma, storage);
  const uploads = createUploadService(prisma, storage, config);

  router.use(createAuthenticate(prisma));
  router.get("/:id", createGetJobController(jobs));
  router.post("/:id/cancel", createCancelJobController(jobs));
  router.post("/:id/retry", createRetryJobController(jobs));
  router.post("/:id/upload-url", createCreateUploadUrlController(uploads));
  router.post("/:id/complete", createCompleteUploadController(uploads));
  router.post("/:id/cleanup", createDeleteRejectedUploadController(uploads));

  return router;
}
