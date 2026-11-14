// Navigation state: the screens in the rail, their labels, how a hash maps to a screen, and the
// redirects that keep old links working (#/routes became #/models, and so on). Hash routes need
// no server rewrite, so the daemon's SPA fallback is not load-bearing for navigation.

export const SCREENS = ["overview", "models", "providers", "try", "requests", "keys", "settings"] as const;
export type ScreenId = (typeof SCREENS)[number];

export const SCREEN_LABELS: Record<ScreenId, string> = {
  overview: "Overview",
  models: "Models",
  providers: "Providers",
  try: "Try it",
  requests: "Requests",
  keys: "Keys",
  settings: "Settings",
};

/** Screens that were renamed, by their old hash segment. */
export const LEGACY_SCREENS: Readonly<Record<string, ScreenId>> = {
  routes: "models",
  connections: "providers",
  playground: "try",
  logs: "requests",
};

export interface Location {
  screen: ScreenId;
  param: string | null;
  query: URLSearchParams;
}

export function isScreen(value: string): value is ScreenId {
  return (SCREENS as readonly string[]).includes(value);
}

function splitHash(hash: string): { segments: string[]; queryPart: string } {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryStart = raw.indexOf("?");
  const pathPart = queryStart < 0 ? raw : raw.slice(0, queryStart);
  const queryPart = queryStart < 0 ? "" : raw.slice(queryStart + 1);
  return { segments: pathPart.split("/").filter((segment) => segment.length > 0), queryPart };
}

export function parseHash(hash: string): Location {
  const { segments, queryPart } = splitHash(hash);
  const first = segments[0] ?? "overview";
  const screen: ScreenId = isScreen(first) ? first : (LEGACY_SCREENS[first] ?? "overview");
  const param = segments[1] ? decodeURIComponent(segments[1]) : null;
  return { screen, param, query: new URLSearchParams(queryPart) };
}

/**
 * The hash an old link should be replaced with, or null when the hash is current. The rest of the
 * path and the query carry over, so #/routes/rte_1 opens #/models/rte_1.
 */
export function legacyRedirect(hash: string): string | null {
  const { segments, queryPart } = splitHash(hash);
  const first = segments[0];
  if (first === undefined) return null;
  const renamed = LEGACY_SCREENS[first];
  if (!renamed) return null;
  const rest = segments.slice(1).join("/");
  return `#/${renamed}${rest ? `/${rest}` : ""}${queryPart ? `?${queryPart}` : ""}`;
}

export function hrefFor(screen: ScreenId, param?: string | null, query?: Record<string, string | undefined>): string {
  const path = param ? `/${screen}/${encodeURIComponent(param)}` : `/${screen}`;
  const entries = Object.entries(query ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "");
  const search = entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : "";
  return `#${path}${search}`;
}
