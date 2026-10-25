import { randomUUID } from "node:crypto";
import { prisma } from "../src/db/prisma.js";

const emailPrefix = `phase2-${randomUUID()}-`;

export function newEmail(): string {
  return `${emailPrefix}${randomUUID()}@example.test`;
}

export async function cleanupFixtures(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: emailPrefix } },
    select: { id: true }
  });
  const userIds = users.map((user) => user.id);

  if (userIds.length === 0) return;

  await prisma.logEvent.deleteMany({
    where: { project: { ownerId: { in: userIds } } }
  });
  await prisma.ingestionJob.deleteMany({
    where: { project: { ownerId: { in: userIds } } }
  });
  await prisma.project.deleteMany({ where: { ownerId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
