import {
  runtimeMetricsResponseSchema,
  type RuntimeMetricsResponse
} from "@logforge/shared";
import { apiRequest } from "../../../lib/api-client.js";

export async function getRuntimeMetrics(signal?: AbortSignal): Promise<RuntimeMetricsResponse> {
  const response = await apiRequest<unknown>("/metrics/runtime", { signal });
  return runtimeMetricsResponseSchema.parse(response);
}

