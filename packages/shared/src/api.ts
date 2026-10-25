import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .email()
  .max(320)
  .transform((email) => email.toLowerCase());

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(12).max(128)
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128)
});

export const createProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(80)
});

export const createIngestionJobRequestSchema = z.object({}).strict();

export const uuidSchema = z.string().uuid();

export const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);

export const logSearchQuerySchema = z
  .object({
    level: logLevelSchema.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    q: z.string().trim().min(1).max(256).optional(),
    service: z.string().trim().min(1).max(255).optional(),
    httpStatus: z.coerce.number().int().min(100).max(599).optional(),
    requestId: z.string().trim().min(1).max(256).optional(),
    jobId: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: uuidSchema.optional()
  })
  .strict()
  .superRefine((query, context) => {
    if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "must be earlier than or equal to to"
      });
    }
  });

export const ingestionJobListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: uuidSchema.optional()
  })
  .strict();

export const userResponseSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  createdAt: z.string().datetime()
});

export const authSessionResponseSchema = z.object({
  user: userResponseSchema,
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresAt: z.string().datetime()
});

export const projectResponseSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const projectsResponseSchema = z.object({
  projects: z.array(projectResponseSchema)
});

export const ingestionJobResponseSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  status: z.enum(["created", "uploaded", "queued", "processing", "completed", "failed", "cancelled"]),
  processingAttempt: z.number().int().nonnegative(),
  originalFilename: z.string().nullable(),
  fileSizeBytes: z.number().int().nullable(),
  contentType: z.string().nullable(),
  uploadCompletedAt: z.string().datetime().nullable(),
  cleanupPending: z.boolean(),
  bytesProcessed: z.number().int().nonnegative(),
  linesProcessed: z.number().int().nonnegative(),
  eventsPersisted: z.number().int().nonnegative(),
  malformedLines: z.number().int().nonnegative(),
  failureReason: z.string().nullable(),
  cancelRequestedAt: z.string().datetime().nullable(),
  processingStartedAt: z.string().datetime().nullable(),
  processingCompletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const ingestionJobsResponseSchema = z.object({
  jobs: z.array(ingestionJobResponseSchema),
  nextCursor: uuidSchema.nullable()
});

export const uploadInitializationRequestSchema = z.object({
  filename: z.string().trim().min(1).max(255)
    .refine((filename) => !/[\/\\\u0000-\u001f\u007f]/u.test(filename), "must be a filename, not a path")
    .refine((filename) => !/^\.+$/u.test(filename), "must be a valid filename"),
  fileSizeBytes: z.number().int().min(1),
  idempotencyKey: uuidSchema
}).strict();

export const uploadInitializationResponseSchema = z.object({
  job: ingestionJobResponseSchema,
  upload: z.object({
    url: z.string().url(),
    method: z.literal("PUT"),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string().datetime()
  })
});

export const uploadLimitsResponseSchema = z.object({
  minimumFileSizeBytes: z.number().int().positive(),
  maximumFileSizeBytes: z.number().int().positive(),
  supportedExtensions: z.array(z.enum([".log", ".jsonl"]))
});

export const logEventResponseSchema = z.object({
  id: uuidSchema,
  timestamp: z.string().datetime().nullable(),
  level: z.string(),
  message: z.string(),
  source: z.string().nullable(),
  ingestionJobId: uuidSchema.nullable(),
  attributes: z.unknown()
});

export const logSearchResponseSchema = z.object({
  logs: z.array(logEventResponseSchema),
  nextCursor: uuidSchema.nullable(),
  databaseQueryDurationMs: z.number().nonnegative()
});

export const processMemorySchema = z.object({
  rssBytes: z.number().nonnegative(),
  heapUsedBytes: z.number().nonnegative(),
  externalBytes: z.number().nonnegative(),
  arrayBuffersBytes: z.number().nonnegative(),
  sampledAt: z.string().datetime(),
  uptimeSeconds: z.number().nonnegative()
});

export const workerMemorySchema = processMemorySchema.extend({
  activeJobIds: z.array(uuidSchema),
  peakRssBytesDuringProcessing: z.number().nonnegative(),
  peakHeapUsedBytesDuringProcessing: z.number().nonnegative(),
  peakWindowEndedAt: z.string().datetime().nullable()
});

export const runtimeMetricsResponseSchema = z.object({
  api: processMemorySchema,
  workerStatus: z.enum(["available", "not_reported", "unavailable"]),
  worker: workerMemorySchema.nullable()
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type CreateIngestionJobRequest = z.infer<typeof createIngestionJobRequestSchema>;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;
export type IngestionJobResponse = z.infer<typeof ingestionJobResponseSchema>;
export type IngestionJobListQuery = z.infer<typeof ingestionJobListQuerySchema>;
export type IngestionJobsResponse = z.infer<typeof ingestionJobsResponseSchema>;
export type UploadInitializationRequest = z.infer<typeof uploadInitializationRequestSchema>;
export type UploadInitializationResponse = z.infer<typeof uploadInitializationResponseSchema>;
export type UploadLimitsResponse = z.infer<typeof uploadLimitsResponseSchema>;
export type LogEventResponse = z.infer<typeof logEventResponseSchema>;
export type LogSearchResponse = z.infer<typeof logSearchResponseSchema>;
export type LogSearchQuery = z.infer<typeof logSearchQuerySchema>;
export type ProcessMemory = z.infer<typeof processMemorySchema>;
export type WorkerMemory = z.infer<typeof workerMemorySchema>;
export type RuntimeMetricsResponse = z.infer<typeof runtimeMetricsResponseSchema>;
