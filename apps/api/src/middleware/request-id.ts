import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const requestIdMiddleware: RequestHandler = (request, response, next) => {
  const suppliedId = request.get("x-request-id");
  const requestId = suppliedId && REQUEST_ID_PATTERN.test(suppliedId) ? suppliedId : randomUUID();
  response.setHeader("X-Request-ID", requestId);
  next();
};
