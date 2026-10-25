import pino from "pino";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { databaseProbe, prisma } from "../src/db/prisma.js";
import { cleanupFixtures, newEmail } from "./support.js";

const app = createApp({
  logger: pino({ enabled: false }),
  databaseProbe,
  prisma,
  readWorkerMemory: async () => ({
    rssBytes: 10_000,
    heapUsedBytes: 5_000,
    externalBytes: 2_000,
    arrayBuffersBytes: 1_000,
    sampledAt: new Date().toISOString(),
    uptimeSeconds: 12,
    activeJobIds: [],
    peakRssBytesDuringProcessing: 12_000,
    peakHeapUsedBytesDuringProcessing: 6_000,
    peakWindowEndedAt: new Date().toISOString()
  })
});

afterAll(async () => {
  await cleanupFixtures();
});

describe("runtime metrics", () => {
  it("requires authentication and returns process memory snapshots", async () => {
    const unauthenticated = await request(app).get("/api/metrics/runtime");
    expect(unauthenticated.status).toBe(401);

    const registered = await request(app)
      .post("/api/auth/register")
      .send({ email: newEmail(), password: "correct horse battery staple" });
    expect(registered.status).toBe(201);

    const response = await request(app)
      .get("/api/metrics/runtime")
      .set("Authorization", `Bearer ${registered.body.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.api).toMatchObject({
      rssBytes: expect.any(Number),
      heapUsedBytes: expect.any(Number),
      externalBytes: expect.any(Number),
      arrayBuffersBytes: expect.any(Number),
      sampledAt: expect.any(String)
    });
    expect(response.body.workerStatus).toBe("available");
    expect(response.body.worker.peakRssBytesDuringProcessing).toBe(12_000);
  });
});
