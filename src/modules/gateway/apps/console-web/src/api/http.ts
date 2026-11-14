// The real API client. Same-origin only: admin calls go to /admin/api with the
// session's bearer token; the public model list is called without credentials.

import type { ConsoleApi } from "./console-api";
import { ApiError, errorFromResponse, isAbortError, networkError } from "./errors";
import type {
  ClientKey,
  CreatedClientKey,
  DecisionRequest,
  Health,
  LogPage,
  LogQuery,
  PlaygroundRun,
  Provider,
  ProviderModel,
  ProviderPatch,
  ProviderTestResult,
  ProviderWrite,
  Route,
  RouteWrite,
  Settings,
  Stats,
  StatsWindow,
} from "./types";

export interface HttpApiOptions {
  /** The session's admin token, or null when signed out. */
  getToken: () => string | null;
  /** Called when an admin request is refused as unauthenticated. */
  onUnauthorized: () => void;
  /** Replaceable in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

interface CallSpec {
  method: Method;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  auth: "admin" | "public";
  /** Token for this call only (sign-in). A 401 then does not end the session. */
  tokenOverride?: string;
  signal?: AbortSignal;
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

function queryString(query: Record<string, string | number | undefined> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text.length > 0 ? `?${text}` : "";
}

function parseBody(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createHttpApi(options: HttpApiOptions): ConsoleApi {
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;

  async function call<T>(spec: CallSpec): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (spec.auth === "admin") {
      const token = spec.tokenOverride ?? options.getToken();
      if (!token) {
        options.onUnauthorized();
        throw new ApiError(401, "authentication_error", "Sign in with the admin token to continue.");
      }
      headers.Authorization = `Bearer ${token}`;
    }
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";

    const url = `${spec.path}${queryString(spec.query)}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: spec.signal,
      });
    } catch (cause) {
      if (isAbortError(cause)) throw cause;
      throw networkError();
    }

    let body: unknown;
    try {
      body = parseBody(await response.text());
    } catch (cause) {
      if (isAbortError(cause)) throw cause;
      throw networkError();
    }

    if (response.status === 401 && spec.auth === "admin" && spec.tokenOverride === undefined) {
      options.onUnauthorized();
    }
    if (!response.ok) throw errorFromResponse(response.status, body);
    if (typeof body === "string") {
      // A 2xx with text instead of JSON usually means the address points at something
      // other than the gateway, such as a proxy page. Fail loudly instead of guessing.
      throw new ApiError(
        response.status,
        "server_error",
        `Expected JSON from ${spec.path}, but the response was text. Check that this address is the gateway.`,
      );
    }
    return body as T;
  }

  const admin = <T>(method: Method, path: string, extra: Partial<CallSpec> = {}): Promise<T> =>
    call<T>({ method, path, auth: "admin", ...extra });

  return {
    checkToken: (token) => call<Health>({ method: "GET", path: "/admin/api/health", auth: "admin", tokenOverride: token }),
    health: () => admin<Health>("GET", "/admin/api/health"),
    stats: (window: StatsWindow) => admin<Stats>("GET", "/admin/api/stats", { query: { window } }),

    listProviders: () => admin<Provider[]>("GET", "/admin/api/providers"),
    createProvider: (body: ProviderWrite) => admin<Provider>("POST", "/admin/api/providers", { body }),
    updateProvider: (id: string, patch: ProviderPatch) => admin<Provider>("PATCH", `/admin/api/providers/${encodeId(id)}`, { body: patch }),
    deleteProvider: async (id: string) => {
      await admin<unknown>("DELETE", `/admin/api/providers/${encodeId(id)}`);
    },
    testProvider: (id: string, model?: string) =>
      admin<ProviderTestResult>("POST", `/admin/api/providers/${encodeId(id)}/test`, { body: model ? { model } : {} }),
    listProviderModels: async (id: string) => {
      const result = await admin<{ models: ProviderModel[] }>("GET", `/admin/api/providers/${encodeId(id)}/models`);
      return result.models;
    },

    listRoutes: () => admin<Route[]>("GET", "/admin/api/routes"),
    createRoute: (body: RouteWrite) => admin<Route>("POST", "/admin/api/routes", { body }),
    updateRoute: (id: string, patch: Partial<RouteWrite>) => admin<Route>("PATCH", `/admin/api/routes/${encodeId(id)}`, { body: patch }),
    deleteRoute: async (id: string) => {
      await admin<unknown>("DELETE", `/admin/api/routes/${encodeId(id)}`);
    },

    listLogs: (query: LogQuery) =>
      admin<LogPage>("GET", "/admin/api/logs", {
        query: {
          limit: query.limit,
          before: query.before,
          route: query.route,
          provider: query.provider,
          status: query.status,
          fallback: query.fallback,
        },
      }),

    getSettings: () => admin<Settings>("GET", "/admin/api/settings"),
    updateSettings: (patch: Partial<Settings>) => admin<Settings>("PATCH", "/admin/api/settings", { body: patch }),

    listClients: () => admin<ClientKey[]>("GET", "/admin/api/clients"),
    createClient: (name: string) => admin<CreatedClientKey>("POST", "/admin/api/clients", { body: { name } }),
    deleteClient: async (id: string) => {
      await admin<unknown>("DELETE", `/admin/api/clients/${encodeId(id)}`);
    },

    runPlayground: (request: DecisionRequest) => admin<PlaygroundRun>("POST", "/admin/api/playground", { body: { request } }),
  };
}
