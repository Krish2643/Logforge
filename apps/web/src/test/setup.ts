import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { setBearerToken, setUnauthorizedHandler } from "../lib/api-client.js";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  setBearerToken(null);
  setUnauthorizedHandler(null);
});
