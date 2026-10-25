import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, mockFetch, renderApp } from "../../../test/render-app.js";

const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "ada@example.test",
  createdAt: "2026-10-20T00:00:00.000Z"
};

beforeEach(() => {
  window.sessionStorage.setItem("logforge.session-token", "c".repeat(43));
});

describe("DashboardPage", () => {
  it("restores the user, loads service health, and links to projects", async () => {
    const fetchMock = mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({
        status: "ok",
        checkedAt: "2026-10-20T00:00:00.000Z",
        dependencies: { database: "connected" }
      });
    });

    renderApp("/dashboard");

    expect(await screen.findByRole("heading", { name: "Welcome, ada." })).toBeInTheDocument();
    expect(await screen.findByText("Database connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open projects" })).toHaveAttribute("href", "/projects");
    expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.objectContaining({
      headers: expect.any(Headers)
    }));
  });

  it("retains the health retry behavior", async () => {
    const fetchMock = mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({
        status: "ok",
        checkedAt: "2026-10-20T00:00:00.000Z",
        dependencies: { database: "connected" }
      });
    });

    renderApp("/dashboard");
    await screen.findByText("Database connected");
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));

    expect(await screen.findByText("Database connected")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/health")).toHaveLength(2);
  });

  it("shows the database dependency state from a valid 503 health response", async () => {
    mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse(
        {
          status: "degraded",
          checkedAt: "2026-10-20T00:00:00.000Z",
          dependencies: { database: "unavailable" }
        },
        503
      );
    });

    renderApp("/dashboard");

    expect(await screen.findByText("Database unavailable")).toBeInTheDocument();
    expect(screen.getByText("The API is running, but PostgreSQL did not respond.")).toBeInTheDocument();
  });
});
