import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const envFile = fileURLToPath(new URL("../../../../.env", import.meta.url));

const postgresUrlSchema = z.string().refine(
  (value) => {
    try {
      return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  },
  { message: "must be a valid PostgreSQL connection URL" }
);

const redisUrlSchema = z.string().refine(
  (value) => {
    try {
      return ["redis:", "rediss:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  },
  { message: "must be a valid Redis connection URL" }
);

const optionalEnvironmentValue = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

const environmentSchema = z.object({
  DATABASE_URL: postgresUrlSchema,
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  REDIS_URL: redisUrlSchema.default("redis://127.0.0.1:16379"),
  PROCESSING_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(500),
  MAX_LOG_LINE_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(262_144),
  R2_ACCOUNT_ID: optionalEnvironmentValue,
  R2_ACCESS_KEY_ID: optionalEnvironmentValue,
  R2_SECRET_ACCESS_KEY: optionalEnvironmentValue,
  R2_BUCKET_NAME: optionalEnvironmentValue,
  R2_ENDPOINT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().refine((value) => value.startsWith("https://"), "must use HTTPS").optional()
  ),
  R2_REGION: z.string().min(1).default("auto"),
  R2_PRESIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(1).max(900).default(300),
  MAX_UPLOAD_SIZE_BYTES: z.coerce.number().int().min(10_000_000).max(100_000_000).default(100_000_000)
}).superRefine((config, context) => {
  const storageKeys = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME"
  ] as const;
  const configuredCredentials = storageKeys.filter((key) => config[key] !== undefined).length;
  if (
    (configuredCredentials > 0 && configuredCredentials !== storageKeys.length) ||
    (config.R2_ENDPOINT !== undefined && configuredCredentials !== storageKeys.length)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["R2_ACCOUNT_ID"],
      message: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME must be configured together"
    });
  }
});

export type AppConfig = z.infer<typeof environmentSchema>;
export type UploadConfig = Pick<AppConfig, "MAX_UPLOAD_SIZE_BYTES" | "R2_PRESIGNED_URL_TTL_SECONDS">;

export function loadEnvironmentFile(): void {
  const result = dotenv.config({ path: envFile });
  const fileError = result.error as NodeJS.ErrnoException | undefined;

  if (fileError && fileError.code !== "ENOENT") {
    throw new Error(`Unable to read the project .env file: ${fileError.message}`);
  }
}

export function parseEnvironment(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}
