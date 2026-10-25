import {
  logSearchResponseSchema,
  type LogSearchQuery,
  type LogSearchResponse
} from "@logforge/shared";
import { apiRequest } from "../../../lib/api-client.js";

export async function searchProjectLogs(
  projectId: string,
  query: LogSearchQuery,
  signal?: AbortSignal
): Promise<LogSearchResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const response = await apiRequest<unknown>(
    `/projects/${projectId}/logs?${params.toString()}`,
    { signal }
  );
  return logSearchResponseSchema.parse(response);
}
