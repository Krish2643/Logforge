import pino from "pino";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { databaseProbe, prisma } from "../src/db/prisma.js";
import { cleanupFixtures, newEmail } from "./support.js";

const app = createApp({
  logger: pino({ enabled: false }),
  databaseProbe,
  prisma
});

afterAll(async () => {
  await cleanupFixtures();
});

async function createAccount(): Promise<string> {
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
    .send({ name: "Logs" });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.project.id as string;
}

describe("project log search", () => {
  it("filters and paginates only logs belonging to the caller's project", async () => {
    const ownerToken = await createAccount();
    const otherToken = await createAccount();
    const ownerProjectId = await createProject(ownerToken);
    const otherProjectId = await createProject(otherToken);
    const timestamp = new Date("2026-10-20T12:00:00.000Z");

    await prisma.logEvent.createMany({
      data: [
        {
          projectId: ownerProjectId,
          timestamp,
          level: "error",
          message: "Database disconnected",
          attributes: { source: "test" }
        },
        {
          projectId: ownerProjectId,
          timestamp: new Date(timestamp.getTime() - 1000),
          level: "info",
          message: "Request completed"
        },
        {
          projectId: otherProjectId,
          timestamp,
          level: "error",
          message: "Other user's private log"
        }
      ]
    });

    const firstPage = await request(app)
      .get(`/api/projects/${ownerProjectId}/logs?level=error&limit=1`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.databaseQueryDurationMs).toEqual(expect.any(Number));
    expect(firstPage.body.databaseQueryDurationMs).toBeGreaterThanOrEqual(0);
    expect(firstPage.body.logs).toHaveLength(1);
    expect(firstPage.body.logs[0].message).toBe("Database disconnected");
    expect(firstPage.body.nextCursor).toBeNull();

    const allOwnerLogs = await request(app)
      .get(`/api/projects/${ownerProjectId}/logs?limit=1`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(allOwnerLogs.body.logs).toHaveLength(1);
    expect(allOwnerLogs.body.nextCursor).toEqual(expect.any(String));

    const secondPage = await request(app)
      .get(
        `/api/projects/${ownerProjectId}/logs?limit=1&cursor=${allOwnerLogs.body.nextCursor}`
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(secondPage.body.logs[0].message).toBe("Request completed");

    const hiddenProject = await request(app)
      .get(`/api/projects/${ownerProjectId}/logs`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(hiddenProject.status).toBe(404);
    expect(hiddenProject.text).not.toContain("Database disconnected");
    expect(hiddenProject.text).not.toContain("Other user's private log");
  });

  it("rejects invalid time ranges and cursors", async () => {
    const token = await createAccount();
    const projectId = await createProject(token);

    const invalidRange = await request(app)
      .get(`/api/projects/${projectId}/logs?from=2026-10-21T00:00:00.000Z&to=2026-10-20T00:00:00.000Z`)
      .set("Authorization", `Bearer ${token}`);
    expect(invalidRange.status).toBe(400);

    const invalidCursor = await request(app)
      .get(`/api/projects/${projectId}/logs?cursor=00000000-0000-4000-8000-000000000000`)
      .set("Authorization", `Bearer ${token}`);
    expect(invalidCursor.status).toBe(400);
  });

  it("combines message, severity, service, time, request, status, and job filters", async () => {
    const token = await createAccount();
    const projectId = await createProject(token);
    const job = await prisma.ingestionJob.create({
      data: { projectId, status: "completed" }
    });
    const timestamp = new Date("2026-10-22T12:00:00.000Z");
    await prisma.logEvent.createMany({
      data: [
        {
          id: "40000000-0000-4000-8000-000000000001",
          projectId,
          ingestionJobId: job.id,
          lineNumber: 1,
          timestamp,
          level: "error",
          source: "payments-api",
          message: "Database connection failed",
          attributes: { request_id: "req-500", status: 500, latency_ms: 82 }
        },
        {
          id: "40000000-0000-4000-8000-000000000002",
          projectId,
          ingestionJobId: job.id,
          lineNumber: 2,
          timestamp,
          level: "error",
          source: "payments-api",
          message: "Database connection recovered",
          attributes: { request_id: "req-200", status: "200" }
        },
        {
          id: "40000000-0000-4000-8000-000000000003",
          projectId,
          ingestionJobId: job.id,
          lineNumber: 3,
          timestamp,
          level: "info",
          source: "worker",
          message: "Unstructured raw source line",
          attributes: {}
        }
      ]
    });

    const filtered = await request(app)
      .get(`/api/projects/${projectId}/logs?q=DATABASE&level=error&service=payments-api&from=2026-10-22T12:00:00.000Z&to=2026-10-22T12:00:00.000Z&httpStatus=500&requestId=req-500&jobId=${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(filtered.status).toBe(200);
    expect(filtered.body.logs).toHaveLength(1);
    expect(filtered.body.logs[0]).toMatchObject({
      id: "40000000-0000-4000-8000-000000000001",
      source: "payments-api",
      ingestionJobId: job.id
    });
    const stringStatus = await request(app)
      .get(`/api/projects/${projectId}/logs?httpStatus=200&requestId=req-200`)
      .set("Authorization", `Bearer ${token}`);
    expect(stringStatus.body.logs[0].id).toBe("40000000-0000-4000-8000-000000000002");
  });

  it("paginates equal timestamps deterministically and finds unstructured source lines", async () => {
    const token = await createAccount();
    const projectId = await createProject(token);
    const timestamp = new Date("2026-10-22T12:00:00.000Z");
    await prisma.logEvent.createMany({
      data: [
        {
          id: "50000000-0000-4000-8000-000000000001",
          projectId,
          timestamp,
          level: "info",
          message: "raw daemon output"
        },
        {
          id: "50000000-0000-4000-8000-000000000002",
          projectId,
          timestamp,
          level: "info",
          message: "another structured event"
        }
      ]
    });

    const first = await request(app)
      .get(`/api/projects/${projectId}/logs?limit=1`)
      .set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.logs[0].id).toBe("50000000-0000-4000-8000-000000000002");
    const second = await request(app)
      .get(`/api/projects/${projectId}/logs?limit=1&cursor=${first.body.nextCursor}`)
      .set("Authorization", `Bearer ${token}`);
    expect(second.body.logs[0].id).toBe("50000000-0000-4000-8000-000000000001");

    const rawLine = await request(app)
      .get(`/api/projects/${projectId}/logs?q=raw`)
      .set("Authorization", `Bearer ${token}`);
    expect(rawLine.body.logs[0].message).toBe("raw daemon output");
    expect(rawLine.body.logs[0].ingestionJobId).toBeNull();
  });

  it("rejects unsupported query parameters and invalid HTTP status values", async () => {
    const token = await createAccount();
    const projectId = await createProject(token);

    const unsupported = await request(app)
      .get(`/api/projects/${projectId}/logs?limit=10&unsupported=true`)
      .set("Authorization", `Bearer ${token}`);
    const invalidStatus = await request(app)
      .get(`/api/projects/${projectId}/logs?httpStatus=99`)
      .set("Authorization", `Bearer ${token}`);

    expect(unsupported.status).toBe(400);
    expect(invalidStatus.status).toBe(400);
  });

  it("treats SQL LIKE wildcard characters as literal search text", async () => {
    const token = await createAccount();
    const projectId = await createProject(token);
    await prisma.logEvent.createMany({
      data: [
        {
          id: "60000000-0000-4000-8000-000000000001",
          projectId,
          level: "error",
          message: "Budget reached 100% failure"
        },
        {
          id: "60000000-0000-4000-8000-000000000002",
          projectId,
          level: "error",
          message: "Budget reached 100x failure"
        }
      ]
    });

    const result = await request(app)
      .get(`/api/projects/${projectId}/logs?q=100%25`)
      .set("Authorization", `Bearer ${token}`);

    expect(result.status).toBe(200);
    expect(result.body.logs).toHaveLength(1);
    expect(result.body.logs[0].message).toBe("Budget reached 100% failure");
  });
});
