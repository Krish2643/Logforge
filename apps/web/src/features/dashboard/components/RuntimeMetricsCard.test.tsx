import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse, mockFetch, renderInRouter } from "../../../test/render-app.js";
import { RuntimeMetricsCard } from "./RuntimeMetricsCard.js";

const apiMetrics = {
  rssBytes: 100 * 1024 * 1024,
  heapUsedBytes: 40 * 1024 * 1024,
  externalBytes: 5 * 1024 * 1024,
  arrayBuffersBytes: 2 * 1024 * 1024,
  sampledAt: "2026-10-24T00:00:00.000Z",
  uptimeSeconds: 120
};
const workerMetrics = {
  ...apiMetrics,
  rssBytes: 180 * 1024 * 1024,
  heapUsedBytes: 70 * 1024 * 1024,
  activeJobIds: ["30000000-0000-4000-8000-000000000001"],
  peakRssBytesDuringProcessing: 190 * 1024 * 1024,
  peakHeapUsedBytesDuringProcessing: 75 * 1024 * 1024,
  peakWindowEndedAt: null
};

beforeEach(() => {
  window.sessionStorage.setItem("logforge.session-token", "b".repeat(43));
});

describe("runtime metrics card", () => {
  it("shows API/worker RSS and sampled peak memory from the metrics endpoint", async () => {
    mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") {
        return jsonResponse({
          user: {
            id: "10000000-0000-4000-8000-000000000001",
            email: "ada@example.test",
            createdAt: "2026-10-20T00:00:00.000Z"
          }
        });
      }
      return jsonResponse({ api: apiMetrics, workerStatus: "available", worker: workerMetrics });
    });
    renderInRouter(<RuntimeMetricsCard />);

    expect(await screen.findByText("100.0 MiB")).toBeInTheDocument();
    expect(screen.getByText("180.0 MiB")).toBeInTheDocument();
    expect(screen.getByText("190.0 MiB RSS")).toBeInTheDocument();
    expect(screen.getByText("Processing 1 job(s)")).toBeInTheDocument();
    expect(screen.getByText(/Session sampled peak/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Worker peaks are sampled every second/)).toBeInTheDocument());
  });

  it("clearly reports when the worker has not published a snapshot", async () => {
    mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") {
        return jsonResponse({
          user: {
            id: "10000000-0000-4000-8000-000000000001",
            email: "ada@example.test",
            createdAt: "2026-10-20T00:00:00.000Z"
          }
        });
      }
      return jsonResponse({ api: apiMetrics, workerStatus: "not_reported", worker: null });
    });
    renderInRouter(<RuntimeMetricsCard />);

    expect(await screen.findByText("Worker not reporting")).toBeInTheDocument();
  });
});
