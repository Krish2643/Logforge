import type { RequestHandler } from "express";
import { createProjectRequestSchema } from "@logforge/shared";
import { requireAuthenticatedUser } from "../../middleware/authenticate.js";
import type { ProjectsService } from "./projects.service.js";

export function createProjectController(
  projects: ProjectsService
): RequestHandler {
  return async (request, response) => {
    const input = createProjectRequestSchema.parse(request.body);
    const user = requireAuthenticatedUser(request);
    const project = await projects.create(user.id, input.name);
    response.status(201).json({ project });
  };
}

export function createListProjectsController(
  projects: ProjectsService
): RequestHandler {
  return async (request, response) => {
    const user = requireAuthenticatedUser(request);
    response.status(200).json({ projects: await projects.list(user.id) });
  };
}
