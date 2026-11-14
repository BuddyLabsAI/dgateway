import { describe, expect, test } from "bun:test";
import {
  formatClock,
  formatConfidence,
  formatContext,
  formatCount,
  formatMs,
  formatPrice,
  formatProbability,
  formatRate,
  formatRatio,
  formatRelative,
  formatUptime,
} from "../../../src/modules/gateway/apps/console-web/src/domain/format";
import {
  bucketLabel,
  errorRuns,
  gatewayStatus,
  latestErrorRun,
  onsetLabelAlignRight,
  readinessFromHealth,
} from "../../../src/modules/gateway/apps/console-web/src/domain/overview";
import { chainSentence, routeChain } from "../../../src/modules/gateway/apps/console-web/src/domain/chain";
import { parseJsonObject } from "../../../src/modules/gateway/apps/console-web/src/domain/json";
import { logQuery, summariseLoaded } from "../../../src/modules/gateway/apps/console-web/src/domain/logs";
import type { LogEntry, Provider } from "../../../src/modules/gateway/apps/console-web/src/api/types";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

test("onset label anchors to the right in the latter half of the sheet", () => {
  expect(onsetLabelAlignRight({ start: 0, end: 23 }, 24)).toBe(false);
  expect(onsetLabelAlignRight({ start: 11, end: 11 }, 24)).toBe(false);
  expect(onsetLabelAlignRight({ start: 12, end: 12 }, 24)).toBe(true);
  expect(onsetLabelAlignRight({ start: 23, end: 23 }, 24)).toBe(true);
});

describe("formatters", () => {
  test("latency switches from milliseconds to seconds at one second", () => {
    expect(formatMs(312)).toBe("312 ms");
    expect(formatMs(999.6)).toBe("1000 ms");
    expect(formatMs(1240)).toBe("1.24 s");
    expect(formatMs(12_500)).toBe("12.5 s");
    expect(formatMs(null)).toBe("—");
  });

  test("rates are percentages of a real denominator, never of zero", () => {
    expect(formatRate(0, 0)).toBe("—");
    expect(formatRate(0, 100)).toBe("0%");
    expect(formatRate(12, 1000)).toBe("1.2%");
    expect(formatRate(50, 100)).toBe("50%");
    expect(formatRate(1, 3)).toBe("33%");
  });

  test("error rates round down, so a figure never crosses the threshold it sits under", () => {
    expect(formatRatio(0.0996)).toBe("9.9%");
    expect(formatRatio(0.0999999)).toBe("9.9%");
    expect(formatRatio(0.1)).toBe("10%");
    expect(formatRatio(0.4996)).toBe("49%");
    expect(formatRatio(0.5)).toBe("50%");
    expect(formatRatio(0.29)).toBe("29%");
    expect(formatRatio(0.2999999)).toBe("29%");
    expect(formatRatio(1)).toBe("100%");
    expect(formatRatio(0.001)).toBe("0.1%");
    expect(formatRatio(0.0004)).toBe("<0.1%");
    expect(formatRatio(0)).toBe("0%");
    expect(formatRatio(null)).toBe("—");
    expect(formatRatio(Number.NaN)).toBe("—");
  });

  test("a count as a share of a total rounds down in the same way", () => {
    expect(formatRate(996, 10_000)).toBe("9.9%");
    expect(formatRate(4996, 10_000)).toBe("49%");
    expect(formatRate(1, 10_000)).toBe("<0.1%");
    expect(formatRate(1, 0)).toBe("—");
  });

  test("probabilities and confidences round as the bars and labels need", () => {
    expect(formatProbability(0.715)).toBe("72%");
    expect(formatProbability(1.4)).toBe("100%");
    expect(formatConfidence(0.7349)).toBe("0.73");
    expect(formatConfidence(undefined)).toBe("—");
  });

  test("relative time reads in short words, in both directions", () => {
    expect(formatRelative(NOW - 2_000, NOW)).toBe("just now");
    expect(formatRelative(NOW - 30_000, NOW)).toBe("30 s ago");
    expect(formatRelative(NOW - 3 * 60_000, NOW)).toBe("3 min ago");
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe("3 h ago");
    expect(formatRelative(NOW - 2 * 86_400_000, NOW)).toBe("2 d ago");
    expect(formatRelative(NOW + 120_000, NOW)).toBe("in 2 min");
  });

  test("uptime keeps the two largest units", () => {
    expect(formatUptime(3 * 86_400 + 4 * 3_600)).toBe("3 d 4 h");
    expect(formatUptime(4 * 3_600 + 12 * 60)).toBe("4 h 12 min");
    expect(formatUptime(12 * 60)).toBe("12 min");
    expect(formatUptime(45)).toBe("45 s");
  });

  test("clock time is local, 24-hour and zero padded", () => {
    expect(formatClock(new Date(2026, 10, 7, 14, 5).getTime())).toBe("14:05");
  });

  test("counts, prices and context windows are compact and honest about missing values", () => {
    expect(formatCount(1200)).toBe("1,200");
    expect(formatCount(null)).toBe("—");
    expect(formatPrice(0.05)).toBe("0.050");
    expect(formatPrice(0.4)).toBe("0.40");
    expect(formatContext(128_000)).toBe("128k");
    expect(formatContext(undefined)).toBe("—");
  });
});

describe("overview helpers", () => {
  test("error runs are found as contiguous columns above zero", () => {
    expect(errorRuns([0, 1, 1, 0, 2, 0, 0, 3])).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 4 },
      { start: 7, end: 7 },
    ]);
    expect(latestErrorRun([0, 1, 0, 0])).toEqual({ start: 1, end: 1 });
    expect(latestErrorRun([0, 0])).toBeNull();
  });

  test("a bucket label matches its window", () => {
    const iso = new Date(2026, 10, 7, 14, 30).toISOString();
    expect(bucketLabel(iso, "1h")).toBe("14:30");
    expect(bucketLabel(iso, "24h")).toBe("14:00");
    expect(bucketLabel(iso, "7d")).toBe("Sat 14");
  });

  const health = [
    { name: "openai", enabled: true, key_present: true },
    { name: "openrouter", enabled: true, key_present: false },
    { name: "llamacpp", enabled: false, key_present: true },
  ];

  test("readiness separates ready, disabled and key-missing providers", () => {
    expect(readinessFromHealth(health).map((row) => row.readiness)).toEqual(["ready", "key-missing", "disabled"]);
  });

  test("the gateway status reflects reachability and missing keys", () => {
    const readiness = readinessFromHealth(health);
    expect(gatewayStatus(null, readiness)).toBe("unreachable");
    expect(gatewayStatus(false, readiness)).toBe("unreachable");
    expect(gatewayStatus(true, readiness)).toBe("attention");
    expect(gatewayStatus(true, readinessFromHealth([health[0] as (typeof health)[number]]))).toBe("healthy");
  });

  test("a model chain names each step in order, by connection title, and flags an unknown provider", () => {
    const providers: Provider[] = [provider("openai", true, { source: "env", env_var: "OPENAI_API_KEY", present: true })];
    const targets = [
      { provider_id: providers[0]?.id ?? "", model: "gpt-6-luna" },
      { provider_id: "prv_gone", model: "x" },
    ];
    const steps = routeChain(targets, providers);
    expect(steps[1]?.providerKnown).toBe(false);
    expect(steps[0]?.title).toBe("OpenAI");
    expect(chainSentence(steps)).toBe("OpenAI gpt-6-luna → then unknown provider x");
    expect(chainSentence([])).toContain("No steps yet");
  });
});

describe("json and logs helpers", () => {
  test("extra_body must be a JSON object, and empty text is an empty object", () => {
    expect(parseJsonObject("")).toEqual({ ok: true, value: {} });
    expect(parseJsonObject('{"provider":{"sort":"latency"}}')).toEqual({ ok: true, value: { provider: { sort: "latency" } } });
    const array = parseJsonObject("[1]");
    expect(array.ok).toBe(false);
    const broken = parseJsonObject("{bad");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.message.startsWith("Not valid JSON")).toBe(true);
  });

  test("the fallback filter is sent to the gateway, and the summary counts the loaded rows", () => {
    const rows = [logRow("a", false, "ok"), logRow("b", true, "ok"), logRow("c", false, "error")];
    const none = { route: "", provider: "", result: "all" as const };
    expect(logQuery({ ...none, fallback: "any" }).fallback).toBeUndefined();
    expect(logQuery({ ...none, fallback: "used" }).fallback).toBe("used");
    expect(logQuery({ ...none, fallback: "none" }).fallback).toBe("none");
    expect(logQuery({ route: "luna", provider: "", result: "error", fallback: "used" })).toEqual({
      route: "luna",
      provider: undefined,
      status: "error",
      fallback: "used",
    });
    expect(summariseLoaded(rows)).toBe("3 requests loaded · 1 failed · 1 used fallback");
  });
});

function provider(name: string, enabled: boolean, key: Provider["key"]): Provider {
  return {
    id: `prv_${name}`,
    name,
    kind: "openai",
    base_url: "https://example.invalid",
    path: "/decisions",
    wire: "openai",
    enabled,
    timeout_ms: 1000,
    limits: { max_questions: 400, max_choices: 64 },
    extra_body: {},
    key,
    created_at: "",
    updated_at: "",
  };
}

function logRow(id: string, fallback: boolean, status: "ok" | "error"): LogEntry {
  return {
    id,
    ts: "",
    route: "luna",
    provider: "openai",
    upstream_model: "gpt-6-luna",
    status,
    fallback_used: fallback,
    http_status: 200,
    latency_ms: 100,
    questions: 1,
    prompt_tokens: null,
    error: null,
    attempts: [],
  };
}
