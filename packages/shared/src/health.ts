import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  checkedAt: z.string().datetime(),
  dependencies: z.object({
    database: z.enum(["connected", "unavailable"])
  })
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
