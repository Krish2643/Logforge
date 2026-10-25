import type { RequestHandler } from "express";
import {
  createIngestionJobRequestSchema,
  ingestionJobListQuerySchema,
  uuidSchema
} from "@logforge/shared";
import { requireAuthenticatedUser } from "../../middleware/authenticate.js";
import type { JobsService } from "./jobs.service.js";

export function createJobController(jobs: JobsService): RequestHandler {
  return async (request, response) => {
    const projectId = uuidSchema.parse(request.params.id);
    createIngestionJobRequestSchema.parse(request.body ?? {});
    const user = requireAuthenticatedUser(request);
    const job = await jobs.create(user.id, projectId);
    response.status(201).json({ job });
  };
}

export function createGetJobController(jobs: JobsService): RequestHandler {
  return async (request, response) => {
    const jobId = uuidSchema.parse(request.params.id);
    const user = requireAuthenticatedUser(request);
    response.status(200).json({ job: await jobs.get(user.id, jobId) });
  };
}

export function createCancelJobController(jobs: JobsService): RequestHandler {
  return async (request, response) => {
    const jobId = uuidSchema.parse(request.params.id);
    const user = requireAuthenticatedUser(request);
    response.status(200).json({ job: await jobs.cancel(user.id, jobId) });
  };
}

export function createRetryJobController(jobs: JobsService): RequestHandler {
  return async (request, response) => {
    const jobId = uuidSchema.parse(request.params.id);
    const user = requireAuthenticatedUser(request);
    response.status(200).json({ job: await jobs.retry(user.id, jobId) });
  };
}

export function createListProjectJobsController(jobs: JobsService): RequestHandler {
  return async (request, response) => {
    const projectId = uuidSchema.parse(request.params.id);
    const query = ingestionJobListQuerySchema.parse(request.query);
    const user = requireAuthenticatedUser(request);
    response.status(200).json(await jobs.listForProject(user.id, projectId, query));
  };
}
