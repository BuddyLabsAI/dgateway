// The admin token lives in sessionStorage for this tab only. A 401 from the API ends
// the session and returns the user to sign-in with a notice.

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "dgateway.admin-token";

interface SessionState {
  token: string | null;
  notice: string | null;
}

function readStoredToken(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token === null) globalThis.sessionStorage?.removeItem(STORAGE_KEY);
    else globalThis.sessionStorage?.setItem(STORAGE_KEY, token);
  } catch {
    // Storage can be blocked. The session then lasts until a reload.
  }
}

type Listener = () => void;

export interface SessionStore {
  getToken: () => string | null;
  signIn: (token: string) => void;
  signOut: (notice?: string) => void;
  subscribe: (listener: Listener) => () => void;
  snapshot: () => SessionState;
}

export function createSessionStore(initialToken: string | null = readStoredToken()): SessionStore {
  let state: SessionState = { token: initialToken, notice: null };
  const listeners = new Set<Listener>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    getToken: () => state.token,
    signIn(token) {
      state = { token, notice: null };
      writeStoredToken(token);
      emit();
    },
    signOut(notice) {
      state = { token: null, notice: notice ?? null };
      writeStoredToken(null);
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => state,
  };
}

export const session = createSessionStore();

export function useSession(store: SessionStore = session): SessionState {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
