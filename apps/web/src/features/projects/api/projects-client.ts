import {
  createProjectRequestSchema,
  projectsResponseSchema,
  projectResponseSchema,
  type ProjectResponse
} from "@logforge/shared";
import { apiRequest } from "../../../lib/api-client.js";

export async function getProjects(signal?: AbortSignal): Promise<ProjectResponse[]> {
  const response = await apiRequest<unknown>("/projects", { signal });
  return projectsResponseSchema.parse(response).projects;
}

export async function createProject(name: string): Promise<ProjectResponse> {
  const input = createProjectRequestSchema.parse({ name });
  const response = await apiRequest<unknown>("/projects", {
    method: "POST",
    body: input
  });
  return projectResponseSchema.parse((response as { project: unknown }).project);
}
