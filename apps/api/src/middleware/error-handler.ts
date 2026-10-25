import { Prisma } from "@prisma/client";
import type { ErrorRequestHandler } from "express";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { ApiError } from "../lib/api-error.js";

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    const requestId = String(response.getHeader("X-Request-ID") ?? "unknown");
    const logLevel =
      error instanceof ZodError || (error instanceof ApiError && error.statusCode < 500)
        ? "warn"
        : "error";
    logger[logLevel](
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        requestId
      },
      "Request failed"
    );

    if (response.headersSent) {
      next(error);
      return;
    }

    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "validation_error",
          message: "Request validation failed",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          })),
          requestId
        }
      });
      return;
    }

    if (error instanceof ApiError) {
      response.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          requestId
        }
      });
      return;
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      response.status(409).json({
        error: {
          code: "resource_conflict",
          message: "A record with those values already exists",
          requestId
        }
      });
      return;
    }

    if (
      error instanceof Prisma.PrismaClientInitializationError ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P1001", "P1002", "P1008", "P1017"].includes(error.code))
    ) {
      response.status(503).json({
        error: {
          code: "database_unavailable",
          message: "The database is temporarily unavailable",
          requestId
        }
      });
      return;
    }

    if (hasErrorType(error, "entity.parse.failed")) {
      response.status(400).json({
        error: { code: "invalid_json", message: "Request body must be valid JSON", requestId }
      });
      return;
    }

    if (hasErrorType(error, "entity.too.large")) {
      response.status(413).json({
        error: { code: "payload_too_large", message: "Request body is too large", requestId }
      });
      return;
    }

    response.status(500).json({
      error: {
        code: "internal_error",
        message: "An unexpected server error occurred",
        requestId
      }
    });
  };
}

function hasErrorType(error: unknown, type: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === type
  );
}
