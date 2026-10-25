import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { createAuthenticate } from "../../middleware/authenticate.js";
import { createSearchLogsController } from "./logs.controller.js";
import { createLogsService } from "./logs.service.js";

export function createLogsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.use(createAuthenticate(prisma));
  router.get("/:id/logs", createSearchLogsController(createLogsService(prisma)));

  return router;
}
