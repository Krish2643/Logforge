import type { Prisma, PrismaClient } from "@prisma/client";
import type { LogSearchQuery } from "@logforge/shared";
import { ApiError } from "../../lib/api-error.js";
import { performance } from "node:perf_hooks";

const logSelection = {
  id: true,
  timestamp: true,
  level: true,
  message: true,
  source: true,
  ingestionJobId: true,
  attributes: true
} as const;

export function createLogsService(prisma: PrismaClient) {
  return {
    async search(ownerId: string, projectId: string, query: LogSearchQuery) {
      const project = await prisma.project.findFirst({
        where: { id: projectId, ownerId },
        select: { id: true }
      });

      if (!project) {
        throw new ApiError(404, "not_found", "Project was not found");
      }

      if (query.cursor) {
        const cursorLog = await prisma.logEvent.findFirst({
          where: { id: query.cursor, projectId: project.id },
          select: { id: true }
        });

        if (!cursorLog) {
          throw new ApiError(400, "invalid_cursor", "The log cursor is invalid for this project");
        }
      }

      const timestamp: Prisma.DateTimeFilter | undefined =
        query.from || query.to
          ? {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {})
            }
          : undefined;
      const filters: Prisma.LogEventWhereInput[] = [];
      if (query.q) {
        const escapedQuery = query.q.replace(/[\\%_]/g, "\\$&");
        filters.push({
          OR: [
            { message: { contains: escapedQuery, mode: "insensitive" } },
            { source: { contains: escapedQuery, mode: "insensitive" } }
          ]
        });
      }
      if (query.httpStatus !== undefined) {
        filters.push({
          OR: [
            { attributes: { path: ["status"], equals: query.httpStatus } },
            { attributes: { path: ["status"], equals: String(query.httpStatus) } }
          ]
        });
      }
      if (query.requestId) {
        filters.push({
          attributes: { path: ["request_id"], equals: query.requestId }
        });
      }
      const where: Prisma.LogEventWhereInput = {
        projectId: project.id,
        ...(query.level ? { level: query.level } : {}),
        ...(query.service ? { source: query.service } : {}),
        ...(query.jobId ? { ingestionJobId: query.jobId } : {}),
        ...(timestamp ? { timestamp } : {}),
        ...(filters.length ? { AND: filters } : {})
      };

      const queryStartedAt = performance.now();
      const rows = await prisma.logEvent.findMany({
        where,
        orderBy: [{ timestamp: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        select: logSelection
      });
      const databaseQueryDurationMs = Number((performance.now() - queryStartedAt).toFixed(3));
      const hasMore = rows.length > query.limit;
      const logs = hasMore ? rows.slice(0, query.limit) : rows;

      return {
        logs,
        nextCursor: hasMore ? logs[logs.length - 1]?.id ?? null : null,
        databaseQueryDurationMs
      };
    }
  };
}

export type LogsService = ReturnType<typeof createLogsService>;
