import { resolve, sep, extname } from 'node:path';
import { Store, id } from '../../libs/management/providers/store';
import { Admin } from '../../libs/management/effects/admin';
import { PublicDecisions } from '../../libs/decisions/effects/public';
import { callUpstream } from '../../libs/decisions/providers/upstream';
import type { DecideDeps } from '../../libs/decisions/effects/decide';
import { GatewayError } from '../../libs/decisions/schemas/types';
import {
  catalogPrice,
  supportedParameters,
  type CatalogEntry,
} from '../../libs/management/functions/admin';
import { resolveListen } from '../../libs/management/functions/listen';
import { publicService, failure } from '../../api/rest/services/decisions/service';
import { adminService } from '../../api/rest/services/admin/service';

export function createGateway(
  options: { env?: NodeJS.ProcessEnv; http?: typeof fetch; clock?: () => number } = {},
) {
  const env = options.env ?? process.env;
  const adminToken = env.ADMIN_TOKEN;
  if (!adminToken) throw new Error('ADMIN_TOKEN must be set before starting dgateway');
  const clock = options.clock ?? Date.now,
    started = clock();
  const store = new Store(env.DATA_DIR || './data', env);
  // Model catalogs cached by the models endpoint, or fetched once by a chat-wire OpenRouter decision that finds none.
  const catalog = new Map<string, CatalogEntry>();
  const deps: DecideDeps = {
    providers: () => store.providers(),
    routes: () => store.routes(),
    settings: () => store.settings(),
    key: (p) => store.key(p),
    // A chat call reads the model's cached supported_parameters to know whether it may send reasoning settings.
    call: (p, m, r, k, t) =>
      callUpstream(p, m, r, k, t, options.http, supportedParameters(catalog.get(p.id), m)),
    ensureCatalog: (p) => admin.ensureCatalog(p),
    catalogPrice: (p, model) => catalogPrice(catalog.get(p.id), model),
    clock,
    id,
    log: (l) => store.addLog(l),
  };
  const admin = new Admin(store, deps, options.http, catalog);
  const decisions = new PublicDecisions(deps, (key) => store.authenticateClient(key));
  const consoleDir = resolve(env.CONSOLE_DIR || 'src/modules/gateway/apps/console-web/dist');

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      const publicResponse = await publicService(req, url.pathname, decisions);
      if (publicResponse) return publicResponse;
      const adminResponse = await adminService(req, url, admin, decisions, adminToken!, started);
      if (adminResponse) return adminResponse;
      if (
        url.pathname.startsWith('/v1/') ||
        url.pathname === '/healthz' ||
        url.pathname.startsWith('/admin/api')
      )
        throw new GatewayError(404, 'not_found_error', 'Endpoint not found');
      if (req.method !== 'GET')
        throw new GatewayError(404, 'not_found_error', 'Endpoint not found');
      return await serveConsole(url, consoleDir);
    } catch (e) {
      return failure(e);
    }
  }

  return { handler, store, admin, deps, close: () => store.close() };
}

async function serveConsole(url: URL, consoleDir: string): Promise<Response> {
  const index = Bun.file(resolve(consoleDir, 'index.html'));
  if (!(await index.exists()))
    return new Response('<!doctype html><html><body>Console is not built.</body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  let name: string;
  try {
    name = decodeURIComponent(url.pathname);
  } catch {
    return failure(new GatewayError(400, 'invalid_request_error', 'Invalid path'));
  }
  const path = resolve(consoleDir, '.' + name);
  if (path === consoleDir || path.startsWith(consoleDir + sep)) {
    const file = Bun.file(path);
    if (extname(path) && (await file.exists())) return new Response(file);
  }
  return new Response(index, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

if (import.meta.main) {
  try {
    const listen = resolveListen(process.env);
    for (const warning of listen.warnings) console.warn(`warning: ${warning}`);
    const app = createGateway();
    const server = Bun.serve({ hostname: listen.hostname, port: listen.port, fetch: app.handler });
    console.log(`dgateway listening on ${listen.hostname}:${server.port}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
