import type { RequestHandler } from "express";
import { logSearchQuerySchema, uuidSchema } from "@logforge/shared";
import { requireAuthenticatedUser } from "../../middleware/authenticate.js";
import type { LogsService } from "./logs.service.js";

export function createSearchLogsController(logs: LogsService): RequestHandler {
  return async (request, response) => {
    const projectId = uuidSchema.parse(request.params.id);
    const query = logSearchQuerySchema.parse(request.query);
    const user = requireAuthenticatedUser(request);
    response.status(200).json(await logs.search(user.id, projectId, query));
  };
}
