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
const password = "correct horse battery staple";

afterAll(async () => {
  await cleanupFixtures();
});

describe("authentication", () => {
  it("registers a normalized email and stores only password and session hashes", async () => {
    const email = newEmail().toUpperCase();
    const response = await request(app)
      .post("/api/auth/register")
      .send({ email, password });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe(email.toLowerCase());
    expect(response.body.user).not.toHaveProperty("passwordHash");
    expect(response.body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const storedUser = await prisma.user.findUniqueOrThrow({
      where: { email: email.toLowerCase() },
      include: { sessions: true }
    });
    expect(storedUser.passwordHash).not.toBe(password);
    expect(storedUser.sessions).toHaveLength(1);
    expect(storedUser.sessions[0].tokenHash).not.toBe(response.body.accessToken);
    expect(storedUser.sessions[0].tokenHash).toHaveLength(64);
  });

  it("uses one login error for unknown accounts and wrong passwords", async () => {
    const email = newEmail();
    const registration = await request(app)
      .post("/api/auth/register")
      .send({ email, password });
    expect(registration.status).toBe(201);

    const wrongPassword = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "wrong horse battery staple" });
    const unknownEmail = await request(app)
      .post("/api/auth/login")
      .send({ email: newEmail(), password });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe("invalid_credentials");
    expect(unknownEmail.body.error.code).toBe("invalid_credentials");
    expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it("revokes a session at logout and rejects it on the next request", async () => {
    const registration = await request(app)
      .post("/api/auth/register")
      .send({ email: newEmail(), password });
    const token = registration.body.accessToken as string;

    const currentUser = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(currentUser.status).toBe(200);

    const logout = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(logout.status).toBe(204);

    const revoked = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);
    expect(revoked.status).toBe(401);
  });

  it("lets the database resolve simultaneous registrations with the same email", async () => {
    const email = newEmail();
    const requests = await Promise.all([
      request(app).post("/api/auth/register").send({ email, password }),
      request(app).post("/api/auth/register").send({ email, password })
    ]);

    expect(requests.map((response) => response.status).sort()).toEqual([201, 409]);
  });
});
