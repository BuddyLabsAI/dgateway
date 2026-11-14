// Mock mode is on for ?mock=1 in any build, and for every dev run (`bun run dev` sets
// BUN_PUBLIC_MOCK=1, which bunfig.toml inlines at bundle time). Production builds never inline it,
// so the flag is read through a guard. ?mock=fresh serves a first run instead of the demo day:
// no keys, only the seeded models, no traffic, so the first-run checklist shows. Adding
// &nosecret=1 makes the mock refuse to store keys, as a gateway without GATEWAY_SECRET does, and
// &nocatalog=1 makes every provider's model list fail to load, so the pickers show their error state.

export type MockScenario = "demo" | "fresh";

export interface MockMode {
  scenario: MockScenario;
  /** False when the mock should refuse stored keys, as a gateway without GATEWAY_SECRET does. */
  storesKeys: boolean;
  /** False when the mock should fail every provider's model list, to show the error state. */
  listsModels: boolean;
}

export function readDevMockFlag(): string | undefined {
  try {
    return process.env.BUN_PUBLIC_MOCK;
  } catch {
    // In a production bundle `process` does not exist and the reference is left in place.
    return undefined;
  }
}

/** The mock mode the page asks for, or null for the real gateway. */
export function mockMode(search: string, devFlag: string | undefined = readDevMockFlag()): MockMode | null {
  const params = new URLSearchParams(search);
  const flag = params.get("mock");
  const storesKeys = params.get("nosecret") !== "1";
  const listsModels = params.get("nocatalog") !== "1";
  if (flag === "fresh") return { scenario: "fresh", storesKeys, listsModels };
  if (flag === "1" || devFlag === "1") return { scenario: "demo", storesKeys, listsModels };
  return null;
}

export function isMockMode(search: string, devFlag: string | undefined = readDevMockFlag()): boolean {
  return mockMode(search, devFlag) !== null;
}
