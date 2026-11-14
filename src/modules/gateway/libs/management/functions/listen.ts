export type ListenEnv = Record<string, string | undefined>;

export type Listen = { hostname: string; port: number; warnings: string[] };

export const DEFAULT_HOSTNAME = '0.0.0.0';

export const DEFAULT_PORT = 8790;

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';

const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

const HEXTET = /^[0-9a-f]{1,4}$/i;

export function isIPv4(value: string): boolean {
  return IPV4.test(value);
}

// Eight groups of 1 to 4 hex digits, where one '::' may stand for one or more zero groups and the last two groups may be
// written as an IPv4 address, such as ::ffff:127.0.0.1.
export function isIPv6(value: string): boolean {
  const halves = value.split('::');
  if (halves.length > 2) return false;
  const groups = halves.map((h) => (h ? h.split(':') : []));
  const all = groups.flat();
  const last = all.at(-1);
  const v4 = last !== undefined && !value.endsWith(':') && isIPv4(last);
  const hex = v4 ? all.slice(0, -1) : all;
  if (!hex.every((g) => HEXTET.test(g))) return false;
  const count = hex.length + (v4 ? 2 : 0);
  return halves.length === 2 ? count < 8 : count === 8;
}

// The address the daemon binds. An IPv6 literal may be written in brackets, such as [::1]; the brackets are removed.
export function listenAddress(value: string): string | undefined {
  const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (bare === 'localhost' || isIPv4(bare) || isIPv6(bare)) return bare;
  return undefined;
}

// DGATEWAY_HOST wins and must be valid. HOST is used only when it is a listen address: many shells export HOST as
// the machine's name, so an invalid HOST is ignored with a warning instead of failing the bind.
function resolveHostname(env: ListenEnv, warnings: string[]): string {
  const own = env.DGATEWAY_HOST;
  if (own) {
    const address = listenAddress(own);
    if (!address)
      throw new Error(
        `DGATEWAY_HOST="${own}" is not a listen address; use an IPv4 or IPv6 address, localhost, 0.0.0.0 or ::`,
      );
    return address;
  }
  const host = env.HOST;
  if (!host) return DEFAULT_HOSTNAME;
  const address = listenAddress(host);
  if (address) return address;
  warnings.push(
    `HOST="${host}" is not a listen address; ignoring it. Set DGATEWAY_HOST to choose the address.`,
  );
  return DEFAULT_HOSTNAME;
}

// DGATEWAY_PORT wins over PORT; whichever is used must be a whole number from 1 to 65535.
function resolvePort(env: ListenEnv): number {
  const name = env.DGATEWAY_PORT ? 'DGATEWAY_PORT' : env.PORT ? 'PORT' : undefined;
  if (!name) return DEFAULT_PORT;
  const raw = env[name]!;
  const port = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name}="${raw}" is not a port; use a whole number from 1 to 65535`);
  return port;
}

// Decides where the daemon listens. Throws an Error naming the variable when DGATEWAY_HOST, DGATEWAY_PORT or PORT
// is invalid; an empty variable counts as unset.
export function resolveListen(env: ListenEnv): Listen {
  const warnings: string[] = [];
  const hostname = resolveHostname(env, warnings);
  return { hostname, port: resolvePort(env), warnings };
}
