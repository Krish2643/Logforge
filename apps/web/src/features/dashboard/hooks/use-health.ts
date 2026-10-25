import { useCallback, useEffect, useState } from "react";
import { getHealthStatus } from "../api/health-client.js";
import type { HealthResponse } from "@logforge/shared";

export function useHealth() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      setHealth(await getHealthStatus());
    } catch (cause) {
      setHealth(null);
      setError(cause instanceof Error ? cause.message : "Unable to reach the API");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { health, error, isLoading, refresh };
}
