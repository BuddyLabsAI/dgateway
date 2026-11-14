// Whether a provider's base URL points at this machine or a private network, by the gateway's own rule
// (API reference, Cost): a local SystemOne server is sent no model unless asked.
// The console keeps its own copy because it never imports the backend. The URL is parsed, never resolved. Pure.

const LOCAL_NAMES = new Set(["localhost", "host.docker.internal"]);

/** The four numbers of a dotted IPv4 address, or null when the host is not one. */
function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** Loopback 127.0.0.0/8, and the private ranges 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16. */
function localIpv4(octets: readonly number[]): boolean {
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * True for localhost, 127.0.0.0/8, ::1, host.docker.internal, any *.local name, and the private ranges
 * 10/8, 172.16/12 and 192.168/16. Anything else, including text that is not a URL, is hosted.
 */
export function isLocalHost(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  if (host === "[::1]" || host === "::1") return true;
  if (LOCAL_NAMES.has(host) || host.endsWith(".local")) return true;
  const octets = ipv4(host);
  return octets !== null && localIpv4(octets);
}

/** The send_model the gateway gives a new provider that has none: off only for a local SystemOne server. */
export function defaultSendModel(kind: string, baseUrl: string): boolean {
  return kind !== "systemone" || !isLocalHost(baseUrl);
}
