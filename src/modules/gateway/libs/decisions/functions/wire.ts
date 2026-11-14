// How a request reaches a provider: whether the body names the upstream model, and which header carries the key.
import type { Provider } from '../../management/schemas/types';
import { isLocalHost } from './hosts';

// The header that carries a key as "Bearer <key>". Any other header carries the key as it is.
export const AUTHORIZATION = 'authorization';

// Header names a key may not travel in: the gateway sets these itself.
const RESERVED_HEADERS = new Set(['content-type', 'host']);

// The send_model a new provider gets when it is created without one. A local systemone server (llama.cpp and the
// like) serves the one model it loaded, so it is sent none; a hosted one serves many and is told which. The openai
// wire sends the model whatever the setting, so the openai kinds default to true, which says what happens. The
// arguments may be unvalidated input, since a draft is filled in before it is checked.
export function defaultSendModel(kind: unknown, baseUrl: unknown): boolean {
  if (kind !== 'systemone') return true;
  return !(typeof baseUrl === 'string' && isLocalHost(baseUrl));
}

// Whether the upstream body names the model: always on the openai wire, and on the map wire when send_model says
// so. A row written before migration 3 has no setting and reads with the default for its kind and host.
export function sendsModel(
  p: Pick<Provider, 'kind' | 'base_url' | 'wire' | 'send_model'>,
): boolean {
  if (p.wire === 'openai' || p.wire === 'chat') return true;
  return p.send_model ?? defaultSendModel(p.kind, p.base_url);
}

// True for a header name a key may travel in: letters, digits and hyphens, and not one the gateway sets itself.
export function validAuthHeader(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9-]+$/.test(name) &&
    !RESERVED_HEADERS.has(name.toLowerCase())
  );
}

// The header that carries a key: "authorization" with "Bearer <key>", or a custom header with the key as it is.
// Without a key there is nothing to send.
export function authHeaders(
  header: string | undefined,
  key: string | null,
): Record<string, string> {
  if (!key) return {};
  const name = (header ?? AUTHORIZATION).toLowerCase();
  return name === AUTHORIZATION ? { authorization: `Bearer ${key}` } : { [name]: key };
}

// The headers of an upstream decision call.
export function upstreamHeaders(
  p: Pick<Provider, 'auth_header'>,
  key: string | null,
): Record<string, string> {
  return { 'content-type': 'application/json', ...authHeaders(p.auth_header, key) };
}

// The custom header a provider's key travels in, or null when it uses authorization. Redaction covers the name in
// traces and logs, beside the field names it always covers.
export function customAuthHeader(p: Pick<Provider, 'auth_header'>): string | null {
  const name = (p.auth_header ?? AUTHORIZATION).toLowerCase();
  return name === AUTHORIZATION ? null : name;
}
