import type { PrismaClient } from "@prisma/client";
import { ApiError } from "../../lib/api-error.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { createSessionToken, SESSION_LIFETIME_MS } from "../../lib/session-token.js";

const userSelection = {
  id: true,
  email: true,
  createdAt: true
} as const;

export function createAuthService(prisma: PrismaClient) {
  async function createSession(userId: string) {
    const { token, tokenHash } = createSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
    const session = await prisma.session.create({
      data: { userId, tokenHash, expiresAt },
      select: { expiresAt: true }
    });

    return { token, expiresAt: session.expiresAt };
  }

  return {
    async register(email: string, password: string) {
      const passwordHash = await hashPassword(password);
      const { token, tokenHash } = createSessionToken();
      const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

      const result = await prisma.$transaction(async (transaction) => {
        const user = await transaction.user.create({
          data: { email, passwordHash },
          select: userSelection
        });
        const session = await transaction.session.create({
          data: { userId: user.id, tokenHash, expiresAt },
          select: { expiresAt: true }
        });

        return { user, expiresAt: session.expiresAt };
      });

      return { ...result, accessToken: token };
    },

    async login(email: string, password: string) {
      const user = await prisma.user.findUnique({
        where: { email },
        select: { ...userSelection, passwordHash: true }
      });

      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        throw new ApiError(401, "invalid_credentials", "Email or password is incorrect");
      }

      const session = await createSession(user.id);
      const { passwordHash: _passwordHash, ...safeUser } = user;
      return { user: safeUser, expiresAt: session.expiresAt, accessToken: session.token };
    },

    async logout(sessionId: string, userId: string): Promise<void> {
      await prisma.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
    },

    async getCurrentUser(userId: string) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: userSelection
      });

      if (!user) {
        throw new ApiError(401, "unauthorized", "Authentication is required");
      }

      return user;
    }
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
