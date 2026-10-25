import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { UploadConfig } from "../../config/env.js";
import { ApiError } from "../../lib/api-error.js";
import type { ObjectStorage, StoredObject } from "../../storage/object-storage.js";
import { uploadInitializationRequestSchema } from "@logforge/shared";

export const MIN_UPLOAD_SIZE_BYTES = 10_000_000;

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

type UploadRequest = ReturnType<typeof uploadInitializationRequestSchema.parse>;

function contentTypeFor(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (extension === ".log") return "text/plain";
  if (extension === ".jsonl") return "application/x-ndjson";
  throw new ApiError(400, "unsupported_file_type", "Choose a .log or .jsonl file");
}

function ensureValidDeclaredSize(size: number, maximum: number): void {
  if (size < MIN_UPLOAD_SIZE_BYTES) {
    throw new ApiError(400, "file_too_small", "Files must be at least 10 MB (decimal)");
  }
  if (size > maximum) {
    throw new ApiError(413, "file_too_large", "The file exceeds the configured upload limit");
  }
}

export function createUploadService(
  prisma: PrismaClient,
  storage: ObjectStorage | null,
  config: UploadConfig
) {
  async function callStorage<T>(operation: (client: ObjectStorage) => Promise<T>): Promise<T> {
    if (!storage) {
      throw new ApiError(503, "storage_unavailable", "Object storage is not configured");
    }
    try {
      return await operation(storage);
    } catch {
      throw new ApiError(503, "storage_unavailable", "Object storage is temporarily unavailable");
    }
  }

  async function getUploadUrl(key: string, contentType: string) {
    const url = await callStorage((client) =>
      client.createUploadUrl({
        key,
        contentType,
        expiresInSeconds: config.R2_PRESIGNED_URL_TTL_SECONDS
      })
    );
    return {
      url,
      method: "PUT" as const,
      headers: { "Content-Type": contentType },
      expiresAt: new Date(Date.now() + config.R2_PRESIGNED_URL_TTL_SECONDS * 1000)
    };
  }

  async function ownedJob(ownerId: string, jobId: string) {
    const job = await prisma.ingestionJob.findFirst({
      where: { id: jobId, project: { ownerId } },
      select: { ...jobSelection, objectKey: true }
    });
    if (!job) throw new ApiError(404, "not_found", "Job was not found");
    return job;
  }

  async function cleanupObject(jobId: string, objectKey: string): Promise<void> {
    try {
      await callStorage((client) => client.deleteObject(objectKey));
      await prisma.ingestionJob.update({
        where: { id: jobId },
        data: { cleanupPending: false }
      });
    } catch {
      throw new ApiError(
        503,
        "cleanup_pending",
        "The rejected object could not be removed. Retry cleanup before continuing."
      );
    }
  }

  async function rejectObject(jobId: string, objectKey: string): Promise<never> {
    await prisma.ingestionJob.update({
      where: { id: jobId },
      data: { status: "failed", cleanupPending: true }
    });
    await cleanupObject(jobId, objectKey);
    throw new ApiError(
      422,
      "invalid_upload",
      "The uploaded object did not match the expected size or type and was not accepted"
    );
  }

  function objectMatches(job: {
    fileSizeBytes: number | null;
    contentType: string | null;
  }, object: StoredObject, maximum: number): boolean {
    return (
      object.contentLength !== undefined &&
      object.contentLength >= MIN_UPLOAD_SIZE_BYTES &&
      object.contentLength <= maximum &&
      object.contentLength === job.fileSizeBytes &&
      object.contentType === job.contentType
    );
  }

  return {
    limits() {
      return {
        minimumFileSizeBytes: MIN_UPLOAD_SIZE_BYTES,
        maximumFileSizeBytes: config.MAX_UPLOAD_SIZE_BYTES,
        supportedExtensions: [".log", ".jsonl"] as const
      };
    },

    async initialize(ownerId: string, projectId: string, input: UploadRequest) {
      const filename = input.filename;
      const contentType = contentTypeFor(filename);
      ensureValidDeclaredSize(input.fileSizeBytes, config.MAX_UPLOAD_SIZE_BYTES);
      if (!storage) {
        throw new ApiError(503, "storage_unavailable", "Object storage is not configured");
      }

      const project = await prisma.project.findFirst({
        where: { id: projectId, ownerId },
        select: { id: true }
      });
      if (!project) throw new ApiError(404, "not_found", "Project was not found");

      const objectKey = `projects/${project.id}/jobs/${randomUUID()}`;
      const job = await prisma.ingestionJob.upsert({
        where: {
          projectId_uploadRequestId: {
            projectId: project.id,
            uploadRequestId: input.idempotencyKey
          }
        },
        create: {
          projectId: project.id,
          uploadRequestId: input.idempotencyKey,
          objectKey,
          originalFilename: filename,
          fileSizeBytes: input.fileSizeBytes,
          contentType
        },
        update: {},
        select: { ...jobSelection, objectKey: true }
      });

      if (job.originalFilename !== filename || job.fileSizeBytes !== input.fileSizeBytes) {
        throw new ApiError(409, "idempotency_conflict", "This upload request was already used for a different file");
      }
      if (job.status !== "created" || !job.objectKey) {
        throw new ApiError(409, "invalid_job_state", "This job is no longer accepting an upload");
      }

      const upload = await getUploadUrl(job.objectKey, contentType);
      return { job: publicJob(job), upload };
    },

    async createUploadUrl(ownerId: string, jobId: string) {
      const job = await ownedJob(ownerId, jobId);
      if (
        job.status !== "created" ||
        !job.objectKey ||
        !job.contentType ||
        !job.originalFilename ||
        !job.fileSizeBytes
      ) {
        throw new ApiError(409, "invalid_job_state", "This job is not waiting for an upload");
      }
      ensureValidDeclaredSize(job.fileSizeBytes, config.MAX_UPLOAD_SIZE_BYTES);
      return { job: publicJob(job), upload: await getUploadUrl(job.objectKey, job.contentType) };
    },

    async complete(ownerId: string, jobId: string) {
      const job = await ownedJob(ownerId, jobId);
      if (!job.objectKey || !job.contentType || !job.fileSizeBytes) {
        throw new ApiError(409, "invalid_job_state", "This job has no upload to complete");
      }

      const object = await callStorage((client) => client.headObject(job.objectKey!));
      if (!object) {
        throw new ApiError(409, "upload_missing", "The uploaded object was not found; retry the upload");
      }
      if (!objectMatches(job, object, config.MAX_UPLOAD_SIZE_BYTES)) {
        await rejectObject(job.id, job.objectKey);
      }

      if (["queued", "processing", "completed"].includes(job.status)) {
        return publicJob(job);
      }
      if (job.status !== "created" && job.status !== "uploaded") {
        throw new ApiError(409, "invalid_job_state", "This job cannot be completed in its current state");
      }

      const queued = await prisma.$transaction(async (transaction) => {
        const changed = await transaction.ingestionJob.updateMany({
          where: { id: job.id, status: { in: ["created", "uploaded"] } },
          data: {
            status: "queued",
            uploadCompletedAt: job.uploadCompletedAt ?? new Date(),
            failureReason: null
          }
        });
        if (changed.count === 0) {
          const latest = await transaction.ingestionJob.findUnique({
            where: { id: job.id },
            select: { ...jobSelection, objectKey: true }
          });
          if (
            latest &&
            ["queued", "processing", "completed"].includes(latest.status)
          ) {
            return latest;
          }
          throw new ApiError(409, "invalid_job_state", "This job cannot be completed in its current state");
        }
        await transaction.processingOutbox.upsert({
          where: { ingestionJobId: job.id },
          create: { ingestionJobId: job.id },
          update: {}
        });
        return transaction.ingestionJob.findUniqueOrThrow({
          where: { id: job.id },
          select: { ...jobSelection, objectKey: true }
        });
      });
      return publicJob(queued);
    },

    async cleanup(ownerId: string, jobId: string) {
      const job = await ownedJob(ownerId, jobId);
      if (job.cleanupPending && job.objectKey) {
        await cleanupObject(job.id, job.objectKey);
      }
      const cleaned = await ownedJob(ownerId, jobId);
      return publicJob(cleaned);
    }
  };
}

export type UploadService = ReturnType<typeof createUploadService>;

function publicJob<T extends { objectKey: string | null }>(job: T): Omit<T, "objectKey"> {
  const { objectKey: _objectKey, ...safeJob } = job;
  return safeJob;
}
