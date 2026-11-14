import { describe, expect, test } from "bun:test";
import {
  ERROR_RATE_LIMITS,
  chainStations,
  configVerdict,
  keyReadiness,
  networkLines,
  providerHealth,
  stationVerdict,
  statusCounts,
} from "../../../src/modules/gateway/apps/console-web/src/domain/health";
import {
  attemptTimeline,
  attemptsTotal,
  choiceRows,
  levelName,
  levelRows,
  methodLabel,
  rubric,
  topLevel,
} from "../../../src/modules/gateway/apps/console-web/src/domain/answers";
import { tokenizeCurl, tokenizeJson, tokenizeShell } from "../../../src/modules/gateway/apps/console-web/src/domain/highlight";
import { equivalentCurl } from "../../../src/modules/gateway/apps/console-web/src/domain/playground";
import type { Provider, Route } from "../../../src/modules/gateway/apps/console-web/src/api/types";

function provider(id: string, name: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    name,
    kind: "openai",
    base_url: "https://example.test",
    path: "/decisions",
    wire: "openai",
    enabled: true,
    timeout_ms: 20000,
    limits: { max_questions: 400, max_choices: 64 },
    extra_body: {},
    key: { source: "env", env_var: "KEY", present: true },
    created_at: "2026-11-07T00:00:00Z",
    updated_at: "2026-11-07T00:00:00Z",
    ...overrides,
  };
}

function route(id: string, alias: string, providerIds: string[], enabled = true): Route {
  return {
    id,
    alias,
    description: "",
    enabled,
    targets: providerIds.map((providerId) => ({ provider_id: providerId, model: `${providerId}-model` })),
    created_at: "",
    updated_at: "",
  };
}

describe("station status", () => {
  test("disabled wins, then a missing key, then the error rate in the window", () => {
    expect(stationVerdict({ enabled: false, keyPresent: false, requests: 100, errors: 90 }).status).toBe("disabled");
    expect(stationVerdict({ enabled: true, keyPresent: false, requests: 0, errors: 0 })).toEqual({ status: "failing", reason: "Needs key" });
    expect(stationVerdict({ enabled: true, keyPresent: false, requests: 100, errors: 0 })).toEqual({ status: "failing", reason: "Needs key" });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 100, errors: 25 })).toEqual({ status: "degraded", reason: "25% errors" });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 100, errors: 5 })).toEqual({ status: "ok", reason: "5% errors" });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 1000, errors: 49 })).toEqual({ status: "ok", reason: "4.9% errors" });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 10, errors: 0 })).toEqual({ status: "ok", reason: "No errors" });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 0, errors: 0 })).toEqual({ status: "ok", reason: "No traffic" });
  });

  test("degraded from 10% of requests failing and failing from 50%, with figures rounded down across a line", () => {
    expect(ERROR_RATE_LIMITS).toEqual({ degraded: 0.1, failing: 0.5 });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 1000, errors: 99 })).toEqual({ status: "ok", reason: "9.9% errors" });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 10000, errors: 996 })).toEqual({ status: "ok", reason: "9.9% errors" });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 1000, errors: 100 })).toEqual({
      status: "degraded",
      reason: "10% errors",
    });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 1000, errors: 499 })).toEqual({
      status: "degraded",
      reason: "49% errors",
    });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 1000, errors: 500 })).toEqual({
      status: "failing",
      reason: "50% errors",
    });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 1000, errors: 1 })).toEqual({ status: "ok", reason: "0.1% errors" });
    expect(stationVerdict({ enabled: true, keyPresent: true, requests: 10000, errors: 1 })).toEqual({ status: "ok", reason: "<0.1% errors" });
  });

  test("configuration alone flags a disabled provider, an unset environment key, and a key-needing kind with none", () => {
    expect(configVerdict(provider("p1", "a", { enabled: false })).status).toBe("disabled");
    expect(configVerdict(provider("p1", "a", { key: { source: "none" } }))).toEqual({ status: "failing", reason: "Needs key" });
    const local = { kind: "systemone" as const, base_url: "http://host.docker.internal:8080", key: { source: "none" as const } };
    expect(configVerdict(provider("p1", "a", local))).toEqual({ status: "ok", reason: "Ready" });
    // A hosted SystemOne vendor refuses requests without a key, as OpenAI and OpenRouter do.
    expect(configVerdict(provider("p1", "a", { ...local, base_url: "https://api.typesafe.ai" }))).toEqual({
      status: "failing",
      reason: "Needs key",
    });
    expect(configVerdict(provider("p1", "a", { key: { source: "env", env_var: "K", present: false } }))).toEqual({
      status: "failing",
      reason: "Needs key",
    });
    expect(configVerdict(provider("p1", "a", { key: { source: "stored", last4: "abcd" } })).status).toBe("ok");
  });

  test("key readiness prefers saved configuration for 'no key', then the health report", () => {
    const local = provider("p", "a", { kind: "openai-compatible", key: { source: "none" } });
    expect(keyReadiness(local, { name: "a", enabled: true, key_present: true })).toBe("none");
    // OpenAI and OpenRouter refuse requests without a key, so "no key" there means one is missing.
    expect(keyReadiness(provider("p", "a", { key: { source: "none" } }), { name: "a", enabled: true, key_present: true })).toBe("missing");
    expect(keyReadiness(undefined, { name: "a", enabled: true, key_present: false })).toBe("missing");
    expect(keyReadiness(provider("p", "a", { key: { source: "env", env_var: "K", present: false } }), undefined)).toBe("missing");
    expect(keyReadiness(undefined, undefined)).toBe("unknown");
  });
});

describe("provider health rows", () => {
  const health = [
    { name: "openai", enabled: true, key_present: true },
    { name: "openrouter", enabled: true, key_present: false },
    { name: "llama", enabled: false, key_present: true },
  ];
  const stats = [
    { provider: "openai", requests: 300, errors: 3, p50_ms: 300 },
    { provider: "openrouter", requests: 100, errors: 10, p50_ms: 600 },
  ];

  test("joins health, traffic and configuration, worst status first", () => {
    const rows = providerHealth(health, stats, [provider("prv_openai", "openai")]);
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["openrouter", "failing"],
      ["openai", "ok"],
      ["llama", "disabled"],
    ]);
    const openai = rows.find((row) => row.name === "openai");
    expect(openai?.providerId).toBe("prv_openai");
    expect(openai?.kind).toBe("openai");
    expect(openai?.share).toBe(0.75);
    expect(openai?.errorRate).toBe(0.01);
    expect(rows.find((row) => row.name === "llama")?.errorRate).toBeNull();
  });

  test("a provider with traffic but missing from health still gets a row", () => {
    const rows = providerHealth([], [{ provider: "ghost", requests: 4, errors: 0, p50_ms: 10 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.share).toBe(1);
    expect(rows[0]?.key).toBe("unknown");
  });

  test("counts per status for the summary line", () => {
    expect(statusCounts(providerHealth(health, stats))).toEqual({ ok: 1, degraded: 0, failing: 1, disabled: 1 });
  });
});

describe("the network of routes", () => {
  const providers = [provider("p1", "openai"), provider("p2", "openrouter", { key: { source: "env", env_var: "K", present: false } })];
  const routes = [route("r1", "luna", ["p1", "p2"]), route("r2", "elephant", ["p2"]), route("r3", "ghost", ["p9"], false)];

  test("each route is a line of stations in fallback order, with shared stations marked", () => {
    const lines = networkLines(routes, providers, [{ route: "luna", requests: 40, errors: 4, p50_ms: 210 }]);
    expect(lines.map((line) => line.ink)).toEqual([0, 1, 2]);
    const luna = lines[0];
    expect(luna?.stations.map((station) => [station.position, station.providerName, station.status, station.sharedWith])).toEqual([
      [1, "openai", "ok", 0],
      [2, "openrouter", "failing", 1],
    ]);
    expect(luna?.errorRate).toBe(0.1);
    expect(lines[2]?.stations[0]).toMatchObject({ known: false, providerName: "unknown provider", title: "unknown provider", status: "failing" });
    expect(lines[1]?.requests).toBe(0);
  });

  test("traffic-aware verdicts override configuration when given", () => {
    const lines = networkLines(routes.slice(0, 1), providers, [], new Map([["openai", { status: "degraded" as const, reason: "8% errors" }]]));
    expect(lines[0]?.stations[0]).toMatchObject({ status: "degraded", reason: "8% errors" });
  });

  test("the route editor's stations carry their timeouts and flag an unchosen provider", () => {
    const stations = chainStations(
      [
        { provider_id: "p1", model: "m", timeout_ms: 8000 },
        { provider_id: "", model: "" },
      ],
      providers,
    );
    expect(stations[0]).toMatchObject({ providerName: "openai", timeoutMs: 8000, status: "ok" });
    expect(stations[0]).toMatchObject({ title: "OpenAI" });
    expect(stations[1]).toMatchObject({ providerName: "no provider", reason: "No provider chosen", timeoutMs: null });
  });
});

describe("answers", () => {
  test("choice bars run most likely first, with the answer marked", () => {
    const rows = choiceRows(
      [
        { value: "other", probability: 0.1 },
        { value: "billing", probability: 0.6 },
        { value: "technical", probability: 0.3 },
      ],
      "billing",
    );
    expect(rows.map((row) => row.label)).toEqual(["billing", "technical", "other"]);
    expect(rows.filter((row) => row.chosen).map((row) => row.label)).toEqual(["billing"]);
    expect(
      choiceRows(
        [
          { value: "a", probability: 1.4 },
          { value: "b", probability: -0.2 },
        ],
        "a",
      ).map((row) => row.value),
    ).toEqual([1, 0]);
  });

  test("a typed answer marks only its own option: true is not the string true", () => {
    const rows = choiceRows(
      [
        { value: "true", probability: 0.3 },
        { value: true, probability: 0.7 },
      ],
      true,
    );
    expect(rows.map((row) => [row.label, row.chosen])).toEqual([
      ["true", true],
      ["true", false],
    ]);
    expect(rows[0]?.value).toBe(0.7);
  });

  test("score levels keep rubric order and mark the most likely level", () => {
    const probabilities = [
      { value: 0, label: "minor", probability: 0.2 },
      { value: 1, label: "moderate", probability: 0.5 },
      { value: 2, label: "severe", probability: 0.3 },
    ];
    expect(levelRows(probabilities).map((row) => [row.label, row.chosen])).toEqual([
      ["minor", false],
      ["moderate", true],
      ["severe", false],
    ]);
    expect(topLevel(probabilities)).toBe(1);
  });

  test("a level without a label is named by its index, and a tie goes to the lower level", () => {
    const probabilities = [
      { value: 0, probability: 0.4 },
      { value: 1, probability: 0.4 },
      { value: 2, label: "high", probability: 0.2 },
    ];
    expect(probabilities.map(levelName)).toEqual(["0", "1", "high"]);
    expect(topLevel(probabilities)).toBe(0);
    expect(levelRows(probabilities).filter((row) => row.chosen).map((row) => row.label)).toEqual(["0"]);
  });

  test("the rubric spaces levels evenly and places a zero-based score between them", () => {
    const scale = rubric(["minor", "moderate", "severe"], 1.5);
    expect(scale.ticks.map((tick) => tick.at)).toEqual([0, 0.5, 1]);
    expect(scale.marker).toBe(0.75);
    expect(rubric(["only"], 3).marker).toBe(1);
    expect(rubric(["a", "b"], -1).marker).toBe(0);
  });

  test("confidence methods read in words", () => {
    expect(methodLabel("normalized-entropy")).toBe("normalized entropy");
    expect(methodLabel(undefined)).toBe("method not reported");
  });
});

describe("the attempts timeline", () => {
  const attempts = [
    { provider: "a", model: "m", ok: false, latency_ms: 10 },
    { provider: "b", model: "m", ok: true, latency_ms: 990 },
  ];

  test("segments run end to end in order, as wide as their latency, filling the track", () => {
    const segments = attemptTimeline(attempts);
    expect(segments.map((segment) => segment.index)).toEqual([0, 1]);
    expect(segments[0]?.start).toBe(0);
    expect(segments[1]?.start).toBeCloseTo(segments[0]?.width ?? 0);
    expect((segments[0]?.width ?? 0) + (segments[1]?.width ?? 0)).toBeCloseTo(1);
  });

  test("a fast failure keeps a minimum width so it stays visible", () => {
    const [first] = attemptTimeline(attempts, 0.08);
    expect(first?.width).toBeGreaterThan(0.07);
  });

  test("zero latencies share the track equally, and the total sums every try", () => {
    const segments = attemptTimeline([
      { provider: "a", model: "m", ok: false, latency_ms: 0 },
      { provider: "b", model: "m", ok: false, latency_ms: 0 },
    ]);
    expect(segments.map((segment) => segment.width)).toEqual([0.5, 0.5]);
    expect(attemptsTotal(attempts)).toBe(1000);
    expect(attemptTimeline([])).toEqual([]);
  });
});

describe("code highlighting", () => {
  const json = JSON.stringify({ model: "luna", ok: true, n: -1.5e3, none: null, list: [1, "two"] }, null, 2);

  test("JSON tokens join back to the exact source", () => {
    expect(
      tokenizeJson(json)
        .map((token) => token.text)
        .join(""),
    ).toBe(json);
  });

  test("keys, strings, numbers and literals are told apart", () => {
    const tokens = tokenizeJson(json);

    const kindOf = (text: string): string | undefined => tokens.find((token) => token.text === text)?.kind;

    expect(kindOf('"model"')).toBe("key");
    expect(kindOf('"luna"')).toBe("string");
    expect(kindOf("-1500")).toBe("number");
    expect(kindOf("true")).toBe("literal");
    expect(kindOf("null")).toBe("literal");
    expect(kindOf('"two"')).toBe("string");
  });

  test("shell tokens join back to the source and find the command, flags, strings and variables", () => {
    const command = "curl http://127.0.0.1:8790/v1/decisions \\\n  -H \"Authorization: Bearer $DG_CLIENT_KEY\" \\\n  -d 'it'\\''s'";
    const tokens = tokenizeShell(command);
    expect(tokens.map((token) => token.text).join("")).toBe(command);
    expect(tokens[0]).toEqual({ kind: "command", text: "curl" });
    expect(tokens.find((token) => token.kind === "url")?.text).toBe("http://127.0.0.1:8790/v1/decisions");
    expect(tokens.filter((token) => token.kind === "flag").map((token) => token.text)).toEqual(["-H", "-d"]);
    expect(tokens.filter((token) => token.kind === "continuation")).toHaveLength(2);
  });

  test("the curl body is highlighted as JSON and still copies exactly", () => {
    const curl = equivalentCurl({ model: "luna", input: "Charged twice", questions: [] }, "http://127.0.0.1:8790", true);
    const tokens = tokenizeCurl(curl);
    expect(tokens.map((token) => token.text).join("")).toBe(curl);
    expect(tokens.some((token) => token.kind === "key" && token.text === '"model"')).toBe(true);
    expect(tokens.some((token) => token.kind === "string" && token.text.includes("$DG_CLIENT_KEY"))).toBe(true);
    expect(tokens.filter((token) => token.kind === "command").map((token) => token.text)).toEqual(["curl"]);
  });
});
