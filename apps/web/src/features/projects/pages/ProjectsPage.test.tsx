import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp, jsonResponse, mockFetch } from "../../../test/render-app.js";

const user = {
  id: "10000000-0000-4000-8000-000000000001",
  email: "ada@example.test",
  createdAt: "2026-10-20T00:00:00.000Z"
};
const token = "b".repeat(43);
const limits = {
  minimumFileSizeBytes: 10_000_000,
  maximumFileSizeBytes: 100_000_000,
  supportedExtensions: [".log", ".jsonl"]
};

function project(id: string, name: string) {
  return {
    id,
    name,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z"
  };
}

beforeEach(() => {
  window.sessionStorage.setItem("logforge.session-token", token);
});

function authenticatedFetch(projectsResponse: unknown) {
  return mockFetch(async (input) => {
    if (String(input) === "/api/auth/me") return jsonResponse({ user });
    if (String(input) === "/api/uploads/limits") return jsonResponse(limits);
    if (String(input) === "/api/projects") return jsonResponse(projectsResponse);
    if (String(input).match(/^\/api\/projects\/[^/]+\/jobs/)) {
      return jsonResponse({ jobs: [], nextCursor: null });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  });
}

describe("projects page", () => {
  it("lists the signed-in user's projects", async () => {
    authenticatedFetch({ projects: [project("20000000-0000-4000-8000-000000000001", "API")] });
    renderApp("/projects");

    expect(await screen.findByText("API")).toBeInTheDocument();
    expect(screen.getByText(/Created/).textContent).toMatch(/20\/10\/2026|10\/20\/2026/);
    expect(screen.getByRole("heading", { name: "Your projects" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Explore logs" })).toHaveAttribute(
      "href",
      "/projects/20000000-0000-4000-8000-000000000001/logs"
    );
  });

  it("puts the newest project first and lets projects expand and collapse", async () => {
    const older = {
      ...project("20000000-0000-4000-8000-000000000001", "Older API"),
      createdAt: "2026-10-20T00:00:00.000Z"
    };
    const newer = {
      ...project("20000000-0000-4000-8000-000000000002", "Newest API"),
      createdAt: "2026-10-22T00:00:00.000Z"
    };
    authenticatedFetch({ projects: [older, newer] });
    renderApp("/projects");

    const newestHeading = await screen.findByText("Newest API");
    const projectItems = document.querySelectorAll(".project-list-item");
    expect(projectItems[0]).toContainElement(newestHeading);
    expect(projectItems[1]).toHaveTextContent("Older API");

    const newestExpand = screen.getByRole("button", { name: "Collapse" });
    expect(newestExpand).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(`project-details-${newer.id}`)).not.toHaveAttribute("hidden");
    fireEvent.click(newestExpand);
    expect(within(projectItems[0] as HTMLElement).getByRole("button", { name: "Expand" }))
      .toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(`project-details-${newer.id}`)).toHaveAttribute("hidden");

    fireEvent.click(within(projectItems[1] as HTMLElement).getByRole("button", { name: "Expand" }));
    expect(document.getElementById(`project-details-${older.id}`)).not.toHaveAttribute("hidden");
  });

  it("shows an empty state when the project list is empty", async () => {
    authenticatedFetch({ projects: [] });
    renderApp("/projects");

    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
    expect(screen.getByText(/Create your first project/)).toBeInTheDocument();
  });

  it("shows a retry action when loading projects fails", async () => {
    const fetchMock = mockFetch(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      return jsonResponse({ error: { message: "Projects could not be loaded" } }, 503);
    });
    renderApp("/projects");

    expect(await screen.findByRole("alert")).toHaveTextContent("Projects could not be loaded");
    fetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user }) as Response;
      if (String(input) === "/api/uploads/limits") return jsonResponse(limits) as Response;
      if (String(input).match(/^\/api\/projects\/[^/]+\/jobs/)) {
        return jsonResponse({ jobs: [], nextCursor: null }) as Response;
      }
      return jsonResponse({ projects: [] }) as Response;
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
  });

  it("creates a project and reloads the authorized list", async () => {
    const created = project("20000000-0000-4000-8000-000000000001", "Payments API");
    let listCalls = 0;
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (String(input) === "/api/uploads/limits") return jsonResponse(limits);
      if (String(input).match(/^\/api\/projects\/[^/]+\/jobs/)) {
        return jsonResponse({ jobs: [], nextCursor: null });
      }
      if (String(input) === "/api/projects" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ name: "Payments API" });
        return jsonResponse({ project: created }, 201);
      }
      if (String(input) === "/api/projects") {
        listCalls += 1;
        return jsonResponse({ projects: listCalls === 1 ? [] : [created] });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    renderApp("/projects");

    await screen.findByRole("heading", { name: "No projects yet" });
    fireEvent.change(screen.getByLabelText("Project name"), {
      target: { value: "  Payments API  " }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByText("Payments API")).toBeInTheDocument();
    expect(screen.getByText("Project “Payments API” created.")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter((call) => call[0] === "/api/projects" && call[1]?.method === "GET")
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter((call) => call[0] === "/api/projects" && call[1]?.method === "POST")
    ).toHaveLength(1);
  });

  it("validates empty names and prevents duplicate submissions", async () => {
    let resolveCreate: ((value: Response) => void) | undefined;
    const fetchMock = mockFetch((input, init) => {
      if (String(input) === "/api/auth/me") {
        return Promise.resolve(jsonResponse({ user }) as Response);
      }
      if (String(input) === "/api/uploads/limits") {
        return Promise.resolve(jsonResponse(limits) as Response);
      }
      if (String(input).match(/^\/api\/projects\/[^/]+\/jobs/)) {
        return Promise.resolve(jsonResponse({ jobs: [], nextCursor: null }) as Response);
      }
      if (String(input) === "/api/projects" && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      }
      return Promise.resolve(jsonResponse({ projects: [] }) as Response);
    });
    renderApp("/projects");

    await screen.findByRole("heading", { name: "No projects yet" });
    const createButton = screen.getByRole("button", { name: "Create project" });
    fireEvent.click(createButton);
    expect(screen.getByText("Enter a project name.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/projects" && call[1]?.method === "POST")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New API" } });
    fireEvent.click(createButton);
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Creating…" }));
    expect(fetchMock.mock.calls.filter((call) => call[0] === "/api/projects" && call[1]?.method === "POST")).toHaveLength(1);

    resolveCreate?.(
      jsonResponse(
        project("20000000-0000-4000-8000-000000000002", "New API"),
        201
      ) as Response
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled());
  });

  it("shows server-side duplicate-name conflicts next to the name field", async () => {
    mockFetch(async (input, init) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (String(input) === "/api/uploads/limits") return jsonResponse(limits);
      if (String(input).match(/^\/api\/projects\/[^/]+\/jobs/)) {
        return jsonResponse({ jobs: [], nextCursor: null });
      }
      if (String(input) === "/api/projects" && init?.method === "POST") {
        return jsonResponse(
          { error: { code: "resource_conflict", message: "A record with those values already exists" } },
          409
        );
      }
      return jsonResponse({ projects: [] });
    });
    renderApp("/projects");

    await screen.findByRole("heading", { name: "No projects yet" });
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Existing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByText("You already have a project with this name.")).toBeInTheDocument();
  });
});
