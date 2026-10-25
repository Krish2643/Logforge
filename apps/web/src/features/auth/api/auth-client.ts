import {
  authSessionResponseSchema,
  userResponseSchema,
  type AuthSessionResponse,
  type UserResponse
} from "@logforge/shared";
import { apiRequest } from "../../../lib/api-client.js";

export async function login(email: string, password: string): Promise<AuthSessionResponse> {
  const response = await apiRequest<unknown>("/auth/login", {
    method: "POST",
    body: { email, password },
    authenticated: false
  });
  return authSessionResponseSchema.parse(response);
}

export async function register(email: string, password: string): Promise<AuthSessionResponse> {
  const response = await apiRequest<unknown>("/auth/register", {
    method: "POST",
    body: { email, password },
    authenticated: false
  });
  return authSessionResponseSchema.parse(response);
}

export async function getCurrentUser(): Promise<UserResponse> {
  const response = await apiRequest<{ user: unknown }>("/auth/me");
  return userResponseSchema.parse(response.user);
}

export function logout(): Promise<void> {
  return apiRequest<void>("/auth/logout", { method: "POST" });
}
