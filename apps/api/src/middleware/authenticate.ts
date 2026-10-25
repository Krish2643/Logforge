import type { RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { ApiError } from "../lib/api-error.js";
import { hashSessionToken } from "../lib/session-token.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  sessionId: string;
}

declare global {
  namespace Express {
    interface Request {
      authenticatedUser?: AuthenticatedUser;
    }
  }
}

export function requireAuthenticatedUser(request: Express.Request): AuthenticatedUser {
  if (!request.authenticatedUser) {
    throw new ApiError(401, "unauthorized", "Authentication is required");
  }
  return request.authenticatedUser;
}

export function createAuthenticate(prisma: PrismaClient): RequestHandler {
  return async (request, _response, next) => {
    const authorization = request.get("authorization");
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/);

    if (!match) {
      throw new ApiError(401, "unauthorized", "Authentication is required");
    }

    const tokenHash = hashSessionToken(match[1]);
    const session = await prisma.session.findFirst({
      where: {
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      },
      select: {
        id: true,
        user: { select: { id: true, email: true } }
      }
    });

    if (!session) {
      throw new ApiError(401, "invalid_session", "The session is invalid or expired");
    }

    request.authenticatedUser = {
      id: session.user.id,
      email: session.user.email,
      sessionId: session.id
    };
    next();
  };
}
