import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { IngestionJobResponse, ProjectResponse } from "@logforge/shared";
import { jsonResponse, mockFetch, renderInRouter } from "../../../test/render-app.js";
import { ProjectJobs } from "./ProjectJobs.js";

const project: ProjectResponse = {
  id: "20000000-0000-4000-8000-000000000001",
  name: "Production API",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z"
};
const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "ada@example.test",
  createdAt: "2026-10-20T00:00:00.000Z"
};
const persistedJob: IngestionJobResponse = {
  id: "30000000-0000-4000-8000-000000000001",
  projectId: project.id,
  status: "uploaded",
  processingAttempt: 0,
  originalFilename: "logforge_dummy_10mb.log",
  fileSizeBytes: 10_485_784,
  contentType: "text/plain",
  uploadCompletedAt: "2026-10-22T15:11:28.860Z",
  cleanupPending: false,
  bytesProcessed: 0,
  linesProcessed: 0,
  eventsPersisted: 0,
  malformedLines: 0,
  failureReason: null,
  cancelRequestedAt: null,
  processingStartedAt: null,
  processingCompletedAt: null,
  createdAt: "2026-10-22T15:11:26.489Z",
  updatedAt: "2026-10-22T15:11:28.860Z"
};

beforeEach(() => {
  window.sessionStorage.setItem("logforge.session-token", "b".repeat(43));
});

describe("project ingestion jobs", () => {
  it("loads persisted filenames, sizes, upload date, actual status, and project link", async () => {
    const fetchMock = mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (String(input) === `/api/projects/${project.id}/jobs`) {
        return jsonResponse({ jobs: [persistedJob], nextCursor: null });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    expect(await screen.findByText("logforge_dummy_10mb.log")).toBeInTheDocument();
    expect(screen.getByText("10.49 MB")).toBeInTheDocument();
    expect(screen.getByText("Uploaded · ready for processing")).toBeInTheDocument();
    expect(document.querySelector(".ingestion-job-meta")?.textContent).toContain("Uploaded");
    expect(document.querySelector(".job-status")?.textContent).not.toBe("Processed");
    expect(fetchMock.mock.calls.some(([url]) => url === `/api/projects/${project.id}/jobs`)).toBe(true);
  });

  it("displays persisted processing progress instead of treating an upload as processed", async () => {
    const processingJob: IngestionJobResponse = {
      ...persistedJob,
      status: "processing",
      bytesProcessed: 5_000_000,
      linesProcessed: 120,
      eventsPersisted: 100,
      malformedLines: 2,
      processingStartedAt: new Date(Date.now() - 4_000).toISOString()
    };
    mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({ jobs: [processingJob], nextCursor: null });
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    expect(await screen.findByText("Processing", { selector: ".job-status" })).toBeInTheDocument();
    expect(document.querySelector(".ingestion-job-meta")?.textContent).toContain(
      `Processed ${(5_000_000).toLocaleString()} of ${(10_485_784).toLocaleString()} bytes`
    );
    expect(screen.getByText(/100 stored events · 2 malformed/)).toBeInTheDocument();
    expect(screen.getByText(/Processing duration/)).toBeInTheDocument();
    expect(document.querySelector(".job-status")?.textContent).not.toBe("Processed");
    expect(screen.getByText("Reading and indexing log events.")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Processing progress by bytes read" })).toHaveAttribute(
      "aria-valuenow",
      "5000000"
    );
    expect(screen.getByLabelText("Ingestion progress: Processing")).toBeInTheDocument();
  });

  it("cancels queued jobs and reports cancellation while retaining persisted events", async () => {
    const queuedJob: IngestionJobResponse = { ...persistedJob, status: "queued" };
    const cancelledJob: IngestionJobResponse = { ...queuedJob, status: "cancelled" };
    mockFetch(async (input, init) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (String(input) === `/api/projects/${project.id}/jobs`) {
        return jsonResponse({ jobs: [queuedJob], nextCursor: null });
      }
      if (String(input) === `/api/jobs/${queuedJob.id}/cancel` && init?.method === "POST") {
        return jsonResponse({ job: cancelledJob });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel processing" }));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText(/persisted events were retained/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel processing" })).not.toBeInTheDocument();
  });

  it("shows cancellation errors and leaves retry available", async () => {
    const queuedJob: IngestionJobResponse = { ...persistedJob, status: "queued" };
    let failCancellation = true;
    mockFetch(async (input, init) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (String(input) === `/api/projects/${project.id}/jobs`) {
        return jsonResponse({ jobs: [queuedJob], nextCursor: null });
      }
      if (String(input) === `/api/jobs/${queuedJob.id}/cancel` && init?.method === "POST") {
        if (failCancellation) {
          return jsonResponse({ error: { message: "Cancellation unavailable" } }, 503);
        }
        return jsonResponse({ job: { ...queuedJob, status: "cancelled" } });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel processing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cancellation unavailable");
    failCancellation = false;
    fireEvent.click(screen.getByRole("button", { name: "Cancel processing" }));
    expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  });

  it("shows cancellation as pending for active jobs", async () => {
    const processingJob: IngestionJobResponse = {
      ...persistedJob,
      status: "processing",
      cancelRequestedAt: "2026-10-22T15:12:00.000Z"
    };
    mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({ jobs: [processingJob], nextCursor: null });
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    expect(await screen.findByText("Cancellation requested")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
  });

  it("does not offer cancellation for completed jobs", async () => {
    const completed: IngestionJobResponse = {
      ...persistedJob,
      status: "completed",
      processingStartedAt: "2026-10-22T15:12:00.000Z",
      processingCompletedAt: "2026-10-22T15:12:12.500Z"
    };
    mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({ jobs: [completed], nextCursor: null });
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    expect(await screen.findByText("Processed", { selector: ".job-status" })).toBeInTheDocument();
    expect(screen.getByText("All available log events have been processed.")).toBeInTheDocument();
    expect(screen.getByText("Processing duration 12.50s")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel processing/i })).not.toBeInTheDocument();
  });

  it("shows an animated waiting stage for queued jobs without inventing a percentage", async () => {
    const queuedJob: IngestionJobResponse = { ...persistedJob, status: "queued" };
    mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({ jobs: [queuedJob], nextCursor: null });
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    expect(await screen.findByText("Your file is verified and waiting for a worker.")).toBeInTheDocument();
    expect(screen.getByLabelText("Ingestion progress: Queued")).toBeInTheDocument();
    expect(screen.getByText("Queued", { selector: ".processing-step--current span:last-child" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Processing progress by bytes read" })).not.toBeInTheDocument();
    expect(document.querySelector(".activity-progress-track--indeterminate")).toBeInTheDocument();
  });

  it("retries failed and cancelled jobs, shows loading, refreshes state, and reports errors", async () => {
    const cancelled: IngestionJobResponse = { ...persistedJob, status: "cancelled" };
    const queued: IngestionJobResponse = {
      ...cancelled,
      status: "queued",
      processingAttempt: 1,
      cancelRequestedAt: null
    };
    let listCount = 0;
    let retryResolve: ((response: Response) => void) | undefined;
    let failRetry = true;
    const fetchMock = mockFetch((input, init) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(jsonResponse({ user }) as Response);
      if (url === `/api/projects/${project.id}/jobs`) {
        listCount += 1;
        return Promise.resolve(jsonResponse({
          jobs: [listCount === 1 ? cancelled : queued],
          nextCursor: null
        }) as Response);
      }
      if (url === `/api/jobs/${cancelled.id}/retry` && init?.method === "POST") {
        if (failRetry) {
          return Promise.resolve(
            jsonResponse({ error: { message: "Original file is unavailable" } }, 409) as Response
          );
        }
        return new Promise<Response>((resolve) => { retryResolve = resolve; });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry processing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Original file is unavailable");
    failRetry = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry processing" }));
    expect(await screen.findByRole("button", { name: "Retrying…" })).toBeDisabled();
    retryResolve?.(jsonResponse({ job: queued }) as Response);

    expect(await screen.findByText("Queued")).toBeInTheDocument();
    await waitFor(() => expect(listCount).toBe(2));
    expect(fetchMock.mock.calls.some(([url]) => url === `/api/jobs/${cancelled.id}/retry`)).toBe(true);
  });

  it("offers Retry processing for failed jobs", async () => {
    const failed: IngestionJobResponse = {
      ...persistedJob,
      status: "failed",
      failureReason: "Temporary storage error"
    };
    mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({ jobs: [failed], nextCursor: null });
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Temporary storage error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry processing" })).toBeInTheDocument();
  });

  it("shows an empty state for a project without jobs", async () => {
    mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({ jobs: [], nextCursor: null });
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    expect(await screen.findByText("No ingestion jobs yet.")).toBeInTheDocument();
  });

  it("shows loading and retry states when the API fails", async () => {
    let shouldFail = true;
    const fetchMock = mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (shouldFail) {
        return jsonResponse({ error: { message: "Job list unavailable" } }, 503);
      }
      return jsonResponse({ jobs: [persistedJob], nextCursor: null });
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Job list unavailable");
    shouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("logforge_dummy_10mb.log")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === `/api/projects/${project.id}/jobs`)).toHaveLength(2);
  });

  it("announces loading while the job request is pending", async () => {
    let resolveJobs: ((response: Response) => void) | undefined;
    mockFetch((input) => {
      if (String(input) === "/api/auth/me") {
        return Promise.resolve(jsonResponse({ user }) as Response);
      }
      return new Promise<Response>((resolve) => {
        resolveJobs = resolve;
      });
    });
    renderInRouter(<ProjectJobs project={project} refreshKey={0} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading jobs");
    resolveJobs?.(jsonResponse({ jobs: [], nextCursor: null }) as Response);
    expect(await screen.findByText("No ingestion jobs yet.")).toBeInTheDocument();
  });

  it("reloads persisted jobs when the view is refreshed after upload", async () => {
    let listRequests = 0;
    mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (String(input) === `/api/projects/${project.id}/jobs`) {
        listRequests += 1;
        return jsonResponse({
          jobs: listRequests === 1 ? [] : [persistedJob],
          nextCursor: null
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    function RefreshHarness() {
      const [refreshKey, setRefreshKey] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setRefreshKey((current) => current + 1)}>
            Refresh job list
          </button>
          <ProjectJobs project={project} refreshKey={refreshKey} />
        </>
      );
    }
    renderInRouter(<RefreshHarness />);
    expect(await screen.findByText("No ingestion jobs yet.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh job list" }));
    expect(await screen.findByText("logforge_dummy_10mb.log")).toBeInTheDocument();
    await waitFor(() => expect(listRequests).toBe(2));
  });
});
