// Chooses the implementation behind the console: the real same-origin API, or the
// in-memory mock when mock mode is on. The mock is imported only in mock mode, so its
// fixtures are split into their own chunk and stay out of the production entry bundle.

import type { ConsoleApi } from "./console-api";
import { createHttpApi } from "./http";

export interface ApiSource {
  mock: boolean;
  /** Which mock world to serve: the demo day, or a first run with no keys. */
  scenario?: "demo" | "fresh";
  /** False makes the mock refuse stored keys, as a gateway without GATEWAY_SECRET does. */
  storesKeys?: boolean;
  /** False makes the mock fail every provider's model list, to show the error state. */
  listsModels?: boolean;
  getToken: () => string | null;
  onUnauthorized: () => void;
}

export async function createConsoleApi(source: ApiSource): Promise<ConsoleApi> {
  if (source.mock) {
    const { createMockApi } = await import("./mock/mock-api");
    return createMockApi({
      scenario: source.scenario ?? "demo",
      storesKeys: source.storesKeys ?? true,
      listsModels: source.listsModels ?? true,
    });
  }
  return createHttpApi({ getToken: source.getToken, onUnauthorized: source.onUnauthorized });
}
