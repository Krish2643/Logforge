import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp, jsonResponse, mockFetch } from "../../../test/render-app.js";

const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "ada@example.test",
  createdAt: "2026-10-20T00:00:00.000Z"
};

const session = {
  user,
  accessToken: "a".repeat(43),
  tokenType: "Bearer",
  expiresAt: "2026-10-27T00:00:00.000Z"
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

describe("browser authentication", () => {
  it("sends unauthenticated users to login instead of rendering protected pages", async () => {
    renderApp("/projects");

    expect(await screen.findByRole("heading", { name: "Sign in to LogForge" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Projects" })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores a session through /me before showing the protected dashboard", async () => {
    window.sessionStorage.setItem("logforge.session-token", session.accessToken);
    mockFetch(async (input) => {
      expect(String(input)).toBe("/api/auth/me");
      return jsonResponse({ user });
    });

    renderApp("/dashboard");

    expect(screen.getByRole("status")).toHaveTextContent("Restoring your session");
    expect(await screen.findByRole("heading", { name: "Welcome, ada." })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({
      headers: expect.any(Headers)
    }));
  });

  it("signs in and navigates to the dashboard", async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input) === "/api/auth/login") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).not.toHaveProperty("Authorization");
        expect(JSON.parse(String(init?.body))).toEqual({
          email: "ada@example.test",
          password: "correct horse battery staple"
        });
        return jsonResponse(session);
      }
      if (String(input) === "/api/health") {
        return jsonResponse({
          status: "ok",
          checkedAt: "2026-10-20T00:00:00.000Z",
          dependencies: { database: "connected" }
        });
      }
      if (String(input) === "/api/metrics/runtime") {
        return jsonResponse({
          api: {
            rssBytes: 100 * 1024 * 1024,
            heapUsedBytes: 40 * 1024 * 1024,
            externalBytes: 5 * 1024 * 1024,
            arrayBuffersBytes: 2 * 1024 * 1024,
            sampledAt: "2026-10-20T00:00:00.000Z",
            uptimeSeconds: 120
          },
          workerStatus: "not_reported",
          worker: null
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    renderApp("/login");
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "ada@example.test" }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse battery staple" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Welcome, ada." })).toBeInTheDocument();
    expect(await screen.findByText("Database connected")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("logforge.session-token")).toBe(session.accessToken);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shows invalid credentials without storing a token", async () => {
    mockFetch(async () =>
      jsonResponse(
        { error: { code: "invalid_credentials", message: "Email or password is incorrect" } },
        401
      )
    );

    renderApp("/login");
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "ada@example.test" }
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect");
    expect(window.sessionStorage.getItem("logforge.session-token")).toBeNull();
  });

  it("validates registration fields and registers through the public endpoint", async () => {
    const fetchMock = mockFetch(async (input) => {
      expect(String(input)).toBe("/api/auth/register");
      return jsonResponse(session, 201);
    });

    renderApp("/register");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Invalid email")).toBeInTheDocument();
    expect(screen.getByText("String must contain at least 12 character(s)")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "ADA@example.test" }
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse battery staple" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByRole("heading", { name: "Welcome, ada." })).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      email: "ada@example.test",
      password: "correct horse battery staple"
    });
  });

  it("clears the token and redirects after logout, even if revocation cannot be confirmed", async () => {
    window.sessionStorage.setItem("logforge.session-token", session.accessToken);
    mockFetch(async (input, init) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (String(input) === "/api/auth/logout") {
        expect(init?.method).toBe("POST");
        return jsonResponse({ error: { message: "Database unavailable" } }, 503);
      }
      if (String(input) === "/api/auth/login") {
        return jsonResponse({ error: { message: "Invalid credentials" } }, 401);
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    renderApp("/dashboard");
    expect(await screen.findByRole("heading", { name: "Welcome, ada." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("heading", { name: "Sign in to LogForge" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("signed out locally");
    expect(window.sessionStorage.getItem("logforge.session-token")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Welcome, ada." })).not.toBeInTheDocument());
  });

  it("clears an expired token and redirects to login", async () => {
    window.sessionStorage.setItem("logforge.session-token", session.accessToken);
    mockFetch(async () =>
      jsonResponse(
        { error: { code: "invalid_session", message: "The session is invalid or expired" } },
        401
      )
    );

    renderApp("/projects");

    expect(await screen.findByRole("heading", { name: "Sign in to LogForge" })).toBeInTheDocument();
    expect(window.sessionStorage.getItem("logforge.session-token")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Projects" })).not.toBeInTheDocument();
  });
});
