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

async function register(): Promise<string> {
  const response = await request(app)
    .post("/api/auth/register")
    .send({ email: newEmail(), password: "correct horse battery staple" });
  expect(response.status).toBe(201);
  return response.body.accessToken as string;
}

describe("projects", () => {
  it("creates and lists only projects owned by the authenticated user", async () => {
    const ownerToken = await register();
    const otherToken = await register();
    const created = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "  Production API  " });

    expect(created.status).toBe(201);
    expect(created.body.project.name).toBe("Production API");

    const ownerProjects = await request(app)
      .get("/api/projects")
      .set("Authorization", `Bearer ${ownerToken}`);
    const otherProjects = await request(app)
      .get("/api/projects")
      .set("Authorization", `Bearer ${otherToken}`);

    expect(ownerProjects.body.projects).toHaveLength(1);
    expect(otherProjects.body.projects).toEqual([]);

    const duplicate = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Production API" });
    expect(duplicate.status).toBe(409);
  });

  it("validates names and requires authentication", async () => {
    const unauthenticated = await request(app).get("/api/projects");
    expect(unauthenticated.status).toBe(401);

    const token = await register();
    const invalid = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "   " });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("validation_error");
  });

  it("lists recently created projects before older ones", async () => {
    const token = await register();
    await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Older project" })
      .expect(201);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Newer project" })
      .expect(201);

    const response = await request(app)
      .get("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body.projects.map((project: { name: string }) => project.name)).toEqual([
      "Newer project",
      "Older project"
    ]);
  });
});
