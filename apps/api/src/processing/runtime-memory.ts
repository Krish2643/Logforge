import { Redis } from "ioredis";
import type { Logger } from "pino";
import { workerMemorySchema, type WorkerMemory } from "@logforge/shared";
import type { AppConfig } from "../config/env.js";

export const WORKER_MEMORY_KEY = "logforge:runtime:worker";
const SNAPSHOT_TTL_SECONDS = 20;

export function createMetricsRedis(config: AppConfig): Redis {
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000
  });
  return redis;
}

export function captureProcessMemory(): {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  sampledAt: string;
  uptimeSeconds: number;
} {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    sampledAt: new Date().toISOString(),
    uptimeSeconds: process.uptime()
  };
}

export function createWorkerMemoryReporter(redis: Redis, logger: Logger) {
  const activeJobs = new Map<string, number>();
  let peakRssBytesDuringProcessing = 0;
  let peakHeapUsedBytesDuringProcessing = 0;
  let peakWindowEndedAt: string | null = null;
  let publishing = false;
  let closed = false;

  async function publish(): Promise<void> {
    if (publishing || closed) return;
    publishing = true;
    const memory = captureProcessMemory();
    if (activeJobs.size > 0) {
      peakRssBytesDuringProcessing = Math.max(peakRssBytesDuringProcessing, memory.rssBytes);
      peakHeapUsedBytesDuringProcessing = Math.max(
        peakHeapUsedBytesDuringProcessing,
        memory.heapUsedBytes
      );
    }
    const snapshot: WorkerMemory = workerMemorySchema.parse({
      ...memory,
      activeJobIds: [...activeJobs.keys()],
      peakRssBytesDuringProcessing,
      peakHeapUsedBytesDuringProcessing,
      peakWindowEndedAt
    });
    try {
      await redis.set(WORKER_MEMORY_KEY, JSON.stringify(snapshot), "EX", SNAPSHOT_TTL_SECONDS);
    } catch (error) {
      logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Unable to publish worker memory metrics"
      );
    } finally {
      publishing = false;
    }
  }

  redis.on("error", (error: Error) => {
    logger.warn({ errorName: error.name }, "Worker memory metrics Redis connection error");
  });

  const timer = setInterval(() => void publish(), 1_000);
  timer.unref();
  void publish();

  return {
    startJob(jobId: string): void {
      if (activeJobs.size === 0) {
        peakRssBytesDuringProcessing = 0;
        peakHeapUsedBytesDuringProcessing = 0;
        peakWindowEndedAt = null;
      }
      activeJobs.set(jobId, (activeJobs.get(jobId) ?? 0) + 1);
      void publish();
    },
    finishJob(jobId: string): void {
      const memory = process.memoryUsage();
      peakRssBytesDuringProcessing = Math.max(peakRssBytesDuringProcessing, memory.rss);
      peakHeapUsedBytesDuringProcessing = Math.max(
        peakHeapUsedBytesDuringProcessing,
        memory.heapUsed
      );
      const activeCount = activeJobs.get(jobId) ?? 0;
      if (activeCount <= 1) activeJobs.delete(jobId);
      else activeJobs.set(jobId, activeCount - 1);
      if (activeJobs.size === 0) peakWindowEndedAt = new Date().toISOString();
      void publish();
    },
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      try {
        await redis.quit();
      } catch {
        redis.disconnect();
      }
    }
  };
}

export async function readWorkerMemory(redis: Redis): Promise<WorkerMemory | null> {
  const value = await redis.get(WORKER_MEMORY_KEY);
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Worker memory snapshot is not valid JSON");
  }
  const snapshot = workerMemorySchema.parse(parsed);
  if (Date.now() - Date.parse(snapshot.sampledAt) > 5_000) return null;
  return snapshot;
}
