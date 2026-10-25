import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { AuthProvider } from "../features/auth/context/AuthContext.js";
import { AppRoutes } from "../app/App.js";

export function renderApp(initialEntry = "/") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>
  );
}

export function renderInRouter(children: ReactNode, initialEntry = "/") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>{children}</AuthProvider>
    </MemoryRouter>
  );
}

export function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

export function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    return (await implementation(input, init)) as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
