import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { createAuthenticate } from "../../middleware/authenticate.js";
import {
  createListProjectsController,
  createProjectController
} from "./projects.controller.js";
import { createJobController, createListProjectJobsController } from "../jobs/jobs.controller.js";
import { createJobsService } from "../jobs/jobs.service.js";
import { createProjectsService } from "./projects.service.js";
import type { ObjectStorage } from "../../storage/object-storage.js";
import type { UploadConfig } from "../../config/env.js";
import { createInitializeUploadController } from "../uploads/uploads.controller.js";
import { createUploadService } from "../uploads/uploads.service.js";

export function createProjectsRouter(
  prisma: PrismaClient,
  storage: ObjectStorage | null,
  config: UploadConfig
): Router {
  const router = Router();
  const projects = createProjectsService(prisma);
  const jobs = createJobsService(prisma);
  const uploads = createUploadService(prisma, storage, config);

  router.use(createAuthenticate(prisma));
  router.post("/", createProjectController(projects));
  router.get("/", createListProjectsController(projects));
  router.post("/:id/jobs", createJobController(jobs));
  router.get("/:id/jobs", createListProjectJobsController(jobs));
  router.post("/:id/uploads", createInitializeUploadController(uploads));

  return router;
}
