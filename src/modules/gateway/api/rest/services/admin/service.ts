import { GatewayError } from '../../../../libs/decisions/schemas/types';
import { object } from '../../../../libs/decisions/functions/validation';
import type { PublicDecisions } from '../../../../libs/decisions/effects/public';
import type { Admin } from '../../../../libs/management/effects/admin';
import { json, failure, readJson } from '../decisions/service';

export async function adminService(
  req: Request,
  url: URL,
  admin: Admin,
  service: PublicDecisions,
  token: string,
  started: number,
): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/admin/api')) return null;
  try {
    const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? '';
    admin.authorize(bearer, token);
    const method = req.method;
    const sub = path.slice('/admin/api'.length);
    const match = /^\/(providers|routes|clients)\/([^/]+)(?:\/(test|models))?$/.exec(sub);
    if (sub === '/providers') {
      if (method === 'GET') return json(admin.providers());
      if (method === 'POST') return json(admin.saveProvider(await readJson(req)));
    }
    if (sub === '/routes') {
      if (method === 'GET') return json(admin.routes());
      if (method === 'POST') return json(admin.saveRoute(await readJson(req)));
    }
    if (sub === '/clients') {
      if (method === 'GET') return json(admin.clients());
      if (method === 'POST') return json(admin.createClient(await readJson(req)));
    }
    if (match) {
      const [, entity, id, action] = match;
      if (entity === 'providers') {
        if (!action && method === 'PATCH') return json(admin.saveProvider(await readJson(req), id));
        if (!action && method === 'DELETE') return json(admin.deleteProvider(id));
        if (action === 'test' && method === 'POST')
          return json(await admin.test(id, await readJson(req)));
        if (action === 'models' && method === 'GET') return json(await admin.models(id));
      }
      if (entity === 'routes' && !action) {
        if (method === 'PATCH') return json(admin.saveRoute(await readJson(req), id));
        if (method === 'DELETE') return json(admin.deleteRoute(id));
      }
      if (entity === 'clients' && !action && method === 'DELETE')
        return json(admin.deleteClient(id));
    }
    if (sub === '/settings') {
      if (method === 'GET') return json(admin.settings());
      if (method === 'PATCH') return json(admin.updateSettings(await readJson(req)));
    }
    if (sub === '/logs' && method === 'GET') return json(admin.logs(url.searchParams));
    if (sub === '/stats' && method === 'GET')
      return json(admin.stats(url.searchParams.get('window')));
    if (sub === '/health' && method === 'GET') return json(admin.health(started));
    if (sub === '/playground' && method === 'POST') {
      const start = service.now();
      let body: unknown = null;
      try {
        body = await readJson(req);
        return json(await admin.playground(body));
      } catch (e) {
        const err =
          e instanceof GatewayError
            ? e
            : new GatewayError(500, 'server_error', 'Internal server error');
        service.logRejection(start, err, object(body) ? body.request : undefined);
        throw err;
      }
    }
    throw new GatewayError(404, 'not_found_error', 'Endpoint not found');
  } catch (e) {
    return failure(e);
  }
}
