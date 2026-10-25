import type { PrismaClient } from "@prisma/client";
import type { IngestionJobListQuery } from "@logforge/shared";
import { ApiError } from "../../lib/api-error.js";
import type { ObjectStorage } from "../../storage/object-storage.js";

const jobSelection = {
  id: true,
  projectId: true,
  status: true,
  processingAttempt: true,
  originalFilename: true,
  fileSizeBytes: true,
  contentType: true,
  uploadCompletedAt: true,
  cleanupPending: true,
  bytesProcessed: true,
  linesProcessed: true,
  eventsPersisted: true,
  malformedLines: true,
  failureReason: true,
  cancelRequestedAt: true,
  processingStartedAt: true,
  processingCompletedAt: true,
  createdAt: true,
  updatedAt: true
} as const;

export function createJobsService(prisma: PrismaClient, storage: ObjectStorage | null = null) {
  return {
    async create(ownerId: string, projectId: string) {
      return prisma.$transaction(async (transaction) => {
        const project = await transaction.project.findFirst({
          where: { id: projectId, ownerId },
          select: { id: true }
        });

        if (!project) {
          throw new ApiError(404, "not_found", "Project was not found");
        }

        return transaction.ingestionJob.create({
          data: { projectId: project.id },
          select: jobSelection
        });
      });
    },

    async get(ownerId: string, jobId: string) {
      const job = await prisma.ingestionJob.findFirst({
        where: { id: jobId, project: { ownerId } },
        select: jobSelection
      });

      if (!job) {
        throw new ApiError(404, "not_found", "Job was not found");
      }

      return job;
    },

    async cancel(ownerId: string, jobId: string) {
      return prisma.$transaction(async (transaction) => {
        const ownedJob = await transaction.ingestionJob.findFirst({
          where: { id: jobId, project: { ownerId } },
          select: { id: true }
        });
        if (!ownedJob) throw new ApiError(404, "not_found", "Job was not found");

        await transaction.$queryRaw`
          SELECT id FROM ingestion_jobs WHERE id = ${jobId}::uuid FOR UPDATE
        `;
        const job = await transaction.ingestionJob.findFirst({
          where: { id: jobId, project: { ownerId } },
          select: jobSelection
        });
        if (!job) throw new ApiError(404, "not_found", "Job was not found");

        if (job.status === "queued") {
          return transaction.ingestionJob.update({
            where: { id: job.id },
            data: {
              status: "cancelled",
              cancelRequestedAt: job.cancelRequestedAt ?? new Date(),
              processingCompletedAt: new Date()
            },
            select: jobSelection
          });
        }
        if (job.status === "processing" && !job.cancelRequestedAt) {
          return transaction.ingestionJob.update({
            where: { id: job.id },
            data: { cancelRequestedAt: new Date() },
            select: jobSelection
          });
        }
        if (
          job.status === "processing" ||
          job.status === "cancelled" ||
          job.status === "completed" ||
          job.status === "failed"
        ) {
          return job;
        }
        throw new ApiError(409, "invalid_job_state", "This job cannot be cancelled in its current state");
      });
    },

    async retry(ownerId: string, jobId: string) {
      const ownedJob = await prisma.ingestionJob.findFirst({
        where: { id: jobId, project: { ownerId } },
        select: { id: true }
      });
      if (!ownedJob) throw new ApiError(404, "not_found", "Job was not found");

      return prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT id FROM ingestion_jobs WHERE id = ${jobId}::uuid FOR UPDATE
        `;
        const job = await transaction.ingestionJob.findFirst({
          where: { id: jobId, project: { ownerId } },
          select: { ...jobSelection, objectKey: true }
        });
        if (!job) throw new ApiError(404, "not_found", "Job was not found");
        if (job.status !== "cancelled" && job.status !== "failed") {
          throw new ApiError(
            409,
            "job_not_retryable",
            "Only cancelled or failed jobs can be retried"
          );
        }
        if (!job.objectKey || !job.originalFilename || !job.fileSizeBytes || !job.contentType) {
          throw new ApiError(409, "source_unavailable", "The original uploaded file is unavailable");
        }
        if (!storage) {
          throw new ApiError(503, "storage_unavailable", "Object storage is not configured");
        }
        let storedObject;
        try {
          storedObject = await storage.headObject(job.objectKey);
        } catch {
          throw new ApiError(503, "storage_unavailable", "Unable to verify the original file in storage");
        }
        if (
          !storedObject ||
          storedObject.contentLength !== job.fileSizeBytes ||
          storedObject.contentType !== job.contentType
        ) {
          throw new ApiError(
            409,
            "source_unavailable",
            "The original file is missing or no longer matches the uploaded job"
          );
        }

        const existingEventCount = await transaction.logEvent.count({
          where: { ingestionJobId: job.id }
        });
        const processingAttempt = job.processingAttempt + 1;
        const retried = await transaction.ingestionJob.update({
          where: { id: job.id },
          data: {
            status: "queued",
            processingAttempt,
            cancelRequestedAt: null,
            failureReason: null,
            bytesProcessed: 0,
            linesProcessed: 0,
            eventsPersisted: existingEventCount,
            malformedLines: 0,
            processingStartedAt: null,
            processingCompletedAt: null
          },
          select: jobSelection
        });
        await transaction.processingOutbox.upsert({
          where: { ingestionJobId: job.id },
          create: { ingestionJobId: job.id, processingAttempt },
          update: {
            processingAttempt,
            dispatchedAt: null,
            lastError: null
          }
        });
        return retried;
      });
    },

    async listForProject(ownerId: string, projectId: string, query: IngestionJobListQuery) {
      const project = await prisma.project.findFirst({
        where: { id: projectId, ownerId },
        select: { id: true }
      });
      if (!project) {
        throw new ApiError(404, "not_found", "Project was not found");
      }

      if (query.cursor) {
        const cursorJob = await prisma.ingestionJob.findFirst({
          where: { id: query.cursor, projectId: project.id },
          select: { id: true }
        });
        if (!cursorJob) {
          throw new ApiError(400, "invalid_cursor", "The job cursor is invalid for this project");
        }
      }

      const rows = await prisma.ingestionJob.findMany({
        where: { projectId: project.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        select: jobSelection
      });
      const hasMore = rows.length > query.limit;
      const jobs = hasMore ? rows.slice(0, query.limit) : rows;
      return {
        jobs,
        nextCursor: hasMore ? jobs[jobs.length - 1]?.id ?? null : null
      };
    }
  };
}

export type JobsService = ReturnType<typeof createJobsService>;
