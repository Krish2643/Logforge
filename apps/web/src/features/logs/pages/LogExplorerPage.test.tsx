import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { jsonResponse, mockFetch, renderApp } from "../../../test/render-app.js";

const projectId = "20000000-0000-4000-8000-000000000001";
const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "ada@example.test",
  createdAt: "2026-10-20T00:00:00.000Z"
};
const firstEvent = {
  id: "40000000-0000-4000-8000-000000000001",
  timestamp: "2026-10-22T12:00:00.000Z",
  level: "error",
  message: "Database connection failed",
  source: "payments-api",
  ingestionJobId: "30000000-0000-4000-8000-000000000001",
  attributes: { request_id: "req-500", status: 500, latency_ms: 82 }
};

beforeEach(() => {
  window.sessionStorage.setItem("logforge.session-token", "b".repeat(43));
});

describe("Log Explorer", () => {
  it("renders persisted event details and submits message, service, and severity filters", async () => {
    const fetchMock = mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({ logs: [firstEvent], nextCursor: null, databaseQueryDurationMs: 4.27 });
    });
    renderApp(`/projects/${projectId}/logs`);

    expect((await screen.findAllByText("Database connection failed")).length).toBeGreaterThan(0);
    expect(screen.getByText("payments-api")).toBeInTheDocument();
    expect(screen.getByText("req-500")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(screen.getByText("82")).toBeInTheDocument();
    expect(screen.getByText("Database round trip 4.270 ms")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search messages and services"), {
      target: { value: "database down" }
    });
    fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "error" } });
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "payments-api" } });
    fireEvent.click(screen.getByRole("button", { name: "Search logs" }));

    await waitFor(() => {
      const requestUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(requestUrl).toContain("q=database+down");
      expect(requestUrl).toContain("level=error");
      expect(requestUrl).toContain("service=payments-api");
    });
  });

  it("rejects an invalid time range before sending another request", async () => {
    const fetchMock = mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({ logs: [], nextCursor: null, databaseQueryDurationMs: 1.5 });
    });
    renderApp(`/projects/${projectId}/logs`);
    await screen.findByText("No matching events");
    const searchCallsBefore = fetchMock.mock.calls.filter(([url]) => String(url).includes("/logs?")).length;

    fireEvent.change(screen.getByLabelText("From (local time)"), {
      target: { value: "2026-10-23T12:00" }
    });
    fireEvent.change(screen.getByLabelText("To (local time)"), {
      target: { value: "2026-10-22T12:00" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Search logs" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Start time must be earlier");
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/logs?"))).toHaveLength(searchCallsBefore);
  });

  it("paginates with the server cursor and provides loading, error, and retry states", async () => {
    let failed = true;
    const fetchMock = mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (failed) return jsonResponse({ error: { message: "Search temporarily unavailable" } }, 503);
      if (String(input).includes("cursor=")) {
        return jsonResponse({ logs: [{ ...firstEvent, id: "40000000-0000-4000-8000-000000000002" }], nextCursor: null, databaseQueryDurationMs: 3 });
      }
      return jsonResponse({ logs: [firstEvent], nextCursor: "40000000-0000-4000-8000-000000000001", databaseQueryDurationMs: 3 });
    });
    renderApp(`/projects/${projectId}/logs`);

    expect(await screen.findByRole("alert")).toHaveTextContent("Search temporarily unavailable");
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect((await screen.findAllByText("Database connection failed")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("cursor="));
    expect(await screen.findByText("Page 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Page 1")).toBeInTheDocument();
  });

  it("clears filters and returns to the first page", async () => {
    const fetchMock = mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({ logs: [], nextCursor: null, databaseQueryDurationMs: 1 });
    });
    renderApp(`/projects/${projectId}/logs`);
    await screen.findByText("No matching events");
    fireEvent.change(screen.getByLabelText("Search messages and services"), {
      target: { value: "timeout" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    await waitFor(() => {
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(`/api/projects/${projectId}/logs?limit=50`);
    });
    expect(screen.getByLabelText("Search messages and services")).toHaveValue("");
  });
});
