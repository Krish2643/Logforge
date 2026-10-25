import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import pino from "pino";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadConfig } from "../src/config/env.js";
import { createApp } from "../src/app.js";
import { databaseProbe, prisma } from "../src/db/prisma.js";
import type { ObjectStorage, StoredObject } from "../src/storage/object-storage.js";
import { cleanupFixtures, newEmail } from "./support.js";

const config: UploadConfig = {
  MAX_UPLOAD_SIZE_BYTES: 100_000_000,
  R2_PRESIGNED_URL_TTL_SECONDS: 300
};
const uploadedObject: StoredObject = {
  contentLength: 10_000_000,
  contentType: "text/plain"
};
let object: StoredObject | null = uploadedObject;
let presignFailure = false;
let deleteFailure = false;
const keys: string[] = [];
const deletedKeys: string[] = [];
const storage: ObjectStorage = {
  createUploadUrl: vi.fn(async ({ key }) => {
    keys.push(key);
    if (presignFailure) throw new Error("R2 offline");
    return `https://r2.example.test/${key}?signature=temporary`;
  }),
  headObject: vi.fn(async () => object),
  deleteObject: vi.fn(async (key) => {
    if (deleteFailure) throw new Error("R2 delete failed");
    deletedKeys.push(key);
  }),
  getObjectStream: vi.fn(async () => Readable.from([]))
};
let app = createTestApp();

function createTestApp() {
  return createApp({
    logger: pino({ enabled: false }),
    databaseProbe,
    prisma,
    uploadStorage: storage,
    uploadConfig: config
  });
}

afterAll(async () => {
  await cleanupFixtures();
});

beforeEach(() => {
  app = createTestApp();
  object = uploadedObject;
  presignFailure = false;
  deleteFailure = false;
  keys.length = 0;
  deletedKeys.length = 0;
  vi.mocked(storage.createUploadUrl).mockClear();
  vi.mocked(storage.headObject).mockClear();
  vi.mocked(storage.deleteObject).mockClear();
  vi.mocked(storage.getObjectStream).mockClear();
});

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
    .send({ name: `Upload project ${randomUUID()}` });
  expect(response.status).toBe(201);
  return response.body.project.id as string;
}

function uploadBody(filename = "service.log", fileSizeBytes = 10_000_000) {
  return { filename, fileSizeBytes, idempotencyKey: randomUUID() };
}

async function initialize(token: string, projectId: string, body = uploadBody()) {
  const response = await request(app)
    .post(`/api/projects/${projectId}/uploads`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  return { response, body };
}

describe("direct-to-R2 uploads", () => {
  it("returns authenticated size limits shared with frontend validation", async () => {
    expect((await request(app).get("/api/uploads/limits")).status).toBe(401);
    const token = await createUser();
    const response = await request(app)
      .get("/api/uploads/limits")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      minimumFileSizeBytes: 10_000_000,
      maximumFileSizeBytes: 100_000_000,
      supportedExtensions: [".log", ".jsonl"]
    });
  });

  it("requires authentication and project ownership", async () => {
    const ownerToken = await createUser();
    const otherToken = await createUser();
    const projectId = await createProject(ownerToken);
    const body = uploadBody();

    expect((await initialize("", projectId, body)).response.status).toBe(401);
    const forbidden = await initialize(otherToken, projectId, body);
    expect(forbidden.response.status).toBe(404);
    expect(forbidden.response.body.error.code).toBe("not_found");
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects unsupported, empty, too-small, and oversized file declarations", async () => {
    const token = await createUser();
    const projectId = await createProject(token);

    expect((await initialize(token, projectId, uploadBody("service.csv"))).response.status).toBe(400);
    expect((await initialize(token, projectId, uploadBody("empty.log", 0))).response.status).toBe(400);
    expect((await initialize(token, projectId, uploadBody("tiny.log", 9_999_999))).response.status).toBe(400);
    const tooLarge = await initialize(token, projectId, uploadBody("huge.log", 100_000_001));
    expect(tooLarge.response.status).toBe(413);
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
  });

  it("creates a private unique object key and exposes only a short-lived PUT capability", async () => {
    const token = await createUser();
    const projectId = await createProject(token);
    const { response } = await initialize(token, projectId, uploadBody("events.jsonl"));

    expect(response.status).toBe(201);
    expect(response.body.job).toMatchObject({
      projectId,
      status: "created",
      originalFilename: "events.jsonl",
      fileSizeBytes: 10_000_000,
      contentType: "application/x-ndjson"
    });
    expect(response.body.upload).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "application/x-ndjson" }
    });
    expect(response.body).not.toHaveProperty("job.objectKey");
    expect(keys[0]).toMatch(new RegExp(`^projects/${projectId}/jobs/[0-9a-f-]+$`));
    expect(response.body.upload.url).toContain("signature=temporary");
  });

  it("reuses the same job when initialization is retried after a signer error", async () => {
    const token = await createUser();
    const projectId = await createProject(token);
    const body = uploadBody();
    presignFailure = true;
    const failed = await initialize(token, projectId, body);
    expect(failed.response.status).toBe(503);
    expect(failed.response.body.error.code).toBe("storage_unavailable");

    presignFailure = false;
    const retried = await initialize(token, projectId, body);
    expect(retried.response.status).toBe(201);
    const reused = await initialize(token, projectId, body);
    expect(reused.response.body.job.id).toBe(retried.response.body.job.id);

    const changedFile = await initialize(token, projectId, {
      ...body,
      filename: "other.log"
    });
    expect(changedFile.response.status).toBe(409);
  });

  it("surfaces a database initialization failure without requesting an R2 URL", async () => {
    const token = await createUser();
    const projectId = await createProject(token);
    const databaseFailure = vi
      .spyOn(prisma.ingestionJob, "upsert")
      .mockRejectedValueOnce(new Error("database unavailable"));

    const failed = await initialize(token, projectId);
    expect(failed.response.status).toBe(500);
    expect(storage.createUploadUrl).not.toHaveBeenCalled();
    databaseFailure.mockRestore();

    const recovered = await initialize(token, projectId, failed.body);
    expect(recovered.response.status).toBe(201);
  });

  it("renews a URL for the same owned job and completes idempotently after checking storage", async () => {
    const token = await createUser();
    const projectId = await createProject(token);
    const { response: initialized } = await initialize(token, projectId);
    const jobId = initialized.body.job.id as string;

    const renewed = await request(app)
      .post(`/api/jobs/${jobId}/upload-url`)
      .set("Authorization", `Bearer ${token}`);
    expect(renewed.status).toBe(200);
    expect(renewed.body.job.id).toBe(jobId);
    expect(keys[0]).toBe(keys[1]);

    const completed = await request(app)
      .post(`/api/jobs/${jobId}/complete`)
      .set("Authorization", `Bearer ${token}`);
    const repeated = await request(app)
      .post(`/api/jobs/${jobId}/complete`)
      .set("Authorization", `Bearer ${token}`);
    expect(completed.status).toBe(200);
    expect(completed.body.job.status).toBe("queued");
    expect(completed.body.job.uploadCompletedAt).toBeTruthy();
    expect(repeated.status).toBe(200);
    expect(repeated.body.job.id).toBe(jobId);
    expect(storage.headObject).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing object while leaving the job retryable", async () => {
    const token = await createUser();
    const projectId = await createProject(token);
    const { response: initialized } = await initialize(token, projectId);
    object = null;

    const response = await request(app)
      .post(`/api/jobs/${initialized.body.job.id}/complete`)
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("upload_missing");
    expect((await request(app)
      .post(`/api/jobs/${initialized.body.job.id}/upload-url`)
      .set("Authorization", `Bearer ${token}`)).status).toBe(200);
  });

  it("leaves a created job retryable after a database failure during completion", async () => {
    const token = await createUser();
    const projectId = await createProject(token);
    const { response: initialized } = await initialize(token, projectId);
    const jobId = initialized.body.job.id as string;
    const databaseFailure = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("database unavailable"));

    const failed = await request(app)
      .post(`/api/jobs/${jobId}/complete`)
      .set("Authorization", `Bearer ${token}`);
    expect(failed.status).toBe(500);
    databaseFailure.mockRestore();
    expect((await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("created");

    const retry = await request(app)
      .post(`/api/jobs/${jobId}/complete`)
      .set("Authorization", `Bearer ${token}`);
    expect(retry.status).toBe(200);
    expect(retry.body.job.status).toBe("queued");
  });

  it("marks invalid stored objects failed and retries cleanup after storage failure", async () => {
    const token = await createUser();
    const projectId = await createProject(token);
    const { response: initialized } = await initialize(token, projectId);
    const jobId = initialized.body.job.id as string;
    object = { contentLength: 100_000_001, contentType: "text/plain" };
    deleteFailure = true;

    const rejected = await request(app)
      .post(`/api/jobs/${jobId}/complete`)
      .set("Authorization", `Bearer ${token}`);
    expect(rejected.status).toBe(503);
    expect(rejected.body.error.code).toBe("cleanup_pending");
    expect((await prisma.ingestionJob.findUniqueOrThrow({ where: { id: jobId } })).cleanupPending).toBe(true);

    deleteFailure = false;
    const cleaned = await request(app)
      .post(`/api/jobs/${jobId}/cleanup`)
      .set("Authorization", `Bearer ${token}`);
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.job.status).toBe("failed");
    expect(cleaned.body.job.cleanupPending).toBe(false);
    expect(deletedKeys).toHaveLength(1);
  });

  it("does not reveal a job to another user during URL renewal or completion", async () => {
    const owner = await createUser();
    const other = await createUser();
    const projectId = await createProject(owner);
    const { response: initialized } = await initialize(owner, projectId);
    const jobId = initialized.body.job.id as string;

    const renewed = await request(app)
      .post(`/api/jobs/${jobId}/upload-url`)
      .set("Authorization", `Bearer ${other}`);
    const completed = await request(app)
      .post(`/api/jobs/${jobId}/complete`)
      .set("Authorization", `Bearer ${other}`);
    expect(renewed.status).toBe(404);
    expect(completed.status).toBe(404);
    expect(renewed.text).not.toContain("objectKey");
  });
});
