import type { PrismaClient } from "@prisma/client";

const projectSelection = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true
} as const;

export function createProjectsService(prisma: PrismaClient) {
  return {
    async create(ownerId: string, name: string) {
      return prisma.project.create({
        data: { ownerId, name },
        select: projectSelection
      });
    },

    async list(ownerId: string) {
      return prisma.project.findMany({
        where: { ownerId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: projectSelection
      });
    }
  };
}

export type ProjectsService = ReturnType<typeof createProjectsService>;
