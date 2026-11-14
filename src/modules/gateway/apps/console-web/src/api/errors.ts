// Errors raised by the console's API client. Every failure becomes an ApiError so
// screens can show the server's message and branch on status (for example 409).

import type { RouteRef } from "./types";

export class ApiError extends Error {
  readonly status: number;

  readonly type: string;

  readonly code: string | undefined;

  /** For a provider_in_use conflict: the routes that still target the provider. */
  readonly routes: RouteRef[] | undefined;

  constructor(status: number, type: string, message: string, code?: string, routes?: RouteRef[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.routes = routes;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}

const MAX_MESSAGE_LENGTH = 400;

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

function typeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 404:
      return "not_found_error";
    case 409:
      return "conflict_error";
    case 502:
      return "upstream_error";
    case 504:
      return "timeout_error";
    default:
      return "server_error";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Accepts `{ "error": { message, type, code } }`, `{ "error": "text" }`, a plain
// text body, or nothing at all, and always returns an ApiError.
function isRouteRef(value: unknown): value is RouteRef {
  return isRecord(value) && typeof value.id === "string" && typeof value.alias === "string";
}

export function errorFromResponse(status: number, body: unknown): ApiError {
  const fallbackType = typeForStatus(status);
  if (typeof body === "string" && body.trim().length > 0) {
    return new ApiError(status, fallbackType, truncate(body.trim()));
  }
  if (isRecord(body) && "error" in body) {
    const detail = body.error;
    if (typeof detail === "string" && detail.trim().length > 0) {
      return new ApiError(status, fallbackType, truncate(detail.trim()));
    }
    if (isRecord(detail) && typeof detail.message === "string") {
      const type = typeof detail.type === "string" ? detail.type : fallbackType;
      const code = typeof detail.code === "string" ? detail.code : undefined;
      const routes = Array.isArray(detail.routes) ? (detail.routes as unknown[]).filter(isRouteRef) : undefined;
      return new ApiError(status, type, truncate(detail.message), code, routes);
    }
  }
  return new ApiError(status, fallbackType, `The gateway answered with status ${status}.`);
}

export function networkError(): ApiError {
  return new ApiError(0, "network_error", "Can't reach the gateway. Check that it is running at this address, then try again.");
}
