import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export const databaseProbe = {
  async checkConnection(): Promise<void> {
    await prisma.$queryRaw`SELECT 1`;
  }
};
