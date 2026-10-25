import { UnrecoverableError } from "bullmq";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { AppConfig } from "../config/env.js";
import type { ObjectStorage } from "../storage/object-storage.js";
import { parseJsonLine, parseLogLine, type ParsedLogLine } from "./line-parser.js";
import { readLines } from "./line-reader.js";

export interface ProcessIngestionInput {
  ingestionJobId: string;
  processingAttempt?: number;
}

function isObjectNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ObjectNotFoundError"
  );
}

export function createIngestionProcessor(
  prisma: PrismaClient,
  storage: ObjectStorage | null,
  config: Pick<AppConfig, "PROCESSING_BATCH_SIZE" | "MAX_LOG_LINE_BYTES">
) {
  return async function processIngestionJob({
    ingestionJobId,
    processingAttempt = 0
  }: ProcessIngestionInput): Promise<void> {
    const job = await prisma.ingestionJob.findUnique({ where: { id: ingestionJobId } });
    if (!job) throw new UnrecoverableError("Ingestion job does not exist");
    if (job.processingAttempt !== processingAttempt) return;
    if (job.status === "completed") return;
    if (job.status === "cancelled") return;
    if (job.status !== "queued" && job.status !== "processing") {
      throw new UnrecoverableError("Ingestion job is not eligible for processing");
    }
    if (
      !job.objectKey ||
      !job.originalFilename ||
      !job.contentType ||
      job.fileSizeBytes === null ||
      job.fileSizeBytes <= 0
    ) {
      throw new UnrecoverableError("Ingestion job is missing upload metadata");
    }
    const fileSizeBytes = job.fileSizeBytes;
    if (!storage) throw new Error("Object storage is not configured");

    const extension = job.originalFilename.slice(job.originalFilename.lastIndexOf(".")).toLowerCase();
    if (extension !== ".log" && extension !== ".jsonl") {
      throw new UnrecoverableError("Ingestion job file type is not supported");
    }

    const claim = await prisma.$transaction(async (transaction) => {
      const [state] = await transaction.$queryRaw<Array<{
        status: string;
        cancel_requested_at: Date | null;
        processing_attempt: number;
      }>>`
        SELECT status::text AS status, cancel_requested_at, processing_attempt
        FROM ingestion_jobs
        WHERE id = ${job.id}::uuid
        FOR UPDATE
      `;
      if (
        !state ||
        state.processing_attempt !== processingAttempt ||
        state.status === "completed" ||
        state.status === "cancelled"
      ) return state?.processing_attempt !== processingAttempt ? "stale" : state?.status;
      if (state.cancel_requested_at) {
        await transaction.ingestionJob.update({
          where: { id: job.id },
          data: { status: "cancelled", processingCompletedAt: new Date() }
        });
        return "cancelled";
      }
      if (state.status !== "queued" && state.status !== "processing") return state.status;
      await transaction.ingestionJob.update({
        where: { id: job.id },
        data: {
          status: "processing",
          processingStartedAt: job.processingStartedAt ?? new Date(),
          processingCompletedAt: null,
          failureReason: null
        }
      });
      return "processing";
    });
    if (claim === "completed" || claim === "cancelled" || claim === "stale") return;
    if (claim !== "processing") {
      throw new UnrecoverableError("Ingestion job is not eligible for processing");
    }

    let input;
    try {
      input = await storage.getObjectStream(job.objectKey);
    } catch (error) {
      if (isObjectNotFound(error)) {
        throw new UnrecoverableError("The source object is missing from storage");
      }
      throw error;
    }

    const existingEventCount = await prisma.$transaction(async (transaction) => {
      const [state] = await transaction.$queryRaw<Array<{
        status: string;
        cancel_requested_at: Date | null;
        processing_attempt: number;
      }>>`
        SELECT status::text AS status, cancel_requested_at, processing_attempt
        FROM ingestion_jobs
        WHERE id = ${job.id}::uuid
        FOR UPDATE
      `;
      if (
        !state ||
        state.processing_attempt !== processingAttempt ||
        state.status !== "processing"
      ) return null;
      if (state.cancel_requested_at) {
        await transaction.ingestionJob.update({
          where: { id: job.id },
          data: { status: "cancelled", processingCompletedAt: new Date() }
        });
        return null;
      }
      const persistedCount = await transaction.logEvent.count({
        where: { ingestionJobId: job.id }
      });
      await transaction.ingestionJob.update({
        where: { id: job.id },
        data: {
          bytesProcessed: 0,
          linesProcessed: 0,
          eventsPersisted: persistedCount,
          malformedLines: 0
        }
      });
      return persistedCount;
    });
    if (existingEventCount === null) {
      input.destroy();
      return;
    }

    let lineNumber = 0;
    let bytesProcessed = 0;
    let malformedLines = 0;
    let eventsPersisted = existingEventCount;
    let batch: Prisma.LogEventCreateManyInput[] = [];
    let batchBytes = 0;
    let batchMalformed = 0;

    const flush = async (): Promise<boolean> => {
      const result = await prisma.$transaction(async (transaction) => {
        const [state] = await transaction.$queryRaw<Array<{
          status: string;
          cancel_requested_at: Date | null;
          processing_attempt: number;
        }>>`
          SELECT status::text AS status, cancel_requested_at, processing_attempt
          FROM ingestion_jobs
          WHERE id = ${job.id}::uuid
          FOR UPDATE
        `;
        if (!state || state.processing_attempt !== processingAttempt || state.status === "cancelled") {
          return { shouldContinue: false, persistedCount: eventsPersisted };
        }
        if (state.status !== "processing") {
          throw new UnrecoverableError("Ingestion job stopped processing unexpectedly");
        }
        if (state.cancel_requested_at) {
          await transaction.ingestionJob.update({
            where: { id: job.id },
            data: { status: "cancelled", processingCompletedAt: new Date() }
          });
          return { shouldContinue: false, persistedCount: eventsPersisted };
        }
        if (batch.length > 0) {
          await transaction.logEvent.createMany({
            data: batch,
            skipDuplicates: true
          });
        }
        const persistedCount = await transaction.logEvent.count({
          where: { ingestionJobId: job.id }
        });
        malformedLines += batchMalformed;
        await transaction.ingestionJob.update({
          where: { id: job.id },
          data: {
            bytesProcessed: Math.min(fileSizeBytes, bytesProcessed + batchBytes),
            linesProcessed: lineNumber,
            eventsPersisted: persistedCount,
            malformedLines
          }
        });
        return { shouldContinue: true, persistedCount };
      });
      if (!result.shouldContinue) return false;
      eventsPersisted = result.persistedCount;
      bytesProcessed = Math.min(fileSizeBytes, bytesProcessed + batchBytes);
      batchBytes = 0;
      batchMalformed = 0;
      batch = [];
      return true;
    };

    try {
      for await (const line of readLines(input, config.MAX_LOG_LINE_BYTES)) {
        lineNumber += 1;
        batchBytes += line.byteLength;
        if (line.oversized) {
          batchMalformed += 1;
        } else if (line.text !== null && line.text.trim().length > 0) {
          const parsed = extension === ".jsonl"
            ? parseJsonLine(line.text)
            : parseLogLine(line.text);
          if (!parsed) {
            batchMalformed += 1;
          } else {
            if (parsed.malformed) batchMalformed += 1;
            batch.push(toLogEvent(job.id, job.projectId, lineNumber, parsed));
          }
        }

        if (lineNumber % config.PROCESSING_BATCH_SIZE === 0) {
          if (!await flush()) {
            input.destroy();
            return;
          }
        }
      }
      if (batchBytes > 0 || batch.length > 0 || batchMalformed > 0) {
        if (!await flush()) {
          input.destroy();
          return;
        }
      }

      await prisma.$transaction(async (transaction) => {
        const [state] = await transaction.$queryRaw<Array<{
          status: string;
          cancel_requested_at: Date | null;
          processing_attempt: number;
        }>>`
          SELECT status::text AS status, cancel_requested_at, processing_attempt
          FROM ingestion_jobs
          WHERE id = ${job.id}::uuid
          FOR UPDATE
        `;
        if (
          !state ||
          state.processing_attempt !== processingAttempt ||
          state.status === "completed" ||
          state.status === "cancelled"
        ) return;
        if (state.cancel_requested_at) {
          await transaction.ingestionJob.update({
            where: { id: job.id },
            data: { status: "cancelled", processingCompletedAt: new Date() }
          });
          return;
        }
        if (state.status !== "processing") {
          throw new UnrecoverableError("Ingestion job stopped processing unexpectedly");
        }
        await transaction.ingestionJob.update({
          where: { id: job.id },
          data: {
            status: "completed",
            bytesProcessed: fileSizeBytes,
            linesProcessed: lineNumber,
            eventsPersisted,
            malformedLines,
            processingCompletedAt: new Date(),
            failureReason: null
          }
        });
      });
    } catch (error) {
      input.destroy(error instanceof Error ? error : undefined);
      throw error;
    }
  };
}

function toLogEvent(
  ingestionJobId: string,
  projectId: string,
  lineNumber: number,
  parsed: ParsedLogLine
): Prisma.LogEventCreateManyInput {
  return {
    ingestionJobId,
    projectId,
    lineNumber,
    timestamp: parsed.timestamp,
    level: parsed.level,
    message: parsed.message,
    source: parsed.source,
    attributes: parsed.attributes as Prisma.InputJsonObject
  };
}
