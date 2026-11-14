import { createContext, useContext, type ReactNode } from "react";
import type { ConsoleApi } from "../api/console-api";

const ApiContext = createContext<ConsoleApi | null>(null);

export function ApiProvider({ api, children }: { api: ConsoleApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ConsoleApi {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside ApiProvider");
  return api;
}
