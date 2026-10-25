import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import type { ObjectStorage } from "../src/storage/object-storage.js";
import { createIngestionProcessor } from "../src/processing/processor.js";
import { prisma } from "../src/db/prisma.js";
import { cleanupFixtures, newEmail } from "./support.js";
import { createJobsService } from "../src/modules/jobs/jobs.service.js";

const config = { PROCESSING_BATCH_SIZE: 2, MAX_LOG_LINE_BYTES: 1024 };
const validContent = Buffer.from(
  '{"timestamp":"2026-10-22T00:00:00.000Z","level":"info","message":"event"}\n'
);

async function createQueuedJob() {
  const user = await prisma.user.create({
    data: { email: newEmail(), passwordHash: "test-hash" }
  });
  const project = await prisma.project.create({
    data: { ownerId: user.id, name: `Cancellation ${randomUUID()}` }
  });
  const job = await prisma.ingestionJob.create({
    data: {
      projectId: project.id,
      status: "queued",
      objectKey: `projects/${project.id}/jobs/${randomUUID()}`,
      originalFilename: "events.jsonl",
      fileSizeBytes: 10_000_000,
      contentType: "application/x-ndjson"
    }
  });
  return job;
}

function storageFor(
  getObjectStream: ObjectStorage["getObjectStream"],
  headObject: ObjectStorage["headObject"] = async () => null
): ObjectStorage {
  return {
    createUploadUrl: async () => "https://invalid.test",
    headObject,
    deleteObject: async () => {},
    getObjectStream
  };
}

async function waitForEventCount(jobId: string, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = await prisma.logEvent.count({ where: { ingestionJobId: jobId } });
    if (count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} events for ${jobId}`);
}

afterAll(cleanupFixtures);

describe("ingestion cancellation in the worker", () => {
  it("does not start a queued job that was cancelled before worker execution", async () => {
    const job = await createQueuedJob();
    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: { status: "cancelled", cancelRequestedAt: new Date() }
    });
    const getObjectStream = async () => {
      throw new Error("Cancelled queued jobs must not read the object");
    };
    const process = createIngestionProcessor(prisma, storageFor(getObjectStream), config);

    await process({ ingestionJobId: job.id });
    expect((await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job.id } })).status)
      .toBe("cancelled");
    expect(await prisma.logEvent.count({ where: { ingestionJobId: job.id } })).toBe(0);
  });

  it("stops at a batch boundary and preserves events already committed", async () => {
    const job = await createQueuedJob();
    let resumeStream!: () => void;
    const waitForResume = new Promise<void>((resolve) => { resumeStream = resolve; });
    const source = Readable.from((async function* () {
      yield Buffer.concat([validContent, validContent]);
      await waitForResume;
      yield Buffer.concat([validContent, validContent]);
    })());
    const process = createIngestionProcessor(
      prisma,
      storageFor(async () => source),
      config
    );

    const running = process({ ingestionJobId: job.id });
    await waitForEventCount(job.id, 2);
    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: { cancelRequestedAt: new Date() }
    });
    resumeStream();
    await running;

    const savedJob = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(savedJob.status).toBe("cancelled");
    expect(savedJob.eventsPersisted).toBe(2);
    expect(savedJob.processingCompletedAt).toBeInstanceOf(Date);
    expect(await prisma.logEvent.count({ where: { ingestionJobId: job.id } })).toBe(2);
  });

  it("does not change a cancelled job on worker retry", async () => {
    const job = await createQueuedJob();
    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: { status: "cancelled", cancelRequestedAt: new Date() }
    });
    const process = createIngestionProcessor(
      prisma,
      storageFor(async () => Readable.from([validContent])),
      config
    );

    await process({ ingestionJobId: job.id });
    await process({ ingestionJobId: job.id });
    expect((await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job.id } })).status)
      .toBe("cancelled");
    expect(await prisma.logEvent.count({ where: { ingestionJobId: job.id } })).toBe(0);
  });

  it("retries partial batch writes without duplicating events", async () => {
    const job = await createQueuedJob();
    const failingStream = Readable.from((async function* () {
      yield Buffer.concat([validContent, validContent]);
      throw new Error("simulated stream interruption");
    })());
    const successfulStream = Readable.from([
      Buffer.concat([validContent, validContent, validContent])
    ]);
    const sources = [failingStream, successfulStream];
    const process = createIngestionProcessor(
      prisma,
      storageFor(async () => sources.shift()!),
      config
    );

    await expect(process({ ingestionJobId: job.id })).rejects.toThrow("simulated stream interruption");
    expect(await prisma.logEvent.count({ where: { ingestionJobId: job.id } })).toBe(2);
    await process({ ingestionJobId: job.id });

    const savedJob = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(savedJob.status).toBe("completed");
    expect(savedJob.eventsPersisted).toBe(3);
    expect(await prisma.logEvent.count({ where: { ingestionJobId: job.id } })).toBe(3);
  });

  it("reprocesses a cancelled 4,000-event job without duplicating persisted lines", async () => {
    const job = await createQueuedJob();
    const previousEvents = Array.from({ length: 4_000 }, (_, index) => ({
      projectId: job.projectId,
      ingestionJobId: job.id,
      lineNumber: index + 1,
      timestamp: new Date("2026-10-22T00:00:00.000Z"),
      level: "info",
      message: "event",
      source: null,
      attributes: {}
    }));
    await prisma.logEvent.createMany({ data: previousEvents });
    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: {
        status: "cancelled",
        cancelRequestedAt: new Date(),
        eventsPersisted: 4_000,
        linesProcessed: 4_000
      }
    });

    const storage = storageFor(
      async () => Readable.from([
        Buffer.from(validContent.toString("utf8").repeat(4_000))
      ]),
      async () => ({
        contentLength: job.fileSizeBytes!,
        contentType: job.contentType!
      })
    );
    const retry = await createJobsService(prisma, storage).retry(
      (await prisma.project.findUniqueOrThrow({ where: { id: job.projectId } })).ownerId,
      job.id
    );
    const process = createIngestionProcessor(prisma, storage, {
      ...config,
      PROCESSING_BATCH_SIZE: 500
    });
    await process({ ingestionJobId: job.id, processingAttempt: 0 });
    expect((await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job.id } })).status)
      .toBe("queued");
    await process({ ingestionJobId: job.id, processingAttempt: retry.processingAttempt });

    const savedJob = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(savedJob.status).toBe("completed");
    expect(savedJob.eventsPersisted).toBe(4_000);
    expect(savedJob.processingAttempt).toBe(1);
    expect(savedJob.cancelRequestedAt).toBeNull();
    expect(await prisma.logEvent.count({ where: { ingestionJobId: job.id } })).toBe(4_000);
  });
});
