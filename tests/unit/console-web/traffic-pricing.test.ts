import { describe, expect, test } from "bun:test";
import type { Provider, ProviderModel, ProviderStats, Route, RouteStats, RouteTarget } from "../../../src/modules/gateway/apps/console-web/src/api/types";
import { connectionPricing, modelPricing, pricingWithTraffic } from "../../../src/modules/gateway/apps/console-web/src/domain/pricing";
import { modelRows } from "../../../src/modules/gateway/apps/console-web/src/domain/models";
import { networkLines, providerHealth } from "../../../src/modules/gateway/apps/console-web/src/domain/health";

const provider = (id: string, name: string, kind: Provider["kind"]): Provider => ({
  id,
  name,
  kind,
  base_url: "http://example.test",
  path: "/decisions",
  wire: "openai",
  enabled: true,
  timeout_ms: 1000,
  limits: { max_questions: 10, max_choices: 10 },
  extra_body: {},
  key: { source: "none" },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const route = (alias: string, targets: RouteTarget[]): Route => ({
  id: `rte_${alias}`,
  alias,
  description: "",
  enabled: true,
  targets,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const providers = [provider("oai", "openai", "openai"), provider("oai-cold", "openai-cold", "openai"), provider("mock", "mock", "mock")];

// The OpenAI catalog is loaded for "oai" only; "oai-cold" has not been read, so its default is not known.
const catalogs = new Map<string, readonly ProviderModel[]>([["oai", [{ id: "gpt-6-luna", default_price_per_m_input: 0.1 }]]]);

describe("the pricing label once traffic is known", () => {
  test("without traffic, or on a gateway that reports no unpriced count, the configuration's hint stands", () => {
    expect(pricingWithTraffic("unpriced", undefined)).toBe("unpriced");
    expect(pricingWithTraffic("unpriced", { requests: 5, errors: 1 })).toBe("unpriced");
    expect(pricingWithTraffic("priced", { requests: 4, errors: 4, unpriced: 0 })).toBe("priced");
  });

  test("the gateway's unpriced count decides: all answered unpriced is unpriced, some is partly, none is priced", () => {
    expect(pricingWithTraffic("priced", { requests: 3, errors: 0, unpriced: 3 })).toBe("unpriced");
    expect(pricingWithTraffic("priced", { requests: 4, errors: 1, unpriced: 1 })).toBe("partly-unpriced");
    expect(pricingWithTraffic("unpriced", { requests: 3, errors: 0, unpriced: 0 })).toBe("priced");
    expect(pricingWithTraffic("partly-unpriced", { requests: 2, errors: 0, unpriced: 0 })).toBe("priced");
  });

  test("a free model stays free when its traffic was all free", () => {
    expect(pricingWithTraffic("free", { requests: 2, errors: 0, unpriced: 0 })).toBe("free");
  });
});

describe("a model's pricing label from its steps and its traffic", () => {
  const routes = [
    route("luna", [{ provider_id: "oai", model: "gpt-6-luna" }]),
    route("gpt-x", [{ provider_id: "oai", model: "gpt-x" }]),
    route("cold", [{ provider_id: "oai-cold", model: "gpt-6-luna" }]),
    route("quiet", [{ provider_id: "oai", model: "gpt-6-luna" }]),
    route("free", [{ provider_id: "mock", model: "mock-1" }]),
  ];
  const stats: RouteStats[] = [
    { route: "luna", requests: 10, errors: 2, p50_ms: 100, cost_usd: 0.1, unpriced: 0 },
    { route: "gpt-x", requests: 4, errors: 0, p50_ms: 80, cost_usd: 0, unpriced: 4 },
    { route: "free", requests: 3, errors: 0, p50_ms: 10, cost_usd: 0, unpriced: 0 },
  ];

  test("traffic overrides the configuration; without traffic the catalog decides, and an unloaded catalog is not yet known", () => {
    const rows = modelRows(routes, providers, stats, catalogs);
    const label = Object.fromEntries(rows.map((row) => [row.name, row.pricing.pricing]));
    expect(label).toEqual({
      luna: "priced",
      "gpt-x": "unpriced",
      // An unloaded catalog reads like OpenRouter's hint: priced until traffic says otherwise.
      cold: "priced",
      quiet: "priced",
      free: "free",
    });
  });

  test("a step's unpriced link still points at the first step with no known price", () => {
    const rows = modelRows(routes, providers, stats, catalogs);
    expect(rows.find((row) => row.name === "gpt-x")?.pricing.unpricedStep).toBe(1);
    expect(rows.find((row) => row.name === "luna")?.pricing.unpricedStep).toBeNull();
  });

  test("the configuration view is unchanged for callers that pass no traffic or catalogs", () => {
    expect(modelPricing(route("quiet", [{ provider_id: "oai", model: "gpt-6-luna" }]), providers)).toEqual({
      pricing: "priced",
      unpricedStep: null,
    });
    // The connection's steps include gpt-x, which the catalog does not list, so it is partly unpriced.
    expect(connectionPricing({ id: "oai", kind: "openai" }, routes, catalogs.get("oai"))).toBe("partly-unpriced");
  });
});

describe("unpriced counts reach the network and connection views", () => {
  test("a line and a connection row carry the route's and the provider's unpriced count", () => {
    const routes = [route("gpt-x", [{ provider_id: "oai", model: "gpt-x" }])];
    const routeStats: RouteStats[] = [{ route: "gpt-x", requests: 4, errors: 0, p50_ms: 80, cost_usd: 0, unpriced: 4 }];
    const providerStats: ProviderStats[] = [{ provider: "openai", requests: 4, errors: 0, p50_ms: 80, cost_usd: 0, unpriced: 4 }];
    const [line] = networkLines(routes, providers, routeStats);
    expect(line?.unpriced).toBe(4);
    const [row] = providerHealth([{ name: "openai", enabled: true, key_present: true }], providerStats, providers);
    expect(row?.unpriced).toBe(4);
    expect(pricingWithTraffic(connectionPricing({ id: "oai", kind: "openai" }, routes, catalogs.get("oai")), row)).toBe("unpriced");
  });

  test("a route with no traffic has no unpriced count to report", () => {
    const [line] = networkLines([route("quiet", [{ provider_id: "oai", model: "gpt-6-luna" }])], providers, []);
    expect(line?.unpriced).toBeUndefined();
  });
});
