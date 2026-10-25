import type { Request, Response } from "express";
import type { HealthResponse } from "@logforge/shared";

export function createHealthController(checkHealth: () => Promise<HealthResponse>) {
  return async function healthController(_request: Request, response: Response): Promise<void> {
    const health = await checkHealth();
    response.status(health.status === "ok" ? 200 : 503).json(health);
  };
}
