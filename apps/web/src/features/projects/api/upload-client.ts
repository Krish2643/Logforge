import {
  ingestionJobResponseSchema,
  ingestionJobsResponseSchema,
  uploadInitializationResponseSchema,
  uploadLimitsResponseSchema,
  type IngestionJobResponse,
  type UploadInitializationRequest,
  type UploadInitializationResponse,
  type UploadLimitsResponse
} from "@logforge/shared";
import { apiRequest } from "../../../lib/api-client.js";

export async function getUploadLimits(signal?: AbortSignal): Promise<UploadLimitsResponse> {
  return uploadLimitsResponseSchema.parse(
    await apiRequest<unknown>("/uploads/limits", { signal })
  );
}

export async function initializeUpload(
  projectId: string,
  input: UploadInitializationRequest
): Promise<UploadInitializationResponse> {
  return uploadInitializationResponseSchema.parse(
    await apiRequest<unknown>(`/projects/${projectId}/uploads`, {
      method: "POST",
      body: input
    })
  );
}

export async function createUploadUrl(jobId: string): Promise<UploadInitializationResponse> {
  return uploadInitializationResponseSchema.parse(
    await apiRequest<unknown>(`/jobs/${jobId}/upload-url`, { method: "POST" })
  );
}

export async function completeUpload(jobId: string): Promise<IngestionJobResponse> {
  const response = await apiRequest<unknown>(`/jobs/${jobId}/complete`, { method: "POST" });
  return ingestionJobResponseSchema.parse((response as { job: unknown }).job);
}

export async function getJob(jobId: string): Promise<IngestionJobResponse> {
  const response = await apiRequest<unknown>(`/jobs/${jobId}`);
  return ingestionJobResponseSchema.parse((response as { job: unknown }).job);
}

export async function cancelJob(jobId: string): Promise<IngestionJobResponse> {
  const response = await apiRequest<unknown>(`/jobs/${jobId}/cancel`, { method: "POST" });
  return ingestionJobResponseSchema.parse((response as { job: unknown }).job);
}

export async function retryJob(jobId: string): Promise<IngestionJobResponse> {
  const response = await apiRequest<unknown>(`/jobs/${jobId}/retry`, { method: "POST" });
  return ingestionJobResponseSchema.parse((response as { job: unknown }).job);
}

export async function getProjectJobs(
  projectId: string,
  options: { limit?: number; cursor?: string } = {},
  signal?: AbortSignal
) {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor) query.set("cursor", options.cursor);
  const suffix = query.size ? `?${query.toString()}` : "";
  return ingestionJobsResponseSchema.parse(
    await apiRequest<unknown>(`/projects/${projectId}/jobs${suffix}`, { signal })
  );
}

export async function retryUploadCleanup(jobId: string): Promise<IngestionJobResponse> {
  const response = await apiRequest<unknown>(`/jobs/${jobId}/cleanup`, { method: "POST" });
  return ingestionJobResponseSchema.parse((response as { job: unknown }).job);
}

export function uploadFileWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
      } else if (request.status === 403) {
        reject(new Error("R2 rejected the upload URL. It may have expired; retry to renew it."));
      } else {
        reject(new Error(`R2 rejected the upload (HTTP ${request.status}). Retry the upload.`));
      }
    };
    request.onerror = () => reject(new Error("The direct upload failed. Check the network and R2 CORS settings, then retry."));
    request.onabort = () => reject(new Error("The upload was interrupted. Retry to continue."));
    request.send(file);
  });
}
