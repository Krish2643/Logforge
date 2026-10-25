import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type {
  ProjectResponse,
  UploadInitializationResponse,
  UploadLimitsResponse
} from "@logforge/shared";
import { ApiError } from "../../../lib/api-client.js";
import {
  completeUpload,
  createUploadUrl,
  getJob,
  initializeUpload,
  retryUploadCleanup,
  uploadFileWithProgress
} from "../api/upload-client.js";

interface ProjectUploadProps {
  project: ProjectResponse;
  limits: UploadLimitsResponse;
  onUploadComplete(): void;
}

function formatFileSize(size: number): string {
  return `${(size / 1_000_000).toFixed(1)} MB`;
}

export function ProjectUpload({ project, limits, onUploadComplete }: ProjectUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [fileUploaded, setFileUploaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<"preparing" | "transferring" | "verifying" | "cleaning">("preparing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const idempotencyKey = useRef(crypto.randomUUID());

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setJobId(null);
    setFileUploaded(false);
    setProgress(0);
    setErrorMessage(null);
    setErrorCode(null);
    setSuccess(null);
    idempotencyKey.current = crypto.randomUUID();
  }

  function validateFile(selected: File): string | null {
    const extension = selected.name.slice(selected.name.lastIndexOf(".")).toLowerCase();
    if (!limits.supportedExtensions.some((allowed) => allowed === extension)) {
      return "Choose a .log or .jsonl file.";
    }
    if (selected.size < limits.minimumFileSizeBytes) {
      return "Files must be at least 10 MB (decimal).";
    }
    if (selected.size > limits.maximumFileSizeBytes) {
      return `File exceeds the ${formatFileSize(limits.maximumFileSizeBytes)} upload limit.`;
    }
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setErrorCode(null);
    setSuccess(null);

    if (jobId && errorCode === "cleanup_pending") {
      setIsUploading(true);
      setUploadPhase("cleaning");
      setUploadPhase("preparing");
      try {
        await retryUploadCleanup(jobId);
        setJobId(null);
        setFileUploaded(false);
        setProgress(0);
        setSuccess("Rejected object removed. You can retry with the selected file.");
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Unable to clean up the rejected object.");
        setErrorCode(error instanceof ApiError ? error.code : null);
      } finally {
        setIsUploading(false);
      }
      return;
    }

    if (!file) {
      setErrorMessage("Choose a file to upload.");
      return;
    }
    const validationError = validateFile(file);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    setIsUploading(true);
    try {
      let activeJobId = jobId;
      let upload: UploadInitializationResponse["upload"] | undefined;
      if (!activeJobId) {
        const initialized = await initializeUpload(project.id, {
          filename: file.name,
          fileSizeBytes: file.size,
          idempotencyKey: idempotencyKey.current
        });
        activeJobId = initialized.job.id;
        setJobId(activeJobId);
        upload = initialized.upload;
      } else if (!fileUploaded) {
        upload = (await createUploadUrl(activeJobId)).upload;
      }

      if (!fileUploaded && upload) {
        setUploadPhase("transferring");
        await uploadFileWithProgress(upload.url, file, upload.headers, setProgress);
        setFileUploaded(true);
      }

      if (!activeJobId) throw new Error("The upload job could not be created.");
      setUploadPhase("verifying");
      const completed = await completeUpload(activeJobId);
      const refreshed = await getJob(completed.id);
      if (refreshed.status === "created") {
        throw new Error("The API has not confirmed that the upload is ready.");
      }
      onUploadComplete();
      setSuccess(
        refreshed.status === "failed"
          ? `${file.name} uploaded and verified, but processing failed: ${
            refreshed.failureReason ?? "See the ingestion job for details."
          }`
          : `${file.name} uploaded and verified. Ingestion status: ${refreshed.status}.`
      );
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setJobId(null);
      setFileUploaded(false);
      setProgress(0);
      idempotencyKey.current = crypto.randomUUID();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The upload failed.");
      setErrorCode(error instanceof ApiError ? error.code : null);
    } finally {
      setIsUploading(false);
      setUploadPhase("preparing");
    }
  }

  return (
    <form className="project-upload" onSubmit={(event) => void handleSubmit(event)}>
      <label className="field-label" htmlFor={`upload-${project.id}`}>Upload log file</label>
      <input
        className="file-input"
        id={`upload-${project.id}`}
        ref={fileInput}
        type="file"
        accept=".log,.jsonl"
        disabled={isUploading}
        onChange={chooseFile}
      />
      {file && (
        <p className="field-hint">
          {file.name} · {formatFileSize(file.size)}
        </p>
      )}
      {isUploading && (
        <div className="upload-activity" role="status" aria-live="polite">
          <div className="upload-activity-heading">
            <span className="activity-indicator" aria-hidden="true" />
            <span>
              {uploadPhase === "cleaning"
                ? "Cleaning up rejected upload"
                : uploadPhase === "preparing"
                ? "Preparing secure upload"
                : uploadPhase === "transferring"
                  ? "Uploading file to storage"
                  : "Verifying uploaded file"}
            </span>
            {uploadPhase === "transferring" && <strong>{progress}%</strong>}
          </div>
          {uploadPhase === "transferring" ? (
            <div
              className="activity-progress-track"
              role="progressbar"
              aria-label="File upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <span className="activity-progress-fill" style={{ width: `${progress}%` }} />
            </div>
          ) : (
            <div className="activity-progress-track activity-progress-track--indeterminate" aria-hidden="true">
              <span className="activity-progress-fill" />
            </div>
          )}
          {uploadPhase !== "cleaning" && (
            <div className="upload-activity-steps" aria-hidden="true">
              <span className={uploadPhase === "preparing" ? "is-current" : "is-complete"}>Prepare</span>
              <span className={uploadPhase === "transferring" ? "is-current" : uploadPhase === "verifying" ? "is-complete" : ""}>Transfer</span>
              <span className={uploadPhase === "verifying" ? "is-current" : ""}>Verify</span>
            </div>
          )}
        </div>
      )}
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      {success && <p className="success-message" role="status">{success}</p>}
      <button
        className="secondary-button upload-button"
        type="submit"
        disabled={
          isUploading ||
          (!file && errorCode !== "cleanup_pending") ||
          errorCode === "invalid_upload"
        }
      >
        {isUploading
          ? errorCode === "cleanup_pending" ? "Cleaning up…" : uploadPhase === "verifying" ? "Verifying…" : "Uploading…"
          : errorCode === "cleanup_pending"
            ? "Retry cleanup"
            : errorCode === "invalid_upload"
              ? "Choose a different file"
            : jobId
              ? fileUploaded ? "Retry verification" : "Retry upload"
              : "Upload file"}
      </button>
    </form>
  );
}
