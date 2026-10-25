import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type { Queue } from "bullmq";
import type { ProcessingQueuePayload } from "./queue.js";

export async function dispatchPendingOutbox(
  prisma: PrismaClient,
  queue: Queue<ProcessingQueuePayload>,
  logger: Logger,
  batchLimit = 50
): Promise<number> {
  const pending = await prisma.processingOutbox.findMany({
    where: { dispatchedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchLimit,
    select: {
      id: true,
      ingestionJobId: true,
      processingAttempt: true,
      ingestionJob: { select: { status: true, processingAttempt: true } }
    }
  });
  let dispatchedCount = 0;

  for (const event of pending) {
    if (
      event.ingestionJob.status !== "queued" ||
      event.ingestionJob.processingAttempt !== event.processingAttempt
    ) {
      continue;
    }
    try {
      await queue.add(
        "process-ingestion-job",
        {
          ingestionJobId: event.ingestionJobId,
          processingAttempt: event.processingAttempt
        },
        { jobId: `${event.ingestionJobId}-${event.processingAttempt}` }
      );
      const updated = await prisma.processingOutbox.updateMany({
        where: {
          id: event.id,
          processingAttempt: event.processingAttempt,
          dispatchedAt: null
        },
        data: { dispatchedAt: new Date(), attempts: { increment: 1 }, lastError: null }
      });
      dispatchedCount += updated.count;
    } catch (error) {
      await prisma.processingOutbox.updateMany({
        where: { id: event.id, processingAttempt: event.processingAttempt, dispatchedAt: null },
        data: {
          attempts: { increment: 1 },
          lastError: "Queue dispatch failed; delivery will be retried."
        }
      });
      logger.warn(
        {
          ingestionJobId: event.ingestionJobId,
          errorName: error instanceof Error ? error.name : "UnknownError"
        },
        "Processing queue dispatch failed; outbox delivery will retry"
      );
    }
  }
  return dispatchedCount;
}

export function startOutboxRelay(
  prisma: PrismaClient,
  queue: Queue<ProcessingQueuePayload>,
  logger: Logger,
  intervalMilliseconds = 1_000
): { close(): void } {
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
        "Processing outbox query failed; relay will retry"
      );
    } finally {
      running = false;
    }
  };

  void dispatch();
  const timer = setInterval(() => void dispatch(), intervalMilliseconds);
  timer.unref();

  return {
    close() {
      closed = true;
      clearInterval(timer);
    }
  };
}
