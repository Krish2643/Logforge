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

describe("authentication rate limit", () => {
  it("limits repeated authentication attempts with the standard error shape", async () => {
    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(await request(app).post("/api/auth/login").send({}));
    }

    expect(responses.slice(0, 10).every((response) => response.status === 400)).toBe(true);
    expect(responses[10].status).toBe(429);
    expect(responses[10].body.error.code).toBe("rate_limited");
    expect(responses[10].body.error.requestId).toBe(
      responses[10].headers["x-request-id"]
    );
  });
});
