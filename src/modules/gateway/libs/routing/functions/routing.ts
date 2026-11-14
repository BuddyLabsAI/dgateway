import type { Route, Target } from '../schemas/types';

export function resolveRoute(
  model: string | undefined,
  defaultRoute: string | null,
  routes: Route[],
  providers: { id: string; name: string }[],
): { route: string | null; targets: Target[] } | null {
  const key = model ?? defaultRoute;
  if (!key) return null;
  const split = key.indexOf('::');
  if (split >= 0) {
    const provider = providers.find((p) => p.name === key.slice(0, split));
    const name = key.slice(split + 2);
    return provider && name
      ? { route: null, targets: [{ provider_id: provider.id, model: name }] }
      : null;
  }
  const route = routes.find((r) => r.alias === key && r.enabled);
  return route ? { route: route.alias, targets: route.targets } : null;
}

export const shouldFallback = (
  kind: 'network' | 'timeout' | 'http' | 'invalid' | 'limit',
  status?: number,
) => kind !== 'http' || (status !== 400 && status !== 422);
