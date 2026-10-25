import type { RequestHandler } from "express";
import {
  uploadInitializationRequestSchema,
  uuidSchema
} from "@logforge/shared";
import { requireAuthenticatedUser } from "../../middleware/authenticate.js";
import type { UploadService } from "./uploads.service.js";

export function createInitializeUploadController(uploads: UploadService): RequestHandler {
  return async (request, response) => {
    const user = requireAuthenticatedUser(request);
    const projectId = uuidSchema.parse(request.params.id);
    const input = uploadInitializationRequestSchema.parse(request.body);
    response.status(201).json(await uploads.initialize(user.id, projectId, input));
  };
}

export function createCreateUploadUrlController(uploads: UploadService): RequestHandler {
  return async (request, response) => {
    const user = requireAuthenticatedUser(request);
    const jobId = uuidSchema.parse(request.params.id);
    response.status(200).json(await uploads.createUploadUrl(user.id, jobId));
  };
}

export function createCompleteUploadController(uploads: UploadService): RequestHandler {
  return async (request, response) => {
    const user = requireAuthenticatedUser(request);
    const jobId = uuidSchema.parse(request.params.id);
    response.status(200).json({ job: await uploads.complete(user.id, jobId) });
  };
}

export function createDeleteRejectedUploadController(uploads: UploadService): RequestHandler {
  return async (request, response) => {
    const user = requireAuthenticatedUser(request);
    const jobId = uuidSchema.parse(request.params.id);
    response.status(200).json({ job: await uploads.cleanup(user.id, jobId) });
  };
}

export function createUploadLimitsController(config: {
  MAX_UPLOAD_SIZE_BYTES: number;
}): RequestHandler {
  return (_request, response) => {
    response.status(200).json({
      minimumFileSizeBytes: 10_000_000,
      maximumFileSizeBytes: config.MAX_UPLOAD_SIZE_BYTES,
      supportedExtensions: [".log", ".jsonl"]
    });
  };
}
