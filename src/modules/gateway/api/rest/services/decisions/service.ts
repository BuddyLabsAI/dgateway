import { GatewayError } from '../../../../libs/decisions/schemas/types';
import { validateRequest } from '../../../../libs/decisions/functions/validation';
import type { PublicDecisions } from '../../../../libs/decisions/effects/public';

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export const failure = (e: unknown) => {
  const x =
    e instanceof GatewayError ? e : new GatewayError(500, 'server_error', 'Internal server error');
  return json({ error: x.body() }, x.status);
};

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new GatewayError(400, 'invalid_request_error', 'Invalid JSON body');
  }
}

// The client key a public request presents, or undefined when there is no Bearer credential.
const bearer = (req: Request): string | undefined =>
  /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];

// /v1/models follows the same client-key rule as /v1/decisions. Refusals are answered, not logged:
// the request log records decisions only.
export async function publicService(
  req: Request,
  path: string,
  service: PublicDecisions,
): Promise<Response | null> {
  if (path === '/healthz' && req.method === 'GET') return json({ ok: true });
  if (path === '/v1/models' && req.method === 'GET') {
    try {
      service.authorize(bearer(req));
      return json(service.models());
    } catch (e) {
      return failure(e);
    }
  }
  if (path !== '/v1/decisions' || req.method !== 'POST') return null;
  const start = service.now();
  let body: unknown = null;
  try {
    service.authorize(bearer(req));
    body = await readJson(req);
    const request = validateRequest(body);
    const result = await service.execute(request);
    return result.response ? json(result.response) : json({ error: result.error }, result.status);
  } catch (e) {
    const err =
      e instanceof GatewayError
        ? e
        : new GatewayError(500, 'server_error', 'Internal server error');
    service.logRejection(start, err, body);
    return failure(err);
  }
}
