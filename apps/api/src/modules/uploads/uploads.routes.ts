import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type { UploadConfig } from "../../config/env.js";
import { createAuthenticate } from "../../middleware/authenticate.js";
import { createUploadLimitsController } from "./uploads.controller.js";

export function createUploadsRouter(prisma: PrismaClient, config: UploadConfig): Router {
  const router = Router();
  router.use(createAuthenticate(prisma));
  router.get("/limits", createUploadLimitsController(config));
  return router;
}
