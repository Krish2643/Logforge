import { Queue } from "bullmq";
import type { AppConfig } from "../config/env.js";

export const PROCESSING_QUEUE_NAME = "logforge-log-processing";

export interface ProcessingQueuePayload {
  ingestionJobId: string;
  processingAttempt: number;
}

export function redisConnection(config: AppConfig) {
  const url = new URL(config.REDIS_URL);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(database) || database < 0) {
    throw new Error("REDIS_URL must use a non-negative integer database number");
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "rediss:" ? 6380 : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    db: database,
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
    maxRetriesPerRequest: null as null
  };
}

export function createProcessingQueue(config: AppConfig) {
  return new Queue<ProcessingQueuePayload>(PROCESSING_QUEUE_NAME, {
    connection: redisConnection(config),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 86_400, count: 1_000 },
      removeOnFail: { age: 604_800, count: 5_000 }
    }
  });
}
