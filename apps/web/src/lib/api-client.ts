type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    details?: Array<{ path: string; message: string }>;
    requestId?: string;
  };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly details: Array<{ path: string; message: string }> = [],
    readonly requestId?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/+$/, "");
let bearerToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setBearerToken(token: string | null): void {
  bearerToken = token;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    authenticated?: boolean;
    acceptedStatuses?: number[];
  } = {}
): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  if (options.authenticated !== false && bearerToken) {
    headers.set("Authorization", `Bearer ${bearerToken}`);
  }

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {})
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("Could not reach the LogForge API. Check that it is running and retry.", null, "network_error");
  }

  if (response.status === 204) {
    if (!response.ok) {
      throw new ApiError("The API request failed", response.status, "http_error");
    }
    return undefined as T;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("The API returned an unreadable response", response.status, "invalid_response");
  }

  if (!response.ok && !options.acceptedStatuses?.includes(response.status)) {
    const errorBody = payload as ApiErrorBody;
    const apiError = errorBody.error;
    if (
      response.status === 401 &&
      options.authenticated !== false &&
      !path.startsWith("/auth/login") &&
      !path.startsWith("/auth/register")
    ) {
      unauthorizedHandler?.();
    }

    throw new ApiError(
      apiError?.message ?? "The API request failed",
      response.status,
      apiError?.code ?? "http_error",
      apiError?.details ?? [],
      apiError?.requestId
    );
  }

  return payload as T;
}
