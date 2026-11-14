// The one interface every screen talks to. The HTTP implementation and the mock
// implementation both satisfy it, so screens never know which one they have.

import type {
  ClientKey,
  CreatedClientKey,
  DecisionRequest,
  Health,
  LogPage,
  LogQuery,
  PlaygroundRun,
  ProviderModel,
  ProviderPatch,
  ProviderTestResult,
  Provider,
  ProviderWrite,
  Route,
  RouteWrite,
  Settings,
  Stats,
  StatsWindow,
} from "./types";

export interface ConsoleApi {
  /** Health for an explicit token (used by sign-in). Does not touch the session. */
  checkToken(token: string): Promise<Health>;
  health(): Promise<Health>;
  stats(window: StatsWindow): Promise<Stats>;

  listProviders(): Promise<Provider[]>;
  createProvider(body: ProviderWrite): Promise<Provider>;
  updateProvider(id: string, patch: ProviderPatch): Promise<Provider>;
  deleteProvider(id: string): Promise<void>;
  testProvider(id: string, model?: string): Promise<ProviderTestResult>;
  listProviderModels(id: string): Promise<ProviderModel[]>;

  listRoutes(): Promise<Route[]>;
  createRoute(body: RouteWrite): Promise<Route>;
  updateRoute(id: string, patch: Partial<RouteWrite>): Promise<Route>;
  deleteRoute(id: string): Promise<void>;

  listLogs(query: LogQuery): Promise<LogPage>;

  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;

  listClients(): Promise<ClientKey[]>;
  createClient(name: string): Promise<CreatedClientKey>;
  deleteClient(id: string): Promise<void>;

  runPlayground(request: DecisionRequest): Promise<PlaygroundRun>;
}
