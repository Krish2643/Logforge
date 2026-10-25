import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadLimitsResponse } from "@logforge/shared";
import { renderInRouter, jsonResponse, mockFetch } from "../../../test/render-app.js";
import { ProjectUpload } from "./ProjectUpload.js";
import { uploadFileWithProgress } from "../api/upload-client.js";

const project = {
  id: "20000000-0000-4000-8000-000000000001",
  name: "Production API",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z"
};
const limits: UploadLimitsResponse = {
  minimumFileSizeBytes: 10_000_000,
  maximumFileSizeBytes: 100_000_000,
  supportedExtensions: [".log", ".jsonl"]
};
const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "ada@example.test",
  createdAt: "2026-10-20T00:00:00.000Z"
};
const jobId = "30000000-0000-4000-8000-000000000001";
const date = "2026-10-20T00:00:00.000Z";

class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = [];
  static failNext = false;

  upload = {
    onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null
  };
  status = 200;
  headers: Record<string, string> = {};
  url = "";
  body: File | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    expect(method).toBe("PUT");
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: File) {
    this.body = body;
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: Math.floor(body.size / 2),
      total: body.size
    });
    if (MockXMLHttpRequest.failNext) {
      MockXMLHttpRequest.failNext = false;
      this.onerror?.();
      return;
    }
    this.status = 200;
    this.onload?.();
  }
}

function job(status: "created" | "uploaded" | "queued" | "processing" | "completed" | "failed") {
  return {
    id: jobId,
    projectId: project.id,
    status,
    processingAttempt: 0,
    originalFilename: "service.log",
    fileSizeBytes: 10_000_000,
    contentType: "text/plain",
    uploadCompletedAt: status === "uploaded" ? date : null,
    cleanupPending: false,
    bytesProcessed: 0,
    linesProcessed: 0,
    eventsPersisted: 0,
    malformedLines: 0,
    failureReason: null,
    cancelRequestedAt: null,
    processingStartedAt: null,
    processingCompletedAt: null,
    createdAt: date,
    updatedAt: date
  };
}

function uploadResponse() {
  return {
    job: job("created"),
    upload: {
      url: "https://bucket.r2.example.test/object?X-Amz-Signature=temporary",
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      expiresAt: date
    }
  };
}

function selectLargeFile(name = "service.log", size = 10_000_000) {
  const file = new File([new Uint8Array(size)], name, { type: "text/plain" });
  fireEvent.change(screen.getByLabelText("Upload log file"), { target: { files: [file] } });
}

beforeEach(() => {
  window.sessionStorage.setItem("logforge.session-token", "b".repeat(43));
  MockXMLHttpRequest.instances = [];
  MockXMLHttpRequest.failNext = false;
  vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("project file upload", () => {
  it("shows actual XHR upload progress and completes only after backend verification", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchMock = mockFetch(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url === "/api/auth/me") return jsonResponse({ user });
      if (url === `/api/projects/${project.id}/uploads`) return jsonResponse(uploadResponse(), 201);
      if (url === `/api/jobs/${jobId}/complete`) return jsonResponse({ job: job("queued") });
      if (url === `/api/jobs/${jobId}`) return jsonResponse({ job: job("processing") });
      throw new Error(`Unexpected request: ${url}`);
    });
    const onUploadComplete = vi.fn();
    renderInRouter(<ProjectUpload project={project} limits={limits} onUploadComplete={onUploadComplete} />);
    selectLargeFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    expect(await screen.findByText(/uploaded and verified/)).toBeInTheDocument();
    expect(screen.getByText(/Ingestion status: processing/)).toBeInTheDocument();
    expect(onUploadComplete).toHaveBeenCalledTimes(1);
    expect(MockXMLHttpRequest.instances[0].url).toContain("X-Amz-Signature=temporary");
    expect(MockXMLHttpRequest.instances[0].headers).toEqual({ "Content-Type": "text/plain" });
    expect(MockXMLHttpRequest.instances[0].body?.size).toBe(10_000_000);
    expect(MockXMLHttpRequest.instances[0].headers).not.toHaveProperty("Authorization");
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has("Authorization")).toBe(true);
    expect(calls.map(({ url }) => url)).toEqual([
      "/api/auth/me",
      `/api/projects/${project.id}/uploads`,
      `/api/jobs/${jobId}/complete`,
      `/api/jobs/${jobId}`
    ]);
  });

  it("reports byte-based progress from the direct XHR upload", async () => {
    const progress: number[] = [];
    const file = new File([new Uint8Array(10_000_000)], "events.jsonl");
    await uploadFileWithProgress(
      "https://bucket.r2.example.test/object",
      file,
      { "Content-Type": "application/x-ndjson" },
      (percent) => progress.push(percent)
    );

    expect(progress).toEqual([50, 100]);
    expect(MockXMLHttpRequest.instances[0].body).toBe(file);
  });

  it("shows the verification stage while waiting for the API after the file transfer", async () => {
    let resolveCompletion: ((response: Response) => void) | undefined;
    const fetchMock = mockFetch((input) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(jsonResponse({ user }) as Response);
      if (url === `/api/projects/${project.id}/uploads`) {
        return Promise.resolve(jsonResponse(uploadResponse(), 201) as Response);
      }
      if (url === `/api/jobs/${jobId}/complete`) {
        return new Promise<Response>((resolve) => { resolveCompletion = resolve; });
      }
      if (url === `/api/jobs/${jobId}`) {
        return Promise.resolve(jsonResponse({ job: job("queued") }) as Response);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderInRouter(<ProjectUpload project={project} limits={limits} onUploadComplete={vi.fn()} />);
    selectLargeFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    expect(await screen.findByText("Verifying uploaded file")).toBeInTheDocument();
    expect(screen.getByText("Verify", { selector: ".is-current" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verifying…" })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([url]) => url === `/api/jobs/${jobId}/complete`)).toBe(true);

    resolveCompletion?.(jsonResponse({ job: job("queued") }) as Response);
    expect(await screen.findByText(/uploaded and verified/)).toBeInTheDocument();
  });

  it("rejects unsupported and too-small files before creating a job", async () => {
    const fetchMock = mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderInRouter(<ProjectUpload project={project} limits={limits} onUploadComplete={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Upload log file"), {
      target: { files: [new File([], "records.csv")] }
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a .log or .jsonl file");

    selectLargeFile("tiny.log", 9_999_999);
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 10 MB");
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it("renews a failed transfer URL and prevents duplicate submissions while busy", async () => {
    MockXMLHttpRequest.failNext = true;
    let resolveInitialization: ((response: Response) => void) | undefined;
    const fetchMock = mockFetch((input, init) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(jsonResponse({ user }) as Response);
      if (url === `/api/projects/${project.id}/uploads`) {
        return new Promise<Response>((resolve) => {
          resolveInitialization = resolve;
        });
      }
      if (url === `/api/jobs/${jobId}/upload-url`) {
        return Promise.resolve(jsonResponse(uploadResponse()) as Response);
      }
      if (url === `/api/jobs/${jobId}/complete` || url === `/api/jobs/${jobId}`) {
        return Promise.resolve(jsonResponse({ job: job("uploaded") }) as Response);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderInRouter(<ProjectUpload project={project} limits={limits} onUploadComplete={vi.fn()} />);
    selectLargeFile();
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    fireEvent.click(screen.getByRole("button", { name: "Uploading…" }));
    expect(fetchMock.mock.calls.filter((call) => call[0] === `/api/projects/${project.id}/uploads`)).toHaveLength(1);

    resolveInitialization?.(jsonResponse(uploadResponse(), 201) as Response);
    expect(await screen.findByRole("alert")).toHaveTextContent("direct upload failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    await waitFor(() => expect(screen.getByText(/uploaded and verified/)).toBeInTheDocument());
    expect(fetchMock.mock.calls.filter((call) => call[0] === `/api/jobs/${jobId}/upload-url`)).toHaveLength(1);
    expect(MockXMLHttpRequest.instances).toHaveLength(2);
  });
});
