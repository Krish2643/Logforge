import { useCallback, useEffect, useState } from "react";
import type { IngestionJobResponse } from "@logforge/shared";
import { cancelJob, getProjectJobs, retryJob } from "../api/upload-client.js";
import type { ProjectResponse } from "@logforge/shared";

interface ProjectJobsProps {
  project: ProjectResponse;
  refreshKey: number;
}

function formatFileSize(size: number | null): string {
  if (size === null) return "No file attached";
  if (size < 1_000_000) return `${(size / 1_000).toFixed(0)} KB`;
  return `${(size / 1_000_000).toFixed(2)} MB`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = (totalSeconds % 60).toFixed(2);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function processingDuration(job: IngestionJobResponse): string | null {
  if (!job.processingStartedAt) return null;
  const startedAt = Date.parse(job.processingStartedAt);
  const endedAt = job.processingCompletedAt ? Date.parse(job.processingCompletedAt) : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  return formatDuration(endedAt - startedAt);
}

function statusLabel(job: IngestionJobResponse): string {
  if (job.status === "uploaded") return "Uploaded · ready for processing";
  if (job.status === "created") return job.originalFilename ? "Upload pending" : "Created";
  if (job.status === "completed") return "Processed";
  if (job.status === "failed") return "Failed";
  if (job.status === "cancelled") return "Cancelled";
  if (job.status === "processing" && job.cancelRequestedAt) return "Cancellation requested";
  return job.status.charAt(0).toUpperCase() + job.status.slice(1);
}

const processingStages = ["Uploaded", "Queued", "Processing", "Processed"];

function stageIndex(job: IngestionJobResponse): number {
  if (job.status === "completed") return 3;
  if (job.status === "processing") return 2;
  if (job.status === "failed" || job.status === "cancelled") {
    return job.processingStartedAt ? 2 : 1;
  }
  if (job.status === "queued" || job.status === "uploaded") return 1;
  return 0;
}

function stageDescription(job: IngestionJobResponse): string {
  if (job.status === "queued") return "Your file is verified and waiting for a worker.";
  if (job.status === "processing" && job.cancelRequestedAt) return "Cancellation requested. The worker will stop at a safe batch boundary.";
  if (job.status === "processing") return "Reading and indexing log events.";
  if (job.status === "completed") return "All available log events have been processed.";
  if (job.status === "failed") return "Processing stopped. Review the error below before retrying.";
  if (job.status === "cancelled") return "Processing stopped. Events already saved are retained.";
  if (job.status === "uploaded") return "Upload verified. Processing is ready to be queued.";
  if (job.status === "created") return "Upload has not been verified yet.";
  return "Preparing the ingestion job.";
}

function ProcessingActivity({ job }: { job: IngestionJobResponse }) {
  const activeIndex = stageIndex(job);
  const isActive = job.status === "queued" || job.status === "processing";
  const isInterrupted = job.status === "failed" || job.status === "cancelled";
  const processingPercent =
    job.fileSizeBytes && job.fileSizeBytes > 0
      ? Math.min(100, Math.floor((job.bytesProcessed / job.fileSizeBytes) * 100))
      : 0;

  return (
    <div
      className={`processing-activity${isActive ? " processing-activity--active" : ""}${isInterrupted ? " processing-activity--interrupted" : ""}`}
      aria-label={`Ingestion progress: ${statusLabel(job)}`}
      aria-busy={isActive}
    >
      <ol className="processing-stepper">
        {processingStages.map((stage, index) => {
          const completed = job.status === "completed" || index < activeIndex;
          const current = !completed && index === activeIndex && isActive;
          const interrupted = !completed && index === activeIndex && isInterrupted;
          return (
            <li
              className={[
                "processing-step",
                completed ? "processing-step--complete" : "",
                current ? "processing-step--current" : "",
                interrupted ? "processing-step--interrupted" : ""
              ].filter(Boolean).join(" ")}
              key={stage}
              aria-current={current ? "step" : undefined}
            >
              <span className="processing-step-marker" aria-hidden="true">
                {completed ? "✓" : interrupted ? "!" : index + 1}
              </span>
              <span>{stage}</span>
            </li>
          );
        })}
      </ol>
      <p className="processing-activity-caption">{stageDescription(job)}</p>
      {job.status === "processing" && job.fileSizeBytes !== null && job.fileSizeBytes > 0 && (
        <div className="processing-progress">
          <div
            className="activity-progress-track"
            role="progressbar"
            aria-label="Processing progress by bytes read"
            aria-valuemin={0}
            aria-valuemax={job.fileSizeBytes}
            aria-valuenow={Math.min(job.bytesProcessed, job.fileSizeBytes)}
          >
            <span className="activity-progress-fill" style={{ width: `${processingPercent}%` }} />
          </div>
          <span>{processingPercent}%</span>
        </div>
      )}
      {job.status === "queued" && (
        <div className="activity-progress-track activity-progress-track--indeterminate" aria-hidden="true">
          <span className="activity-progress-fill" />
        </div>
      )}
    </div>
  );
}

export function ProjectJobs({ project, refreshKey }: ProjectJobsProps) {
  const [jobs, setJobs] = useState<IngestionJobResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cancellingJobId, setCancellingJobId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelErrorJobId, setCancelErrorJobId] = useState<string | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryErrorJobId, setRetryErrorJobId] = useState<string | null>(null);

  const loadJobs = useCallback(async (
    signal?: AbortSignal,
    cursor?: string,
    silent = false
  ) => {
    if (cursor) setIsLoadingMore(true);
    else if (!silent) setIsLoading(true);
    setError(null);
    try {
      const result = await getProjectJobs(project.id, { ...(cursor ? { cursor } : {}) }, signal);
      if (!signal?.aborted) {
        setJobs((previous) => {
          if (cursor) return [...previous, ...result.jobs];
          if (!silent) return result.jobs;
          const refreshed = new Map(result.jobs.map((job) => [job.id, job]));
          return previous.map((job) => refreshed.get(job.id) ?? job);
        });
        setNextCursor(result.nextCursor);
      }
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "Unable to load ingestion jobs.");
    } finally {
      if (!signal?.aborted) {
        if (!silent || !cursor) setIsLoading(false);
        if (!silent) setIsLoadingMore(false);
      }
    }
  }, [project.id]);

  const requestCancellation = async (jobId: string) => {
    setCancellingJobId(jobId);
    setCancelError(null);
    setCancelErrorJobId(null);
    try {
      const updated = await cancelJob(jobId);
      setJobs((previous) => previous.map((job) => job.id === updated.id ? updated : job));
    } catch (cause) {
      setCancelError(cause instanceof Error ? cause.message : "Unable to cancel this job.");
      setCancelErrorJobId(jobId);
    } finally {
      setCancellingJobId(null);
    }
  };

  const requestRetry = async (jobId: string) => {
    setRetryingJobId(jobId);
    setRetryError(null);
    setRetryErrorJobId(null);
    try {
      const updated = await retryJob(jobId);
      setJobs((previous) => previous.map((job) => job.id === updated.id ? updated : job));
    } catch (cause) {
      setRetryError(cause instanceof Error ? cause.message : "Unable to retry this job.");
      setRetryErrorJobId(jobId);
      setRetryingJobId(null);
      return;
    } finally {
      setRetryingJobId(null);
    }
    await loadJobs();
  };

  useEffect(() => {
    const controller = new AbortController();
    void loadJobs(controller.signal);
    return () => controller.abort();
  }, [loadJobs, refreshKey]);

  useEffect(() => {
    if (!jobs.some((job) => job.status === "queued" || job.status === "processing")) return;
    const timer = window.setInterval(() => void loadJobs(undefined, undefined, true), 2_000);
    return () => window.clearInterval(timer);
  }, [jobs, loadJobs]);

  return (
    <section
      className="project-jobs"
      aria-labelledby={`project-jobs-title-${project.id}`}
      aria-live="polite"
    >
      <div className="project-jobs-heading">
        <h3 id={`project-jobs-title-${project.id}`}>Uploads and ingestion jobs</h3>
      </div>
      {isLoading ? (
        <p className="muted-copy" role="status">Loading jobs…</p>
      ) : error ? (
        <div className="project-jobs-state">
          <p className="form-error" role="alert">{error}</p>
          <button className="secondary-button" type="button" onClick={() => void loadJobs()}>
            Retry
          </button>
        </div>
      ) : jobs.length === 0 ? (
        <p className="muted-copy project-jobs-empty">No ingestion jobs yet.</p>
      ) : (
        <ul className="ingestion-job-list">
          {jobs.map((job) => (
            <li className="ingestion-job" key={job.id}>
              <div className="ingestion-job-main">
                <strong>{job.originalFilename ?? "Metadata-only job"}</strong>
                <span>{formatFileSize(job.fileSizeBytes)}</span>
                <span className={`job-status job-status--${job.status}`}>
                  {statusLabel(job)}
                </span>
              </div>
              <div className="ingestion-job-meta">
                <span>Created {new Date(job.createdAt).toLocaleString()}</span>
                {job.uploadCompletedAt && (
                  <span>Uploaded {new Date(job.uploadCompletedAt).toLocaleString()}</span>
                )}
                {job.status === "failed" && (
                  <span className="job-error">
                    {job.failureReason ??
                      (job.cleanupPending
                      ? "Rejected upload object cleanup is pending."
                      : "The upload failed or its object did not pass verification.")}
                  </span>
                )}
                {(job.status === "queued" || job.status === "processing") && (
                  <span>
                    {job.status === "queued"
                      ? "Waiting for a worker"
                      : `Processed ${job.bytesProcessed.toLocaleString()} of ${(job.fileSizeBytes ?? 0).toLocaleString()} bytes`}
                    {` · ${job.eventsPersisted.toLocaleString()} stored events · ${job.malformedLines.toLocaleString()} malformed`}
                  </span>
                )}
                {job.status === "completed" && (
                  <span>
                    {job.eventsPersisted.toLocaleString()} stored events · {job.linesProcessed.toLocaleString()} lines read
                    {job.malformedLines > 0 && ` · ${job.malformedLines.toLocaleString()} malformed`}
                  </span>
                )}
                {job.status === "cancelled" && (
                  <span>
                    Cancelled after {job.eventsPersisted.toLocaleString()} events; persisted events were retained.
                  </span>
                )}
                {processingDuration(job) !== null && (
                  <span>Processing duration {processingDuration(job)}</span>
                )}
              </div>
              {job.originalFilename && (
                <ProcessingActivity job={job} />
              )}
              {(job.status === "queued" || job.status === "processing") && (
                <div className="job-cancel-action">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={cancellingJobId !== null || job.cancelRequestedAt !== null}
                    onClick={() => void requestCancellation(job.id)}
                  >
                    {cancellingJobId === job.id || job.cancelRequestedAt
                      ? "Cancelling…"
                      : "Cancel processing"}
                  </button>
                  {cancelError && cancelErrorJobId === job.id && cancellingJobId === null && (
                    <span className="job-error" role="alert">{cancelError}</span>
                  )}
                </div>
              )}
              {(job.status === "cancelled" || job.status === "failed") && (
                <div className="job-cancel-action">
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={retryingJobId !== null || cancellingJobId !== null}
                    onClick={() => void requestRetry(job.id)}
                  >
                    {retryingJobId === job.id ? "Retrying…" : "Retry processing"}
                  </button>
                  {retryError && retryErrorJobId === job.id && retryingJobId === null && (
                    <span className="job-error" role="alert">{retryError}</span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {!isLoading && !error && nextCursor && (
        <button
          className="secondary-button"
          type="button"
          disabled={isLoadingMore}
          onClick={() => void loadJobs(undefined, nextCursor)}
        >
          {isLoadingMore ? "Loading more…" : "Load more jobs"}
        </button>
      )}
    </section>
  );
}
