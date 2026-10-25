import { Worker, UnrecoverableError } from "bullmq";
import type { Logger } from "pino";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../config/env.js";
import type { ObjectStorage } from "../storage/object-storage.js";
import { dispatchPendingOutbox } from "./outbox-relay.js";
import {
  createProcessingQueue,
  PROCESSING_QUEUE_NAME,
  redisConnection,
  type ProcessingQueuePayload
} from "./queue.js";
import { createIngestionProcessor } from "./processor.js";
import { createMetricsRedis, createWorkerMemoryReporter } from "./runtime-memory.js";

export function createProcessingWorker(input: {
  prisma: PrismaClient;
  storage: ObjectStorage | null;
  config: AppConfig;
  logger: Logger;
}) {
  const processor = createIngestionProcessor(input.prisma, input.storage, input.config);
  const memoryRedis = createMetricsRedis(input.config);
  const memoryReporter = createWorkerMemoryReporter(memoryRedis, input.logger);
  const worker = new Worker<ProcessingQueuePayload>(
    PROCESSING_QUEUE_NAME,
    async (queueJob) => {
      const startedAt = Date.now();
      const record = await input.prisma.ingestionJob.findUnique({
        where: { id: queueJob.data.ingestionJobId },
        select: { projectId: true }
      });
      memoryReporter.startJob(queueJob.data.ingestionJobId);
      input.logger.info(
        {
          ingestionJobId: queueJob.data.ingestionJobId,
          projectId: record?.projectId,
          attempt: queueJob.attemptsMade + 1
        },
        "Log processing started"
      );
      try {
        await processor(queueJob.data);
        input.logger.info(
          {
            ingestionJobId: queueJob.data.ingestionJobId,
            projectId: record?.projectId,
            durationMilliseconds: Date.now() - startedAt
          },
          "Log processing completed"
        );
      } catch (error) {
        input.logger.error(
          {
            ingestionJobId: queueJob.data.ingestionJobId,
            projectId: record?.projectId,
            errorName: error instanceof Error ? error.name : "UnknownError",
            durationMilliseconds: Date.now() - startedAt
          },
          "Log processing attempt failed"
        );
        throw error;
      } finally {
        memoryReporter.finishJob(queueJob.data.ingestionJobId);
      }
    },
    {
      connection: redisConnection(input.config),
      concurrency: 2
    }
  );

  worker.on("failed", (queueJob, error) => {
    if (!queueJob) return;
    const exhausted =
      error instanceof UnrecoverableError ||
      queueJob.attemptsMade >= (queueJob.opts.attempts ?? 1);
    if (!exhausted) return;

    void input.prisma.$transaction(async (transaction) => {
      const [state] = await transaction.$queryRaw<Array<{
        status: string;
        cancel_requested_at: Date | null;
        processing_attempt: number;
      }>>`
      SELECT status::text AS status, cancel_requested_at, processing_attempt
        FROM ingestion_jobs
        WHERE id = ${queueJob.data.ingestionJobId}::uuid
        FOR UPDATE
      `;
      if (
        !state ||
        state.processing_attempt !== (queueJob.data.processingAttempt ?? 0) ||
        !["queued", "processing"].includes(state.status)
      ) return;
      if (state.cancel_requested_at) {
        await transaction.ingestionJob.update({
          where: { id: queueJob.data.ingestionJobId },
          data: { status: "cancelled", processingCompletedAt: new Date() }
        });
        return;
      }
      await transaction.ingestionJob.update({
        where: { id: queueJob.data.ingestionJobId },
        data: {
          status: "failed",
          failureReason: error instanceof UnrecoverableError
            ? error.message
            : "Processing failed after retries. Check worker logs using the job ID.",
          processingCompletedAt: new Date()
        }
      });
    }).catch((databaseError: unknown) => {
      input.logger.error(
        {
          ingestionJobId: queueJob.data.ingestionJobId,
          errorName: databaseError instanceof Error ? databaseError.name : "UnknownError"
        },
        "Unable to persist final processing failure"
      );
    });
  });

  worker.on("error", (error) => {
    input.logger.error(
      { errorName: error.name },
      "Processing worker encountered a queue error"
    );
  });

  return {
    worker,
    closeMetrics: () => memoryReporter.close()
  };
}

export function startWorkerOutboxRelay(
  prisma: PrismaClient,
  logger: Logger,
  config: AppConfig
): { close(): void } {
  const queue = createProcessingQueue(config);
  let running = false;
  let closed = false;
  const dispatch = async () => {
    if (running || closed) return;
    running = true;
    try {
      await dispatchPendingOutbox(prisma, queue, logger);
    } catch (error) {
      logger.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Worker outbox relay failed; delivery will retry"
      );
    } finally {
      running = false;
    }
  };
  void dispatch();
  const timer = setInterval(() => void dispatch(), 1_000);
  timer.unref();
  return {
    close() {
      closed = true;
      clearInterval(timer);
      void queue.close();
    }
  };
}
