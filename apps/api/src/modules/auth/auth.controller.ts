import type { RequestHandler } from "express";
import { loginRequestSchema, registerRequestSchema } from "@logforge/shared";
import { requireAuthenticatedUser } from "../../middleware/authenticate.js";
import type { AuthService } from "./auth.service.js";

export function createRegisterController(auth: AuthService): RequestHandler {
  return async (request, response) => {
    const input = registerRequestSchema.parse(request.body);
    const result = await auth.register(input.email, input.password);
    response.status(201).json({
      user: result.user,
      accessToken: result.accessToken,
      tokenType: "Bearer",
      expiresAt: result.expiresAt.toISOString()
    });
  };
}

export function createLoginController(auth: AuthService): RequestHandler {
  return async (request, response) => {
    const input = loginRequestSchema.parse(request.body);
    const result = await auth.login(input.email, input.password);
    response.status(200).json({
      user: result.user,
      accessToken: result.accessToken,
      tokenType: "Bearer",
      expiresAt: result.expiresAt.toISOString()
    });
  };
}

export function createLogoutController(auth: AuthService): RequestHandler {
  return async (request, response) => {
    const user = requireAuthenticatedUser(request);
    await auth.logout(user.sessionId, user.id);
    response.status(204).end();
  };
}

export function createCurrentUserController(auth: AuthService): RequestHandler {
  return async (request, response) => {
    const user = requireAuthenticatedUser(request);
    response.status(200).json({ user: await auth.getCurrentUser(user.id) });
  };
}
