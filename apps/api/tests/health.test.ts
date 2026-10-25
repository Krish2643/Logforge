import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/db/prisma.js";
import type { DatabaseProbe } from "../src/modules/health/health.service.js";

const logger = pino({ enabled: false });

describe("GET /health", () => {
  it("reports a connected database with HTTP 200", async () => {
    const databaseProbe: DatabaseProbe = {
      checkConnection: vi.fn().mockResolvedValue(undefined)
    };
    const response = await request(createApp({ logger, databaseProbe, prisma })).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ok",
      dependencies: { database: "connected" }
    });
    expect(Number.isNaN(Date.parse(response.body.checkedAt))).toBe(false);
  });

  it("reports an unavailable database with HTTP 503 and no database details", async () => {
    const databaseProbe: DatabaseProbe = {
      checkConnection: vi.fn().mockRejectedValue(new Error("sensitive connection detail"))
    };
    const response = await request(createApp({ logger, databaseProbe, prisma })).get("/health");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: "degraded",
      dependencies: { database: "unavailable" }
    });
    expect(response.text).not.toContain("sensitive connection detail");
  });
});
