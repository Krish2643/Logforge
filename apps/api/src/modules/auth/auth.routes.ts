import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { PrismaClient } from "@prisma/client";
import { ApiError } from "../../lib/api-error.js";
import { createAuthenticate } from "../../middleware/authenticate.js";
import {
  createCurrentUserController,
  createLoginController,
  createLogoutController,
  createRegisterController
} from "./auth.controller.js";
import { createAuthService } from "./auth.service.js";

export function createAuthRouter(prisma: PrismaClient): Router {
  const router = Router();
  const auth = createAuthService(prisma);
  const authenticate = createAuthenticate(prisma);
  const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, _response, next) => {
      next(new ApiError(429, "rate_limited", "Too many authentication attempts"));
    }
  });

  router.post("/register", authRateLimit, createRegisterController(auth));
  router.post("/login", authRateLimit, createLoginController(auth));
  router.post("/logout", authenticate, createLogoutController(auth));
  router.get("/me", authenticate, createCurrentUserController(auth));

  return router;
}
