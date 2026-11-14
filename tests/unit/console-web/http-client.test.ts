import { describe, expect, test } from "bun:test";
import { createHttpApi } from "../../../src/modules/gateway/apps/console-web/src/api/http";
import { ApiError } from "../../../src/modules/gateway/apps/console-web/src/api/errors";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(respond: (call: Recorded) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Recorded = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("http api client: authentication", () => {
  test("admin calls send the session token as a bearer header", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true, version: "0.1.0", uptime_s: 12, providers: [] }));
    const api = createHttpApi({ getToken: () => "tok-123", onUnauthorized: () => {}, fetchImpl });
    await api.health();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/admin/api/health");
    expect(calls[0]?.headers.authorization).toBe("Bearer tok-123");
  });

  test("a 401 from an admin call ends the session once and throws authentication_error", async () => {
    let unauthorized = 0;
    const { fetchImpl } = fakeFetch(() => json(401, { error: { message: "bad token", type: "authentication_error" } }));
    const api = createHttpApi({ getToken: () => "stale", onUnauthorized: () => (unauthorized += 1), fetchImpl });
    const error = await api.stats("24h").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).type).toBe("authentication_error");
    expect(unauthorized).toBe(1);
  });

  test("an admin call with no token never reaches the network and signs out", async () => {
    let unauthorized = 0;
    const { fetchImpl, calls } = fakeFetch(() => json(200, {}));
    const api = createHttpApi({ getToken: () => null, onUnauthorized: () => (unauthorized += 1), fetchImpl });
    const error = await api.listProviders().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 401 });
    expect(calls).toHaveLength(0);
    expect(unauthorized).toBe(1);
  });

  test("a rejected sign-in check does not end a session that is not yet started", async () => {
    let unauthorized = 0;
    const { fetchImpl } = fakeFetch(() => json(401, { error: "Invalid admin token" }));
    const api = createHttpApi({ getToken: () => null, onUnauthorized: () => (unauthorized += 1), fetchImpl });
    const error = await api.checkToken("wrong").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 401, message: "Invalid admin token" });
    expect(unauthorized).toBe(0);
  });

  test("the model picker reads routes through the admin API with the session token", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, [{ id: "rte_1", alias: "luna", enabled: true }]));
    const api = createHttpApi({ getToken: () => "tok-123", onUnauthorized: () => {}, fetchImpl });
    const routes = await api.listRoutes();
    expect(routes.map((route) => route.alias)).toEqual(["luna"]);
    expect(calls[0]?.url).toBe("/admin/api/routes");
    expect(calls[0]?.headers.authorization).toBe("Bearer tok-123");
  });
});

describe("http api client: error parsing", () => {
  const cases: [string, Response, { status: number; type: string; message: string; code?: string }][] = [
    [
      "structured error object",
      json(409, { error: { message: "Provider is still a target", type: "conflict_error", code: "in_use" } }),
      { status: 409, type: "conflict_error", message: "Provider is still a target", code: "in_use" },
    ],
    [
      "string error",
      json(400, { error: "Alias already exists" }),
      { status: 400, type: "invalid_request_error", message: "Alias already exists" },
    ],
    [
      "plain text body",
      new Response("upstream exploded", { status: 502 }),
      { status: 502, type: "upstream_error", message: "upstream exploded" },
    ],
    ["empty body", new Response("", { status: 500 }), { status: 500, type: "server_error", message: "The gateway answered with status 500." }],
  ];

  for (const [name, response, expected] of cases) {
    test(`parses ${name}`, async () => {
      const { fetchImpl } = fakeFetch(() => response.clone());
      const api = createHttpApi({ getToken: () => "tok", onUnauthorized: () => {}, fetchImpl });
      const error = (await api.deleteProvider("prv_x").catch((caught: unknown) => caught)) as ApiError;
      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(expected.status);
      expect(error.type).toBe(expected.type);
      expect(error.message).toBe(expected.message);
      expect(error.code).toBe(expected.code);
    });
  }

  test("a refused connection becomes a network_error with status 0", async () => {
    const fetchImpl = (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    const api = createHttpApi({ getToken: () => "tok", onUnauthorized: () => {}, fetchImpl });
    const error = (await api.health().catch((caught: unknown) => caught)) as ApiError;
    expect(error.status).toBe(0);
    expect(error.type).toBe("network_error");
    expect(error.message).toContain("Can't reach the gateway");
  });

  test("an aborted request is passed through unchanged", async () => {
    const abort = new DOMException("stopped", "AbortError");
    const fetchImpl = (() => Promise.reject(abort)) as unknown as typeof fetch;
    const api = createHttpApi({ getToken: () => "tok", onUnauthorized: () => {}, fetchImpl });
    const error = await api.health().catch((caught: unknown) => caught);
    expect(error).toBe(abort);
  });
});

describe("http api client: request shapes", () => {
  test("updateRoute sends PATCH with the JSON patch", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { id: "rte_1" }));
    const api = createHttpApi({ getToken: () => "tok", onUnauthorized: () => {}, fetchImpl });
    await api.updateRoute("rte_1", { enabled: false });
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe("/admin/api/routes/rte_1");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({ enabled: false });
  });

  test("listLogs builds a query string and skips undefined filters", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { items: [], next_before: null }));
    const api = createHttpApi({ getToken: () => "tok", onUnauthorized: () => {}, fetchImpl });
    await api.listLogs({ limit: 50, before: "log_000900", status: "error", route: undefined });
    expect(calls[0]?.url).toBe("/admin/api/logs?limit=50&before=log_000900&status=error");
    await api.listLogs({ limit: 50, fallback: "none" });
    expect(calls[1]?.url).toBe("/admin/api/logs?limit=50&fallback=none");
  });

  test("a provider_in_use conflict keeps the routes it names", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(409, {
        error: {
          message: 'Provider is still a target of route "luna".',
          type: "invalid_request_error",
          code: "provider_in_use",
          routes: [{ id: "rte_1", alias: "luna" }],
        },
      }),
    );
    const api = createHttpApi({ getToken: () => "tok", onUnauthorized: () => {}, fetchImpl });
    const error = (await api.deleteProvider("prv_x").catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe("provider_in_use");
    expect(error.routes).toEqual([{ id: "rte_1", alias: "luna" }]);
  });

  test("listProviderModels unwraps the models array", async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { models: [{ id: "a/b", price_per_m_input: 0.4 }] }));
    const api = createHttpApi({ getToken: () => "tok", onUnauthorized: () => {}, fetchImpl });
    const models = await api.listProviderModels("prv_1");
    expect(models).toEqual([{ id: "a/b", price_per_m_input: 0.4 }]);
  });

  test("the playground posts the request wrapped in { request }", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json(200, { response: null, trace: { attempts: [], upstream_request: null, upstream_response: null } }),
    );
    const api = createHttpApi({ getToken: () => "tok", onUnauthorized: () => {}, fetchImpl });
    await api.runPlayground({ input: "hi", questions: [{ name: "q", type: "predicate", instructions: "yes?" }] });
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
      request: { input: "hi", questions: [{ name: "q", type: "predicate", instructions: "yes?" }] },
    });
  });
});

describe("http api client: non-JSON success bodies", () => {
  test("a 200 with an HTML page is refused rather than treated as data", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("<!doctype html><html></html>", { status: 200 }));
    const api = createHttpApi({ getToken: () => "tok", onUnauthorized: () => {}, fetchImpl });
    const error = (await api.health().catch((caught: unknown) => caught)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("Expected JSON from /admin/api/health");
  });

  test("an empty 200 on a delete is accepted", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("", { status: 200 }));
    const api = createHttpApi({ getToken: () => "tok", onUnauthorized: () => {}, fetchImpl });
    expect(await api.deleteRoute("rte_1")).toBeUndefined();
  });
});
