import { apiRequest } from "../../../lib/api-client.js";
import { healthResponseSchema } from "@logforge/shared";

export async function getHealthStatus(signal?: AbortSignal) {
  const result = healthResponseSchema.safeParse(
    await apiRequest<unknown>("/health", {
      signal,
      authenticated: false,
      acceptedStatuses: [503]
    })
  );
  if (!result.success) {
    throw new Error("The API returned an invalid health response");
  }

  return result.data;
}
