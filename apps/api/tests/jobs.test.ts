import pino from "pino";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { databaseProbe, prisma } from "../src/db/prisma.js";
import type { ObjectStorage } from "../src/storage/object-storage.js";
import { cleanupFixtures, newEmail } from "./support.js";
import { hashSessionToken } from "../src/lib/session-token.js";
import type { Queue } from "bullmq";
import { dispatchPendingOutbox } from "../src/processing/outbox-relay.js";
import type { ProcessingQueuePayload } from "../src/processing/queue.js";
import type { PrismaClient } from "@prisma/client";

const app = createApp({
  logger: pino({ enabled: false }),
  databaseProbe,
  prisma
});

afterAll(async () => {
  await cleanupFixtures();
}, 60_000);

async function createUser(): Promise<string> {
  const response = await request(app)
    .post("/api/auth/register")
    .send({ email: newEmail(), password: "correct horse battery staple" });
  expect(response.status).toBe(201);
  return response.body.accessToken as string;
}

async function createProject(token: string): Promise<string> {
  const response = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Job project" });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.project.id as string;
}

async function createTestSession(): Promise<{ token: string; userId: string }> {
  const user = await prisma.user.create({
    data: { email: newEmail(), passwordHash: "test-hash" }
  });
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 60_000)
    }
  });
  return { token, userId: user.id };
}

function createRetryApp(storage: ObjectStorage) {
  return createApp({
    logger: pino({ enabled: false }),
    databaseProbe,
    prisma,
    uploadStorage: storage,
    uploadConfig: {
      MAX_UPLOAD_SIZE_BYTES: 100_000_000,
      R2_PRESIGNED_URL_TTL_SECONDS: 300
    }
  });
}

describe("ingestion jobs", () => {
  it("creates a metadata-only job and allows only its project owner to read it", async () => {
    const ownerToken = await createUser();
    const otherToken = await createUser();
    const projectId = await createProject(ownerToken);
    const created = await request(app)
      .post(`/api/projects/${projectId}/jobs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});

    expect(created.status).toBe(201);
    expect(created.body.job).toMatchObject({
      projectId,
      status: "created"
    });

    const ownerRead = await request(app)
      .get(`/api/jobs/${created.body.job.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.body.job.status).toBe("created");

    const otherRead = await request(app)
      .get(`/api/jobs/${created.body.job.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(otherRead.status).toBe(404);
    expect(otherRead.body.error.code).toBe("not_found");
    expect(otherRead.text).not.toContain("file");
    expect(otherRead.text).not.toContain("log");
  });

  it("does not let a user create a job under another user's project", async () => {
    const ownerToken = await createUser();
    const otherToken = await createUser();
    const projectId = await createProject(ownerToken);

    const response = await request(app)
      .post(`/api/projects/${projectId}/jobs`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
  });

  it("rejects file metadata on the metadata-only job creation endpoint", async () => {
    const ownerToken = await createUser();
    const projectId = await createProject(ownerToken);

    const response = await request(app)
      .post(`/api/projects/${projectId}/jobs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ filename: "private.log" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_error");
  });

  it("lists persisted project jobs with file metadata and no storage secrets", async () => {
    const ownerToken = await createUser();
    const otherToken = await createUser();
    const projectId = await createProject(ownerToken);
    await prisma.ingestionJob.create({
      data: {
        projectId,
        status: "uploaded",
        objectKey: `projects/${projectId}/jobs/private-object`,
        originalFilename: "visible.log",
        fileSizeBytes: 10_000_000,
        contentType: "text/plain",
        uploadCompletedAt: new Date()
      }
    });
    const response = await request(app)
      .get(`/api/projects/${projectId}/jobs`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
    expect(response.body.jobs).toHaveLength(1);
    expect(response.body.jobs[0]).toMatchObject({
      projectId,
      originalFilename: "visible.log",
      fileSizeBytes: 10_000_000,
      status: "uploaded"
    });
    expect(response.body.jobs[0].uploadCompletedAt).toBeTruthy();
    expect(response.body.jobs[0]).not.toHaveProperty("objectKey");
    expect(response.text).not.toContain("private-object");
    expect(response.text).not.toContain("accessToken");
    expect(response.body.nextCursor).toBeNull();

    const otherUser = await request(app)
      .get(`/api/projects/${projectId}/jobs`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(otherUser.status).toBe(404);
    expect(otherUser.body.error.code).toBe("not_found");
  });

  it("returns an empty job list and validates pagination cursors against the project", async () => {
    const ownerToken = await createUser();
    const otherToken = await createUser();
    const projectId = await createProject(ownerToken);
    const otherProject = await createProject(otherToken);

    const unauthenticated = await request(app).get(`/api/projects/${projectId}/jobs`);
    expect(unauthenticated.status).toBe(401);

    const empty = await request(app)
      .get(`/api/projects/${projectId}/jobs`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ jobs: [], nextCursor: null });

    const otherJob = await prisma.ingestionJob.create({
      data: { projectId: otherProject }
    });
    const invalidCursor = await request(app)
      .get(`/api/projects/${projectId}/jobs?cursor=${otherJob.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.error.code).toBe("invalid_cursor");
  });

  it("cancels queued jobs idempotently and denies unauthorized users", async () => {
    const owner = await createTestSession();
    const other = await createTestSession();
    const project = await prisma.project.create({
      data: { ownerId: owner.userId, name: `Cancellation ${Date.now()}` }
    });
    const job = await prisma.ingestionJob.create({
      data: { projectId: project.id, status: "queued" }
    });

    const unauthenticated = await request(app).post(`/api/jobs/${job.id}/cancel`);
    expect(unauthenticated.status).toBe(401);
    const unauthorized = await request(app)
      .post(`/api/jobs/${job.id}/cancel`)
      .set("Authorization", `Bearer ${other.token}`);
    expect(unauthorized.status).toBe(404);

    const cancelled = await request(app)
      .post(`/api/jobs/${job.id}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.job).toMatchObject({
      id: job.id,
      status: "cancelled",
      cancelRequestedAt: expect.any(String)
    });
    const firstRequestAt = cancelled.body.job.cancelRequestedAt;

    const repeated = await request(app)
      .post(`/api/jobs/${job.id}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(repeated.status).toBe(200);
    expect(repeated.body.job.status).toBe("cancelled");
    expect(repeated.body.job.cancelRequestedAt).toBe(firstRequestAt);
  });

  it("records a cancellation request for active jobs and never cancels completed jobs", async () => {
    const owner = await createTestSession();
    const project = await prisma.project.create({
      data: { ownerId: owner.userId, name: `Cancellation ${Date.now()}` }
    });
    const active = await prisma.ingestionJob.create({
      data: { projectId: project.id, status: "processing", processingStartedAt: new Date() }
    });
    const requested = await request(app)
      .post(`/api/jobs/${active.id}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(requested.body.job.status).toBe("processing");
    expect(requested.body.job.cancelRequestedAt).toBeTruthy();
    const firstRequestAt = requested.body.job.cancelRequestedAt;
    const repeated = await request(app)
      .post(`/api/jobs/${active.id}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(repeated.body.job.cancelRequestedAt).toBe(firstRequestAt);

    const completed = await prisma.ingestionJob.create({
      data: { projectId: project.id, status: "completed", eventsPersisted: 17 }
    });
    const completedResponse = await request(app)
      .post(`/api/jobs/${completed.id}/cancel`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(completedResponse.body.job).toMatchObject({
      status: "completed",
      eventsPersisted: 17,
      cancelRequestedAt: null
    });
  });

  it("retries cancelled and failed jobs, rejects duplicate and completed retries", async () => {
    const owner = await createTestSession();
    const other = await createTestSession();
    const project = await prisma.project.create({
      data: { ownerId: owner.userId, name: `Retry ${Date.now()}` }
    });
    const storage: ObjectStorage = {
      createUploadUrl: vi.fn(async () => "https://invalid.test"),
      headObject: vi.fn(async () => ({
        contentLength: 10_000_000,
        contentType: "application/x-ndjson"
      })),
      deleteObject: vi.fn(async () => {}),
      getObjectStream: vi.fn(async () => {
        const { Readable } = await import("node:stream");
        return Readable.from([]);
      })
    };
    const retryApp = createRetryApp(storage);
    const cancelled = await prisma.ingestionJob.create({
      data: {
        projectId: project.id,
        status: "cancelled",
        cancelRequestedAt: new Date(),
        objectKey: `projects/${project.id}/jobs/cancelled`,
        originalFilename: "events.jsonl",
        fileSizeBytes: 10_000_000,
        contentType: "application/x-ndjson",
        eventsPersisted: 0,
        bytesProcessed: 8_000_000,
        linesProcessed: 4_000,
        malformedLines: 12
      }
    });
    const failed = await prisma.ingestionJob.create({
      data: {
        projectId: project.id,
        status: "failed",
        failureReason: "temporary failure",
        objectKey: `projects/${project.id}/jobs/failed`,
        originalFilename: "events.jsonl",
        fileSizeBytes: 10_000_000,
        contentType: "application/x-ndjson"
      }
    });

    const unauthenticated = await request(retryApp).post(`/api/jobs/${cancelled.id}/retry`);
    expect(unauthenticated.status).toBe(401);
    const unauthorized = await request(retryApp)
      .post(`/api/jobs/${cancelled.id}/retry`)
      .set("Authorization", `Bearer ${other.token}`);
    expect(unauthorized.status).toBe(404);

    const first = await request(retryApp)
      .post(`/api/jobs/${cancelled.id}/retry`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(first.status).toBe(200);
    expect(first.body.job).toMatchObject({
      id: cancelled.id,
      status: "queued",
      processingAttempt: 1,
      cancelRequestedAt: null,
      eventsPersisted: 0,
      bytesProcessed: 0,
      linesProcessed: 0,
      malformedLines: 0,
      failureReason: null
    });
    const repeated = await request(retryApp)
      .post(`/api/jobs/${cancelled.id}/retry`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(repeated.status).toBe(409);
    expect((await prisma.ingestionJob.findUniqueOrThrow({ where: { id: cancelled.id } }))
      .processingAttempt).toBe(1);
    const retryOutbox = await prisma.processingOutbox.findUniqueOrThrow({
      where: { ingestionJobId: cancelled.id }
    });
    expect(retryOutbox.processingAttempt).toBe(1);
    expect(retryOutbox.lastError).toBeNull();

    const failedRetry = await request(retryApp)
      .post(`/api/jobs/${failed.id}/retry`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(failedRetry.status).toBe(200);
    expect(failedRetry.body.job).toMatchObject({
      id: failed.id,
      status: "queued",
      processingAttempt: 1,
      failureReason: null
    });

    const completed = await prisma.ingestionJob.create({
      data: {
        projectId: project.id,
        status: "completed",
        objectKey: `projects/${project.id}/jobs/completed`,
        originalFilename: "events.jsonl",
        fileSizeBytes: 10_000_000,
        contentType: "application/x-ndjson"
      }
    });
    const completedRetry = await request(retryApp)
      .post(`/api/jobs/${completed.id}/retry`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(completedRetry.status).toBe(409);
  });

  it("rejects retry when the original R2 object is missing", async () => {
    const owner = await createTestSession();
    const project = await prisma.project.create({
      data: { ownerId: owner.userId, name: `Missing retry ${Date.now()}` }
    });
    const job = await prisma.ingestionJob.create({
      data: {
        projectId: project.id,
        status: "cancelled",
        objectKey: `projects/${project.id}/jobs/missing`,
        originalFilename: "events.jsonl",
        fileSizeBytes: 10_000_000,
        contentType: "application/x-ndjson"
      }
    });
    const storage: ObjectStorage = {
      createUploadUrl: vi.fn(async () => "https://invalid.test"),
      headObject: vi.fn(async () => null),
      deleteObject: vi.fn(async () => {}),
      getObjectStream: vi.fn(async () => {
        const { Readable } = await import("node:stream");
        return Readable.from([]);
      })
    };
    const response = await request(createRetryApp(storage))
      .post(`/api/jobs/${job.id}/retry`)
      .set("Authorization", `Bearer ${owner.token}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("source_unavailable");
    expect((await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job.id } })).status)
      .toBe("cancelled");
  });

  it("serializes concurrent cancellation and retry requests", async () => {
    const owner = await createTestSession();
    const project = await prisma.project.create({
      data: { ownerId: owner.userId, name: `Retry race ${Date.now()}` }
    });
    const job = await prisma.ingestionJob.create({
      data: {
        projectId: project.id,
        status: "cancelled",
        cancelRequestedAt: new Date(),
        objectKey: `projects/${project.id}/jobs/race`,
        originalFilename: "events.jsonl",
        fileSizeBytes: 10_000_000,
        contentType: "application/x-ndjson"
      }
    });
    const storage: ObjectStorage = {
      createUploadUrl: vi.fn(async () => "https://invalid.test"),
      headObject: vi.fn(async () => ({
        contentLength: 10_000_000,
        contentType: "application/x-ndjson"
      })),
      deleteObject: vi.fn(async () => {}),
      getObjectStream: vi.fn(async () => {
        const { Readable } = await import("node:stream");
        return Readable.from([]);
      })
    };
    const retryApp = createRetryApp(storage);
    const [cancelResponse, retryResponse] = await Promise.all([
      request(retryApp).post(`/api/jobs/${job.id}/cancel`)
        .set("Authorization", `Bearer ${owner.token}`),
      request(retryApp).post(`/api/jobs/${job.id}/retry`)
        .set("Authorization", `Bearer ${owner.token}`)
    ]);
    expect(cancelResponse.status).toBe(200);
    expect(retryResponse.status).toBe(200);
    const saved = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job.id } });
    const outbox = await prisma.processingOutbox.findUniqueOrThrow({
      where: { ingestionJobId: job.id }
    });
    expect(["queued", "cancelled"]).toContain(saved.status);
    expect(outbox.processingAttempt).toBe(saved.processingAttempt);
    if (saved.status === "queued") expect(saved.cancelRequestedAt).toBeNull();
    if (saved.status === "cancelled") expect(saved.cancelRequestedAt).toBeInstanceOf(Date);
  });

  it("recovers outbox delivery after a queue dispatch failure", async () => {
    const jobId = randomBytes(16).toString("hex");
    const outboxId = randomBytes(16).toString("hex");
    const event = {
      id: outboxId,
      ingestionJobId: jobId,
      processingAttempt: 2,
      ingestionJob: { status: "queued", processingAttempt: 2 }
    };
    let attempts = 0;
    let dispatchedAt: Date | null = null;
    let lastError: string | null = null;
    const fakePrisma = {
      processingOutbox: {
        findMany: vi.fn(async () => dispatchedAt ? [] : [event]),
        updateMany: vi.fn(async ({ data }: {
          data: { dispatchedAt?: Date; attempts?: { increment: number }; lastError?: string | null };
        }) => {
          if (data.dispatchedAt) dispatchedAt = data.dispatchedAt;
          if (data.attempts) attempts += data.attempts.increment;
          if ("lastError" in data) lastError = data.lastError ?? null;
          return { count: 1 };
        })
      }
    } as unknown as PrismaClient;
    let failDispatch = true;
    const add = vi.fn(async () => {
      if (failDispatch) throw new Error("Redis temporarily unavailable");
      return {} as never;
    });
    const queue = { add } as unknown as Queue<ProcessingQueuePayload>;
    const logger = pino({ enabled: false });

    expect(await dispatchPendingOutbox(fakePrisma, queue, logger)).toBe(0);
    expect(dispatchedAt).toBeNull();
    expect(attempts).toBe(1);
    expect(lastError).toBeTruthy();
    failDispatch = false;
    expect(await dispatchPendingOutbox(fakePrisma, queue, logger)).toBe(1);
    expect(dispatchedAt).toBeInstanceOf(Date);
    expect(add).toHaveBeenLastCalledWith(
      "process-ingestion-job",
      { ingestionJobId: jobId, processingAttempt: 2 },
      { jobId: `${jobId}-2` }
    );
  });

  it("paginates jobs newest-first using the existing cursor convention", async () => {
    const ownerToken = await createUser();
    const projectId = await createProject(ownerToken);
    const oldest = await prisma.ingestionJob.create({
      data: { projectId, createdAt: new Date("2026-01-01T00:00:00.000Z") }
    });
    const newest = await prisma.ingestionJob.create({
      data: { projectId, createdAt: new Date("2026-01-02T00:00:00.000Z") }
    });

    const first = await request(app)
      .get(`/api/projects/${projectId}/jobs?limit=1`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(first.body.jobs.map((job: { id: string }) => job.id)).toEqual([newest.id]);
    expect(first.body.nextCursor).toBe(newest.id);

    const second = await request(app)
      .get(`/api/projects/${projectId}/jobs?limit=1&cursor=${first.body.nextCursor}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(second.body.jobs.map((job: { id: string }) => job.id)).toEqual([oldest.id]);
    expect(second.body.nextCursor).toBeNull();
  });
});
