// The hash location as React state. Old links (#/routes, #/providers, #/playground, #/logs) are
// rewritten in place to the screens that replaced them; the pure mapping is in domain/navigation.

import { useEffect, useSyncExternalStore } from "react";
import { legacyRedirect, parseHash, type Location } from "../domain/navigation";

export { SCREENS, SCREEN_LABELS, hrefFor, isScreen, parseHash, type Location, type ScreenId } from "../domain/navigation";

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

function snapshot(): string {
  return window.location.hash;
}

export function useLocation(): Location {
  const hash = useSyncExternalStore(subscribe, snapshot, () => "");
  const redirect = legacyRedirect(hash);

  useEffect(() => {
    if (redirect) window.history.replaceState(null, "", redirect);
  }, [redirect]);

  return parseHash(redirect ?? hash);
}

/** Moves to a hash, as a link would. */
export function navigate(hash: string): void {
  window.location.hash = hash;
}
