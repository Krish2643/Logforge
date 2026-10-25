import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { databaseProbe, prisma } from "../src/db/prisma.js";

const app = createApp({
  logger: pino({ enabled: false }),
  databaseProbe,
  prisma
});

describe("request IDs and error responses", () => {
  it("preserves a valid request ID in response and error body", async () => {
    const response = await request(app)
      .get("/api/not-a-route")
      .set("X-Request-ID", "trace.phase2-123");

    expect(response.status).toBe(404);
    expect(response.headers["x-request-id"]).toBe("trace.phase2-123");
    expect(response.body.error.requestId).toBe("trace.phase2-123");
  });

  it("replaces an invalid request ID with a generated UUID", async () => {
    const response = await request(app)
      .get("/api/not-a-route")
      .set("X-Request-ID", "bad id");

    expect(response.status).toBe(404);
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(response.body.error.requestId).toBe(response.headers["x-request-id"]);
  });
});
