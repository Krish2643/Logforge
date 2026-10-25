import { Router } from "express";
import type { HealthResponse } from "@logforge/shared";
import { createHealthController } from "./health.controller.js";

export function createHealthRouter(checkHealth: () => Promise<HealthResponse>): Router {
  const router = Router();
  router.get("/", createHealthController(checkHealth));
  return router;
}
