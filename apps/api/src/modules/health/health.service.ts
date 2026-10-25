import type { HealthResponse } from "@logforge/shared";
import type { Logger } from "pino";

export interface DatabaseProbe {
  checkConnection(): Promise<void>;
}

export function createHealthService(database: DatabaseProbe, logger: Logger) {
  return async function checkHealth(): Promise<HealthResponse> {
    try {
      await database.checkConnection();
      return {
        status: "ok",
        checkedAt: new Date().toISOString(),
        dependencies: { database: "connected" }
      };
    } catch (error) {
      logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Database health check failed"
      );
      return {
        status: "degraded",
        checkedAt: new Date().toISOString(),
        dependencies: { database: "unavailable" }
      };
    }
  };
}
